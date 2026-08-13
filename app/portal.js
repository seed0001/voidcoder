// Web portal: a small zero-dependency HTTP panel + SSE event stream for
// remote (e.g. mobile phone) control of VoidCode. Optionally exposed through
// a Cloudflare quick tunnel (cloudflared) so it is reachable from anywhere
// over a public HTTPS URL.
//
// Security model (intentional):
//   - The HTTP server binds to 127.0.0.1 ONLY. Inbound LAN requests are
//     refused; the public path is the Cloudflare tunnel, which connects back
//     to localhost over the loopback interface.
//   - Access requires a random 32-byte token generated per run. The token is
//     exchanged once via POST /api/login, which sets an HttpOnly cookie; every
//     API call and the SSE stream require that cookie. The token is never sent
//     in URLs or logs.
//   - Stopping the portal kills the tunnel and rotates the token, so a leaked
//     token stops working immediately.
//
// The consumer (app/main.js) supplies an "adapter" object:
//   status()          → object (cwd, provider, generating, session, messages…)
//   sendMessage(text) → Promise<{ok,finalText,snapshot} | {error} | {ok,interrupted}>
//   focusList()       → array of focus session status
//   permAnswer(id, answer) → resolve a pending permission prompt
//   stopAgent()       → abort the running generation
//   compact()         → Promise
//   undo()            → string message

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const WEB_DIR = path.join(__dirname, 'portalWeb');

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function findOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of ['', '.exe', '.cmd', '.bat']) {
      const full = path.join(d, name + ext);
      try { if (fs.statSync(full).isFile()) return full; } catch {}
    }
  }
  return null;
}

function findCloudflared(hint) {
  const candidates = [];
  if (hint) candidates.push(hint);
  candidates.push('cloudflared');
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'cloudflared', 'cloudflared.exe'));
  if (os.homedir()) candidates.push(path.join(os.homedir(), '.cloudflared', 'cloudflared.exe'));
  candidates.push('C:\\Program Files (x86)\\cloudflared\\cloudflared.exe');
  candidates.push('C:\\Program Files\\cloudflared\\cloudflared.exe');
  for (const c of candidates) {
    if (c.includes('\\') || c.includes('/')) {
      try { if (fs.statSync(c).isFile()) return c; } catch {}
    } else {
      const onPath = findOnPath(c);
      if (onPath) return onPath;
    }
  }
  return null;
}

class WebPortal {
  constructor() {
    this.server = null;
    this.port = 0;
    this.token = '';
    this.clients = new Set();
    this.heartbeat = null;
    this.adapter = null;
    this.tunnel = null;          // { proc, url }
    this.tunnelStatus = 'idle';  // idle | ready | failed
    this.tunnelError = '';
    this.running = false;
    this.onLog = null;
  }

  _log(msg) { try { this.onLog?.(msg); } catch {} }

  // ------------------------------------------------------------ lifecycle

  async start({ port = 8777, adapter = {}, tunnel = 'off', cloudflaredPath = '' } = {}) {
    if (this.running) {
      return { ok: true, alreadyRunning: true, ...this.status(), warning: '' };
    }
    this.adapter = adapter;
    this.token = crypto.randomBytes(24).toString('base64url');
    this.clients = new Set();
    this.tunnel = null;
    this.tunnelStatus = 'idle';
    this.tunnelError = '';

    this.server = http.createServer((req, res) => this._route(req, res));
    try {
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(port, '127.0.0.1', () => resolve());
      });
    } catch (err) {
      this.server = null;
      this.token = '';
      throw new Error(`portal failed to bind port ${port}: ${err.message}`);
    }

    this.port = this.server.address().port;
    this.running = true;
    this.heartbeat = setInterval(() => this._pingClients(), 25000);
    if (this.heartbeat.unref) this.heartbeat.unref();
    this._log(`portal listening on http://127.0.0.1:${this.port}`);

    let url = null;
    let warning = '';
    if (tunnel === 'cloudflared') {
      const t = await this._startCloudflared(cloudflaredPath, this.port);
      if (t.ok) { this.tunnel = { proc: t.proc, url: t.url }; this.tunnelStatus = 'ready'; url = t.url; }
      else { this.tunnelStatus = 'failed'; this.tunnelError = t.error; warning = t.error; this._log(`cloudflared: ${t.error}`); }
    }

    return { ok: true, port: this.port, token: this.token, url, localUrl: `http://127.0.0.1:${this.port}`, tunnel: this.tunnelStatus, warning, tunnelError: this.tunnelError };
  }

  stop() {
    const wasRunning = this.running;
    this.running = false;
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    for (const c of this.clients) { try { c.end(); } catch {} }
    this.clients.clear();
    if (this.tunnel?.proc) { try { this.tunnel.proc.kill(); } catch {} }
    this.tunnel = null;
    this.tunnelStatus = 'idle';
    this.tunnelError = '';
    this.token = '';
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
    if (wasRunning) this._log('portal stopped');
    return { ok: true };
  }

  status() {
    return {
      running: this.running,
      port: this.port,
      token: this.running ? this.token : '',
      url: this.tunnel?.url || null,
      localUrl: this.running ? `http://127.0.0.1:${this.port}` : null,
      tunnel: this.tunnelStatus,
      tunnelError: this.tunnelError,
    };
  }

  emit(channel, payload) {
    if (!this.running) return;
    const data = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const c of this.clients) {
      try { c.write(data); } catch { this.clients.delete(c); }
    }
  }

  _pingClients() {
    for (const c of this.clients) {
      try { c.write(': keepalive\n\n'); } catch { this.clients.delete(c); }
    }
  }

  _startCloudflared(cloudflaredPath, port) {
    return new Promise((resolve) => {
      const bin = findCloudflared(cloudflaredPath);
      if (!bin) {
        return resolve({
          ok: false,
          error: 'cloudflared was not found. Install it with:  winget install cloudflared   (or download from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/). Then start the portal again.',
        });
      }
      this._log(`starting cloudflared: ${bin} tunnel --url http://127.0.0.1:${port}`);
      let proc;
      try {
        proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        return resolve({ ok: false, error: `cloudflared failed to launch: ${err.message}` });
      }

      let output = '';
      let settled = false;
      const settleOnce = (val) => { if (!settled) { settled = true; resolve(val); } };

      const grab = (chunk) => {
        output += chunk.toString();
        if (output.length > 20000) output = output.slice(-20000);
        const m = output.match(TUNNEL_URL_RE);
        if (m) {
          this._log(`tunnel ready: ${m[0]}`);
          settleOnce({ ok: true, proc, url: m[0] });
        } else {
          const last = output.split('\n').filter(Boolean).slice(-2).join(' | ');
          if (last) this._log(`cloudflared: ${last}`);
        }
      };
      proc.stdout.on('data', grab);
      proc.stderr.on('data', grab);
      proc.on('error', (err) => settleOnce({ ok: false, error: `cloudflared failed to launch: ${err.message}` }));
      proc.on('exit', (code) => {
        if (!settled) settleOnce({ ok: false, error: `cloudflared exited (code ${code}). ${output.slice(-300)}` });
      });
      setTimeout(() => {
        settleOnce({ ok: false, error: 'timed out waiting for the tunnel URL (25s). Check cloudflared is installed, can reach the network, and that the firewall allows it.' });
      }, 25000);
    });
  }

  // ------------------------------------------------------------ HTTP plumbing

  _json(res, obj, status = 200) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  _body(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 1e6) { req.destroy(); resolve({}); } });
      req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
      req.on('error', () => resolve({}));
    });
  }

  _cookie(req, name) {
    const h = req.headers.cookie || '';
    for (const part of h.split(';')) {
      const s = part.trim();
      if (s.startsWith(name + '=')) {
        try { return decodeURIComponent(s.slice(name.length + 1)); } catch { return null; }
      }
    }
    return null;
  }

  _hasSession(req) {
    const c = this._cookie(req, 'vc');
    if (!c) return false;
    const a = Buffer.from(String(c));
    const b = Buffer.from(this.token);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  _setSession(res) {
    res.setHeader('Set-Cookie', `vc=${encodeURIComponent(this.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
  }

  _sse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
    this._pingClients();
  }

  // ------------------------------------------------------------ routes

  _route(req, res) {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch { this._json(res, { error: 'bad request' }, 400); return; }
    const p = url.pathname;
    const method = req.method || 'GET';

    const authed = () => this._hasSession(req);
    const deny = () => this._json(res, { error: 'unauthorized' }, 401);

    // ---- auth
    if (p === '/api/login' && method === 'POST') {
      this._body(req).then((b) => {
        const tok = String(b.token || '');
        const a = Buffer.from(tok);
        const bb = Buffer.from(this.token);
        const ok = a.length === bb.length && crypto.timingSafeEqual(a, bb);
        if (!ok) { this._json(res, { error: 'invalid access token' }, 401); return; }
        this._setSession(res);
        this._json(res, { ok: true });
      });
      return;
    }

    if (p === '/api/logout') {
      res.setHeader('Set-Cookie', 'vc=; Path=/; HttpOnly; Max-Age=0');
      this._json(res, { ok: true });
      return;
    }

    if (p === '/api/events') {
      if (!authed()) { deny(); return; }
      this._sse(req, res);
      return;
    }

    // ---- authed JSON APIs
    if (method === 'GET' && p === '/api/status') {
      if (!authed()) { deny(); return; }
      const base = (this.adapter.status && this.adapter.status()) || {};
      this._json(res, { ...this.status(), ...base, portal: this.status() });
      return;
    }
    if (method === 'GET' && p === '/api/focus') {
      if (!authed()) { deny(); return; }
      const list = (this.adapter.focusList && this.adapter.focusList()) || [];
      this._json(res, list);
      return;
    }
    if (method === 'POST' && p === '/api/focus/answer') {
      if (!authed()) { deny(); return; }
      this._body(req).then((b) => {
        const r = this.adapter.focusAnswer && this.adapter.focusAnswer(b.id, b.answer);
        Promise.resolve(r)
          .then(() => this._json(res, { ok: true }))
          .catch((err) => this._json(res, { error: err.message }, 500));
      });
      return;
    }
    if (method === 'POST' && p === '/api/chat') {
      if (!authed()) { deny(); return; }
      this._body(req).then((b) => this._handleChat(res, b));
      return;
    }
    if (method === 'POST' && p === '/api/perm') {
      if (!authed()) { deny(); return; }
      this._body(req).then((b) => {
        this.adapter.permAnswer?.(b.id, b.answer);
        this._json(res, { ok: true });
      });
      return;
    }
    if (method === 'POST' && p === '/api/stop') {
      if (!authed()) { deny(); return; }
      this.adapter.stopAgent?.();
      this._json(res, { ok: true });
      return;
    }
    if (method === 'POST' && p === '/api/compact') {
      if (!authed()) { deny(); return; }
      const r = this.adapter.compact && this.adapter.compact();
      Promise.resolve(r)
        .then(() => this._json(res, { ok: true }))
        .catch((err) => this._json(res, { ok: false, error: err.message }, 500));
      return;
    }
    if (method === 'POST' && p === '/api/undo') {
      if (!authed()) { deny(); return; }
      const msg = (this.adapter.undo && this.adapter.undo()) || 'nothing to undo';
      this._json(res, { ok: true, message: msg });
      return;
    }

    if (method === 'GET' && (p === '/' || p.startsWith('/portal'))) {
      this._static(p === '/' ? 'index.html' : p.replace('/portal/', ''), res);
      return;
    }

    this._json(res, { error: 'not found' }, 404);
  }

  _handleChat(res, body) {
    const text = String(body.text || '').trim();
    if (!text) { this._json(res, { error: 'empty message' }, 400); return; }
    try {
      const r = this.adapter.sendMessage(text);
      Promise.resolve(r)
        .then((out) => this._json(res, out || { ok: true }))
        .catch((err) => this._json(res, { error: err.message }, 500));
    } catch (err) {
      this._json(res, { error: err.message }, 500);
    }
  }

  _static(rel, res) {
    const file = path.normalize(path.join(WEB_DIR, rel));
    if (!file.startsWith(WEB_DIR + path.sep) && file !== WEB_DIR) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    let stat;
    try { stat = fs.statSync(file); } catch { res.writeHead(404); res.end('not found'); return; }
    if (stat.isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };
    res.writeHead(200, {
      'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  }
}

module.exports = new WebPortal();