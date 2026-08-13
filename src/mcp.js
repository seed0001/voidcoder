// Minimal MCP (Model Context Protocol) client over stdio.
// Config: mcpServers: { name: { command, args: [], env: {} } }
// Each server's tools are exposed to the model as mcp_<server>_<tool>.

const { spawn } = require('child_process');

class McpServer {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.tools = [];
    this.buffer = '';
    this.ready = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      try {
        this.proc = spawn(this.spec.command, this.spec.args || [], {
          env: { ...process.env, ...(this.spec.env || {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: process.platform === 'win32', // lets "npx foo" style commands work
        });
      } catch (err) {
        return reject(err);
      }
      this.proc.on('error', (err) => reject(err));
      this.proc.stdout.on('data', (d) => this._onData(d));
      this.proc.stderr.on('data', () => { /* servers log freely; ignore */ });
      this.proc.on('exit', () => {
        for (const [, p] of this.pending) p.reject(new Error(`MCP server ${this.name} exited`));
        this.pending.clear();
        this.ready = false;
      });

      const timeout = setTimeout(() => reject(new Error(`MCP server ${this.name}: initialize timed out (15s)`)), 15000);
      this._request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'voidcode', version: '0.1.0' },
      }).then(async () => {
        this._notify('notifications/initialized', {});
        const res = await this._request('tools/list', {});
        this.tools = res.tools || [];
        this.ready = true;
        clearTimeout(timeout);
        resolve(this.tools);
      }).catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  _onData(data) {
    this.buffer += data.toString();
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }

  _request(method, params) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP ${this.name}.${method} timed out (60s)`));
        }
      }, 60000);
    });
  }

  _notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async callTool(toolName, args) {
    const result = await this._request('tools/call', { name: toolName, arguments: args });
    const parts = (result.content || []).map((c) => {
      if (c.type === 'text') return c.text;
      return `[${c.type} content]`;
    });
    const text = parts.join('\n');
    if (result.isError) throw new Error(text || 'MCP tool error');
    return text || '(empty result)';
  }

  stop() {
    try { this.proc?.kill(); } catch { }
  }
}

// Start all configured servers; failures are collected, not fatal.
async function startServers(mcpConfig) {
  const servers = [];
  const errors = [];
  for (const [name, spec] of Object.entries(mcpConfig || {})) {
    if (!spec || !spec.command) continue;
    const server = new McpServer(name, spec);
    try {
      await server.start();
      servers.push(server);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
      server.stop();
    }
  }
  return { servers, errors };
}

// OpenAI-format tool defs for all MCP tools, prefixed to avoid collisions.
function toolDefs(servers) {
  const defs = [];
  for (const s of servers) {
    for (const t of s.tools) {
      defs.push({
        name: `mcp_${s.name}_${t.name}`,
        description: `[MCP:${s.name}] ${t.description || t.name}`.slice(0, 1000),
        parameters: t.inputSchema || { type: 'object', properties: {} },
        _mcp: { server: s, tool: t.name },
      });
    }
  }
  return defs;
}

module.exports = { startServers, toolDefs, McpServer };
