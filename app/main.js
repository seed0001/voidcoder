// VoidCode Desktop — Electron main process.
// Same engine as the terminal (src/*): agent loop, tools, sessions,
// permissions, MCP. This file is only wiring + window.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Fatal errors from the main process land in ~/.voidcode/electron-debug.log —
// a windowed app has no console, so without this a startup crash is invisible.
const debugLog = (() => {
  const logPath = path.join(os.homedir(), '.voidcode', 'electron-debug.log');
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
  try { fs.writeFileSync(logPath, ''); } catch {}
  return (msg) => { try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`); } catch {} };
})();

// Fix: move Electron's cache into VoidCode's own directory so stale/corrupt
// Chromium cache directories under %LOCALAPPDATA% don't cause "Unable to move
// the cache: Access denied" on startup.
const vcDataDir = path.join(os.homedir(), '.voidcode', 'electron-data');
const cacheDir = path.join(vcDataDir, 'Cache');
app.setPath('userData', vcDataDir);
try { fs.mkdirSync(cacheDir, { recursive: true }); } catch {}
app.setPath('cache', cacheDir);

// Disable GPU cache entirely — we're a text editor, we don't need it, and
// it's the thing triggering `disk_cache.cc Gpu Cache Creation failed: -2`.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-program-cache');
app.commandLine.appendSwitch('disk-cache-size', '0');

const config = require('../src/config');
const { Agent, estTokens } = require('../src/agent');
const { Session } = require('../src/sessions');
const { Permissions } = require('../src/permissions');
const mcp = require('../src/mcp');
const voice = require('./voice');
const { Scheduler } = require('../src/scheduler');
const schedule = require('../src/schedule');
const costTracker = require('../src/costTracker');
const portal = require('./portal');
const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

let win = null;
let cfg = null;
let cwd = null;              // active working folder (project)
let session = null;
let agent = null;
let mcpServers = [];
let mcpErrors = [];
let generating = false;
let permSeq = 0;
let scheduler = null;
const pendingPerms = new Map(); // id -> resolve('y'|'a'|'n')

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  portal.emit(channel, payload);
}

// ---------------------------------------------------------------- auto-updates

autoUpdater.on('checking-for-update', () => send('updates:status', { state: 'checking' }));
autoUpdater.on('update-available', (info) => send('updates:status', { state: 'available', version: info.version }));
autoUpdater.on('update-not-available', () => send('updates:status', { state: 'not-available' }));
autoUpdater.on('download-progress', (p) => send('updates:status', { state: 'downloading', percent: Math.round(p.percent) }));
autoUpdater.on('update-downloaded', (info) => send('updates:status', { state: 'downloaded', version: info.version }));
autoUpdater.on('error', (err) => send('updates:status', { state: 'error', message: err?.message || String(err) }));

// ---------------------------------------------------------------- engine wiring

function agentEvents() {
  return {
    onDelta: (t) => send('agent:delta', t),
    onReasoningDelta: (t) => send('agent:reasoningDelta', t),
    onToolStart: (name, args) => send('agent:toolStart', { name, args }),
    onToolEnd: (name, args, ok, output) => send('agent:toolEnd', { name, args, ok, output: String(output).slice(0, 4000) }),
    onFileChange: (file, before, after) => send('agent:fileChange', { file, before, after }),
    onTodos: (todos) => send('agent:todos', todos),
    onStatus: (s) => send('agent:status', s),
    onContextTrace: (trace) => send('agent:contextTrace', trace),
    onSubagentStart: (desc) => send('agent:subagentStart', desc),
    onSubagentEnd: (desc, result) => send('agent:subagentEnd', { desc, result: String(result).slice(0, 2000) }),
    onFocusStart: (session) => send('agent:focusStart', session?.getStatus ? session.getStatus() : session),
    onFocusQuestion: (session, question) => send('agent:focusQuestion', { session: session?.getStatus ? session.getStatus() : session, question }),
    onFocusDone: (session, status, report) => send('agent:focusDone', { session: session?.getStatus ? session.getStatus() : session, status, report }),
    onFocusLog: (session, entry) => send('agent:focusLog', { session: session?.getStatus ? session.getStatus() : session, entry }),
    onFocusResume: (session) => send('agent:focusResume', session?.getStatus ? session.getStatus() : session),
  };
}

function buildAgent() {
  const provider = config.resolveProvider(cfg);
  const permissions = new Permissions(cfg, (question, meta) => {
    // GUI prompt: send structured request, await renderer's answer
    return new Promise((resolve) => {
      const id = ++permSeq;
      pendingPerms.set(id, resolve);
      send('perm:ask', { id, ...meta });
    });
  });
  agent = new Agent({ cfg, provider, session, permissions, mcpServers, events: agentEvents(), cwd });
  return provider;
}

// Runs one chat turn end-to-end. Shared by the desktop IPC handler and the
// web portal adapter so both apps negotiate the same "generating" guard.
function runChat(input) {
  if (generating) return Promise.resolve({ error: 'already generating' });
  generating = true;
  send('agent:turnStart', {});
  return agent.send(input)
    .then((finalText) => ({ ok: true, finalText, snapshot: snapshot() }))
    .catch((err) => {
      const aborted = err.name === 'AbortError';
      return aborted ? { ok: true, finalText: '', interrupted: true, snapshot: snapshot() } : { error: err.message };
    })
    .finally(() => {
      generating = false;
      for (const [id, resolve] of pendingPerms) resolve('n');
      pendingPerms.clear();
      send('agent:turnEnd', {});
    });
}

// Lightweight status for the portal (no session history — just enough for
// the mobile header and generating indicator).
function portalStatusLight() {
  let provider = null;
  try { const p = config.resolveProvider(cfg); provider = { name: p.name, model: p.model }; } catch {}
  return {
    cwd,
    generating,
    provider,
    session: session ? { title: session.title } : null,
  };
}

// Adapter the web portal uses to reach the running engine. Kept lazy so a
// portal start from app.ready works before everything settles.
function portalAdapter() {
  return {
    status: portalStatusLight,
    sendMessage: async (text) => {
      const r = await runChat(text);
      if (r && r.snapshot) delete r.snapshot; // don't push the full snapshot over the portal
      return r;
    },
    focusList: () => (agent?.focus?.list ? agent.focus.list() : []),
    focusAnswer: (id, answer) => (agent?.focus?.answer ? agent.focus.answer(id, answer) : { ok: false, error: 'Focus not available' }),
    permAnswer: (id, answer) => {
      const resolve = pendingPerms.get(id);
      if (resolve) { pendingPerms.delete(id); resolve(answer); }
    },
    stopAgent: () => agent?.stop(),
    compact: () => agent.compact(),
    undo: () => session.undoLast(),
  };
}

async function startPortal(opts) {
  const res = await portal.start({ ...opts, adapter: portalAdapter() });
  if (res.ok) send('portal:status', portal.status());
  return res;
}

async function setWorkingFolder(folder) {
  cwd = folder;
  config.saveGlobal({ appState: { lastCwd: folder } });
  cfg = config.load(cwd);
  session = new Session(cwd);
  const provider = buildAgent();
  return snapshot(provider);
}

function displayMessages() {
  // strip tool plumbing for the UI; renderer re-renders history on session switch
  return (session?.messages || [])
    .filter((m) => (m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('[')) ||
                   (m.role === 'assistant' && typeof m.content === 'string' && m.content))
    .map((m) => ({ role: m.role, content: m.content }));
}

function snapshot(provider) {
  provider = provider || config.resolveProvider(cfg);
  return {
    cwd,
    home: os.homedir(),
    projects: cfg.appState?.projects || [],
    provider: { name: provider.name, model: provider.model, hasKey: !!provider.apiKey },
    session: session ? { id: session.id, title: session.title, usage: session.usage } : null,
    projectCost: costTracker.load(cwd),
    sessions: Session.list(cwd).slice(0, 50),
    messages: displayMessages(),
    contextTokens: estTokens(session?.messages || []),
    mcp: { servers: mcpServers.map((s) => ({ name: s.name, tools: s.tools.length })), errors: mcpErrors },
    settings: {
      provider: cfg.provider,
      model: cfg.model,
      persona: cfg.persona || '',
      memory: cfg.memory || '',
      ui: {
        theme: (cfg.ui && cfg.ui.theme) || 'void',
        pacer: cfg.ui ? cfg.ui.pacer !== false : true,
      },
      webPortal: {
        enabled: !!(cfg.webPortal && cfg.webPortal.enabled),
        tunnel: (cfg.webPortal && cfg.webPortal.tunnel) || 'off',
        port: (cfg.webPortal && cfg.webPortal.port) || 8777,
        cloudflaredPath: (cfg.webPortal && cfg.webPortal.cloudflaredPath) || '',
        running: portal.running,
        url: portal.tunnel?.url || null,
        tunnelStatus: portal.tunnelStatus,
        tunnelError: portal.tunnelError || '',
      },
      updates: {
        autoCheck: !!(cfg.updates && cfg.updates.autoCheck),
        currentVersion: app.getVersion(),
      },
      providers: Object.fromEntries(Object.entries(cfg.providers).map(([n, p]) => [n, {
        baseUrl: p.baseUrl,
        hasKey: !!(p.apiKey || (p.apiKeyEnv && process.env[p.apiKeyEnv])),
      }])),
      integrations: {
        githubHasToken: !!(cfg.integrations?.githubToken || process.env.GITHUB_TOKEN),
        railwayHasToken: !!(cfg.integrations?.railwayToken || process.env.RAILWAY_TOKEN),
      },
      permissions: cfg.permissions,
      bashAllow: cfg.bashAllow,
      voice: {
        autoSpeak: cfg.voice.autoSpeak,
        handsFree: cfg.voice.handsFree,
        stt: { baseUrl: cfg.voice.stt.baseUrl, model: cfg.voice.stt.model, hasKey: !!cfg.voice.stt.apiKey },
        tts: {
          backend: cfg.voice.tts.backend,
          edgeVoice: cfg.voice.tts.edge.voice,
          fishHasKey: !!cfg.voice.tts.fish.apiKey,
          fishVoiceId: cfg.voice.tts.fish.voiceId,
        },
      },
    },
  };
}

// ---------------------------------------------------------------- window

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0a0a0a',
    title: 'VoidCode',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.on('render-process-gone', (e, wc, details) => {
  debugLog('RENDERER GONE: reason=' + details.reason + ' exitCode=' + details.exitCode);
});
process.on('uncaughtException', (e) => {
  debugLog('UNCAUGHT: ' + (e?.stack || e));
});
app.whenReady().then(async () => {
  cfg = config.load();
  cwd = cfg.appState?.lastCwd && fs.existsSync(cfg.appState.lastCwd) ? cfg.appState.lastCwd : os.homedir();
  cfg = config.load(cwd);
  voice.init(() => cfg);
  ({ servers: mcpServers, errors: mcpErrors } = await mcp.startServers(cfg.mcpServers));
  session = new Session(cwd);
  buildAgent();

  // ---- web portal (optional mobile remote control) ----
  portal.onLog = (m) => send('portal:log', m);
  if (cfg.webPortal && cfg.webPortal.enabled) {
    try {
      await startPortal({
        port: cfg.webPortal.port || 8777,
        tunnel: cfg.webPortal.tunnel || 'off',
        cloudflaredPath: cfg.webPortal.cloudflaredPath || '',
      });
    } catch (err) {
      console.log(`portal autostart failed: ${err.message}`);
    }
  }

  // ---- auto-updates (opt-in) ----
  if (cfg.updates && cfg.updates.autoCheck) {
    autoUpdater.checkForUpdates().catch((err) => console.log(`update check failed: ${err.message}`));
  }

  // ---- scheduler (background tasks) ----
  const scheduledTasks = schedule.listTasks().filter((t) => t.enabled);
  if (scheduledTasks.length > 0) {
    scheduler = new Scheduler({
      runTask: async (task) => {
        const prevLevel = cfg.autonomyLevel;
        cfg.autonomyLevel = task.autonomyLevel || 'safe';
        try {
          send('agent:status', `scheduled: ${task.title}`);
          const result = await agent.send(task.prompt, { autonomous: true });
          send('agent:status', `done: ${task.title}`);
          // Speak completion if voice is enabled
          if (cfg.voice?.autoSpeak) {
            voice.synthesize(`Scheduled task "${task.title}" completed`).catch(() => {});
          }
          return result || '(no output)';
        } catch (err) {
          return `ERROR: ${err.message}`;
        } finally {
          cfg.autonomyLevel = prevLevel;
        }
      },
      onComplete: (task, result) => {
        const isError = result && typeof result === 'string' && result.startsWith('ERROR');
        send('agent:todos', [{ content: `Scheduled task: ${task.title}`, status: isError ? 'pending' : 'completed' }]);
        if (isError && cfg.voice?.autoSpeak) {
          voice.synthesize(`Task "${task.title}" failed. ${result.slice(0, 100)}`).catch(() => {});
        }
      },
    });
    scheduler.start();
  }

  createWindow();
}).catch((err) => {
  debugLog('FATAL APP ERROR: ' + (err?.stack || err));
  console.error('FATAL:', err?.stack || err);
  app.quit();
});

app.on('window-all-closed', () => {
  if (scheduler) scheduler.stop();
  for (const s of mcpServers) s.stop();
  portal.stop();
  app.quit();
});

// ---------------------------------------------------------------- IPC

ipcMain.handle('app:init', () => snapshot());

ipcMain.handle('app:chooseFolder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: cwd });
  if (res.canceled || !res.filePaths[0]) return null;
  return setWorkingFolder(res.filePaths[0]);
});

ipcMain.handle('app:openPath', (e, p) => shell.showItemInFolder(p));

// ---------------------------------------------------------------- desktop shell projects

ipcMain.handle('project:add', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: cwd });
  if (res.canceled || !res.filePaths[0]) return null;
  const folder = res.filePaths[0];
  const projects = cfg.appState.projects || [];
  if (!projects.some((p) => p.path === folder)) {
    const n = projects.length;
    projects.push({
      id: crypto.randomUUID(),
      name: path.basename(folder) || folder,
      path: folder,
      x: 32 + (n % 6) * 104,
      y: 32 + Math.floor(n / 6) * 104,
    });
    config.saveGlobal({ appState: { projects } });
    cfg = config.load(cwd);
  }
  return snapshot();
});

ipcMain.handle('project:remove', (e, id) => {
  const projects = (cfg.appState.projects || []).filter((p) => p.id !== id);
  config.saveGlobal({ appState: { projects } });
  cfg = config.load(cwd);
  return snapshot();
});

ipcMain.handle('project:move', (e, { id, x, y }) => {
  const projects = (cfg.appState.projects || []).map((p) => (p.id === id ? { ...p, x, y } : p));
  config.saveGlobal({ appState: { projects } });
  cfg = config.load(cwd);
});

ipcMain.handle('project:open', async (e, id) => {
  const proj = (cfg.appState.projects || []).find((p) => p.id === id);
  if (!proj || !fs.existsSync(proj.path)) return snapshot();
  return setWorkingFolder(proj.path);
});

ipcMain.handle('chat:send', (e, input) => runChat(input));

ipcMain.handle('chat:stop', () => { agent?.stop(); });

ipcMain.handle('chat:compact', async () => {
  try { const did = await agent.compact(); return { ok: did }; }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('chat:undo', () => {
  const msg = session.undoLast();
  return { message: msg || 'nothing to undo' };
});

ipcMain.handle('perm:answer', (e, { id, answer }) => {
  const resolve = pendingPerms.get(id);
  if (resolve) { pendingPerms.delete(id); resolve(answer); }
});

ipcMain.handle('session:new', () => {
  session.save();
  session = new Session(cwd);
  buildAgent();
  return snapshot();
});

ipcMain.handle('session:delete', (e, id) => {
  Session.delete(cwd, id);
  if (session && session.id === id) {
    session = new Session(cwd);
    buildAgent();
  }
  return snapshot();
});

ipcMain.handle('session:load', (e, id) => {
  session.save();
  session = Session.load(cwd, id);
  buildAgent();
  return snapshot();
});

ipcMain.handle('session:changes', () => {
  // review panel data: unique files with original + current content
  const files = [];
  const seen = new Set();
  for (const b of session.fileBackups) {
    if (seen.has(b.file)) continue;
    seen.add(b.file);
    let current = null;
    try { current = fs.readFileSync(b.file, 'utf8'); } catch { }
    files.push({ file: b.file, before: b.before, after: current });
  }
  return files;
});

ipcMain.handle('settings:save', (e, patch) => {
  config.saveGlobal(patch);
  cfg = config.load(cwd);
  buildAgent();
  return snapshot();
});

ipcMain.handle('settings:setModel', (e, modelStr) => {
  const provider = config.resolveProvider(cfg, modelStr); // throws on bad provider
  config.saveGlobal({ provider: provider.name, model: provider.model });
  cfg = config.load(cwd);
  buildAgent();
  return snapshot();
});

ipcMain.handle('updates:check', () => autoUpdater.checkForUpdates().catch((err) => send('updates:status', { state: 'error', message: err.message })));
ipcMain.handle('updates:download', () => autoUpdater.downloadUpdate().catch((err) => send('updates:status', { state: 'error', message: err.message })));
ipcMain.handle('updates:install', () => autoUpdater.quitAndInstall());

ipcMain.handle('models:list', async () => {
  // Live model discovery: installed Ollama models, the GGUF loaded in
  // llama.cpp server, and OpenRouter's catalog. Short timeouts; absent
  // backends just return empty.
  const tryFetch = async (url, opts = {}, ms = 2500) => {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  const out = { ollama: [], llamacpp: [], openrouter: [] };

  const olBase = (cfg.providers.ollama?.baseUrl || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '');
  const ol = await tryFetch(olBase + '/api/tags');
  if (ol?.models) out.ollama = ol.models.map((m) => m.name);

  const lcBase = (cfg.providers.llamacpp?.baseUrl || 'http://localhost:8080/v1').replace(/\/+$/, '');
  const lc = await tryFetch(lcBase + '/models');
  if (lc?.data) out.llamacpp = lc.data.map((m) => String(m.id).split(/[\\/]/).pop());

  const orp = cfg.providers.openrouter || {};
  const orKey = orp.apiKey || (orp.apiKeyEnv ? process.env[orp.apiKeyEnv] : '') || '';
  const or = await tryFetch('https://openrouter.ai/api/v1/models',
    orKey ? { headers: { Authorization: `Bearer ${orKey}` } } : {}, 6000);
  if (or?.data) out.openrouter = or.data.map((m) => m.id).sort();

  return out;
});

ipcMain.handle('voice:transcribe', async (e, { buffer, mimeType }) => {
  return voice.transcribe(Buffer.from(buffer), mimeType);
});

ipcMain.handle('voice:speak', async (e, text) => {
  return voice.synthesize(text);
});

// ---------------------------------------------------------------- schedule IPC

ipcMain.handle('schedule:list', () => {
  return schedule.listTasks();
});

ipcMain.handle('schedule:add', (e, { title, prompt, cron, interval, autonomyLevel }) => {
  const task = schedule.addTask({ title, prompt, cron, interval, autonomyLevel });
  // If scheduler is running, it will pick this up on the next tick
  return schedule.listTasks();
});

ipcMain.handle('schedule:update', (e, { id, patch }) => {
  schedule.updateTask(id, patch);
  return schedule.listTasks();
});

ipcMain.handle('schedule:toggle', (e, { id, enabled }) => {
  schedule.updateTask(id, { enabled });
  return schedule.listTasks();
});

ipcMain.handle('schedule:remove', (e, id) => {
  schedule.removeTask(id);
  return schedule.listTasks();
});

ipcMain.handle('schedule:status', () => {
  if (!scheduler) return { running: false, activeTaskId: null };
  return scheduler.getStatus();
});

// ---------------------------------------------------------------- focus IPC

ipcMain.handle('focus:list', () => {
  if (!agent?.focus) return [];
  return agent.focus.list();
});

ipcMain.handle('focus:answer', (e, { id, answer }) => {
  if (!agent?.focus) return { ok: false, error: 'Focus not available' };
  return agent.focus.answer(id, answer);
});

ipcMain.handle('focus:cancel', (e, { id }) => {
  if (!agent?.focus) return { ok: false, error: 'Focus not available' };
  return agent.focus.cancel(id);
});

// ---------------------------------------------------------------- portal IPC

ipcMain.handle('portal:start', async (e, opts = {}) => {
  const tunnel = opts.tunnel || (cfg.webPortal && cfg.webPortal.tunnel) || 'off';
  const port = opts.port || (cfg.webPortal && cfg.webPortal.port) || 8777;
  const cloudflaredPath = opts.cloudflaredPath || (cfg.webPortal && cfg.webPortal.cloudflaredPath) || '';
  try {
    const res = await startPortal({ port, tunnel, cloudflaredPath });
    if (res.ok) {
      config.saveGlobal({ webPortal: { enabled: true, port, tunnel, cloudflaredPath } });
      cfg = config.load(cwd);
    }
    return res;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('portal:stop', () => {
  portal.stop();
  config.saveGlobal({
    webPortal: {
      enabled: false,
      port: (cfg.webPortal && cfg.webPortal.port) || 8777,
      tunnel: (cfg.webPortal && cfg.webPortal.tunnel) || 'off',
      cloudflaredPath: (cfg.webPortal && cfg.webPortal.cloudflaredPath) || '',
    },
  });
  cfg = config.load(cwd);
  return portal.status();
});

ipcMain.handle('portal:status', () => portal.status());

// ---------------------------------------------------------------- model IPC

const { discoverModels } = require('../src/modelCatalog');
const { AgentRoles } = require('../src/agentRoles');

ipcMain.handle('model:list', async () => discoverModels(cfg, cwd));

ipcMain.handle('model:set', async (e, { modelId }) => {
  if (!agent) return { ok: false, error: 'Agent not initialized' };
  const res = await agent.setModel(modelId);
  if (res?.ok) {
    // Persist the refresh in-memory config so the next snapshot matches.
    try {
      cfg = config.load(cwd);
      buildAgent();
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }
  return res;
});

ipcMain.handle('agent:structure', () => {
  if (!agent) return null;
  try {
    const roles = agent.roles || new AgentRoles(cwd);
    const p = agent.provider;
    const focusAgents = {};
    const focusList = agent.focus?.list ? agent.focus.list() : [];
    for (const s of focusList) focusAgents[s.id] = { model: s.model || null, role: s.role || 'focus', status: s.status };
    return roles.structure({ main: `${p.name}/${p.model}`, agents: focusAgents });
  } catch {
    return null;
  }
});

ipcMain.handle('cost:summary', () => costTracker.load(cwd));

ipcMain.handle('cost:rebuild', () => {
  const r = costTracker.rebuildFromSessions(cwd);
  return r;
});
