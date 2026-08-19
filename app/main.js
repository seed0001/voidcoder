// VoidCode Desktop — Electron main process.
// Same engine as the terminal (src/*): agent loop, tools, sessions,
// permissions, MCP. This file is only wiring + window.

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
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

// ---------------------------------------------------------------- corner media player
// Serve the user's own local music files to the renderer over a custom
// `mediafile://` scheme so they stream under the app's strict CSP. Nothing is
// ever written or executed: we only read audio files from disk.
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.oga', '.wav', '.m4a', '.aac', '.flac', '.opus', '.webm']);

function isAudioFile(p) {
  return AUDIO_EXTS.has((path.extname(p) || '').toLowerCase());
}

let mediaFolder = null;              // currently imported music folder (absolute)

// Recursively collect playable audio files under a folder (no symlinks, bounded).
function scanAudioFolder(root, limit = 5000) {
  const out = [];
  const seen = new Set();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, ent.name);
      try { const st = fs.statSync(full); if (st.isSymbolicLink()) continue; } catch { continue; }
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && isAudioFile(ent.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

// Register the custom scheme as privileged BEFORE the app is ready (required).
// The matching handler is installed in whenReady via protocol.handle().
protocol.registerSchemesAsPrivileged([
  { scheme: 'mediafile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const registerMediaProtocol = () => {
  // handler uses net.fetch for reliability + range support (seeking)
  protocol.handle('mediafile', (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'local') return new Response('forbidden', { status: 403 });
      const file = path.normalize(decodeURIComponent(url.pathname).replace(/^\/+/, ''));
      if (!mediaFolder) return new Response('no folder', { status: 404 });
      // containment check: only serve inside the imported music folder
      const relCheck = path.relative(mediaFolder, file);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return new Response('forbidden', { status: 403 });
      if (!isAudioFile(file)) return new Response('forbidden', { status: 403 });
      try { if (!fs.existsSync(file)) return new Response('not found', { status: 404 }); } catch { return new Response('error', { status: 500 }); }
      return net.fetch('file://' + file.replace(/\\/g, '/'));
    } catch (err) {
      return new Response('bad request', { status: 400 });
    }
  });
};

const config = require('../src/config');
const { Agent, estTokens } = require('../src/agent');
const { Session } = require('../src/sessions');
const { Permissions } = require('../src/permissions');
const mcp = require('../src/mcp');
const voice = require('./voice');
const { Scheduler } = require('../src/scheduler');
const schedule = require('../src/schedule');
const costTracker = require('../src/costTracker');
const { createContextService } = require('../src/contextDb');
const { indexContainer } = require('../src/containerIndexer');
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
    containers: cfg.appState?.containers || [],
    // Which container (if any) is the currently open session scoped to —
    // lets the renderer show the ref-list/reindex management strip only
    // when you've actually opened a container, not a plain project.
    activeContainer: cfg.activeTopicId
      ? (cfg.appState?.containers || []).find((c) => c.topicId === cfg.activeTopicId) || null
      : null,
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
        tavilyHasToken: !!(cfg.integrations?.tavilyApiKey || process.env[cfg.integrations?.tavilyApiKeyEnv || 'TAVILY_API_KEY']),
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

  // ---- media player custom protocol ----
  registerMediaProtocol();

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

// ---------------------------------------------------------------- corner media player IPC
ipcMain.handle('media:chooseFolder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: mediaFolder || os.homedir() });
  if (res.canceled || !res.filePaths[0]) return null;
  const folder = path.resolve(res.filePaths[0]);
  mediaFolder = folder;
  const files = scanAudioFolder(folder);
  return { folder, files };
});

// ---------------------------------------------------------------- desktop shell projects

// Grid used for both initial icon placement and drag-to-snap / arrange —
// one shared definition so a freshly-added icon and a re-arranged one always
// land on the exact same cell positions.
const DESKTOP_GRID = { originX: 32, originY: 32, cellW: 104, cellH: 104 };
function gridCell(index, cols) {
  const c = Math.max(1, cols || 6);
  return {
    x: DESKTOP_GRID.originX + (index % c) * DESKTOP_GRID.cellW,
    y: DESKTOP_GRID.originY + Math.floor(index / c) * DESKTOP_GRID.cellH,
  };
}
// Nearest grid cell to an arbitrary dropped pixel position (snap-on-drop).
function snapToGrid(x, y) {
  const col = Math.max(0, Math.round((x - DESKTOP_GRID.originX) / DESKTOP_GRID.cellW));
  const row = Math.max(0, Math.round((y - DESKTOP_GRID.originY) / DESKTOP_GRID.cellH));
  return { x: DESKTOP_GRID.originX + col * DESKTOP_GRID.cellW, y: DESKTOP_GRID.originY + row * DESKTOP_GRID.cellH };
}

ipcMain.handle('project:add', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: cwd });
  if (res.canceled || !res.filePaths[0]) return null;
  const folder = res.filePaths[0];
  const projects = cfg.appState.projects || [];
  if (!projects.some((p) => p.path === folder)) {
    const n = projects.length;
    const pos = gridCell(n, 6);
    projects.push({
      id: crypto.randomUUID(),
      name: path.basename(folder) || folder,
      path: folder,
      createdAt: Date.now(),
      x: pos.x,
      y: pos.y,
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

// Drag-to-snap: the renderer already resolves the drop to the nearest grid
// cell for immediate visual feedback; snapping again here is defense in
// depth so a position can never drift off-grid regardless of caller.
ipcMain.handle('project:move', (e, { id, x, y }) => {
  const snapped = snapToGrid(x, y);
  const projects = (cfg.appState.projects || []).map((p) => (p.id === id ? { ...p, x: snapped.x, y: snapped.y } : p));
  config.saveGlobal({ appState: { projects } });
  cfg = config.load(cwd);
});

// Windows-style "Arrange icons by" — re-lays-out every icon onto the grid in
// sorted order. `cols` is supplied by the renderer (it knows the actual
// desktop viewport width); missing createdAt on legacy projects sorts as
// oldest rather than erroring or guessing a fake date.
ipcMain.handle('project:arrange', (e, { by, cols }) => {
  const projects = (cfg.appState.projects || []).slice();
  const cmp = by === 'name'
    ? (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    : (a, b) => (a.createdAt || 0) - (b.createdAt || 0);
  projects.sort(cmp);
  const arranged = projects.map((p, i) => ({ ...p, ...gridCell(i, cols) }));
  config.saveGlobal({ appState: { projects: arranged } });
  cfg = config.load(cwd);
  return snapshot();
});

ipcMain.handle('project:open', async (e, id) => {
  const proj = (cfg.appState.projects || []).find((p) => p.id === id);
  if (!proj || !fs.existsSync(proj.path)) return snapshot();
  return setWorkingFolder(proj.path);
});

// ---------------------------------------------------------------- containers
// A container is a named collection of REFERENCES to files/folders that
// already exist anywhere on disk — nothing is ever copied or moved. See the
// approved container-feature plan. Each container gets its own scratch
// folder (~/.voidcode/containers/<id>/) holding only its own context db
// (container_refs + context_records/relationships, scoped by its own
// topic_id) — never the referenced files themselves.

const containersRoot = path.join(os.homedir(), '.voidcode', 'containers');
const containerRepoCache = new Map(); // containerId -> ContextRepository, so repeated IPC calls reuse the same open db handle

function findContainer(id) {
  return (cfg.appState.containers || []).find((c) => c.id === id) || null;
}

function getContainerRepository(container) {
  let repo = containerRepoCache.get(container.id);
  if (!repo) {
    const service = createContextService(cfg, container.cwd);
    if (!service.repository) throw new Error('Context database is disabled — enable cfg.contextDb to use containers.');
    repo = service.repository;
    containerRepoCache.set(container.id, repo);
  }
  return repo;
}

// Dependency/build-output directories that are near-never useful as
// cross-referenceable project content and can each hold thousands of files —
// dragging a whole project (e.g. one with node_modules, or a .NET project
// with obj/bin) onto a container would otherwise flood it with generated
// noise instead of the actual source the agent should index.
const CONTAINER_REF_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
  'obj', 'bin', '.next', '.nuxt', '__pycache__', '.venv', 'venv', '.tox',
  'vendor', '.cache', 'coverage', '.idea', '.vscode',
]);

// Recursively collects individual FILE paths under a directory (folders
// themselves never become refs — this keeps hashing/status file-granular
// even when the user only picked a folder). Skips symlinks (same guard the
// corner media player's own folder scan uses), skips dependency/build-output
// directories (see CONTAINER_REF_SKIP_DIRS), and is bounded so a huge folder
// can't hang the picker.
function collectFilesUnder(dir, out = [], limit = 5000) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (out.length >= limit) return out;
    if (ent.isDirectory() && CONTAINER_REF_SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    try { if (fs.lstatSync(full).isSymbolicLink()) continue; } catch { continue; }
    if (ent.isDirectory()) collectFilesUnder(full, out, limit);
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

ipcMain.handle('container:create', async (e, { name }) => {
  const id = crypto.randomUUID();
  const scratchCwd = path.join(containersRoot, id);
  fs.mkdirSync(scratchCwd, { recursive: true });
  const service = createContextService(cfg, scratchCwd);
  if (!service.repository) throw new Error('Context database is disabled — enable cfg.contextDb to use containers.');
  await service.repository.initialize();
  const topic = await service.repository.createTopic({ title: name || 'Untitled container' });
  containerRepoCache.set(id, service.repository);

  const containers = cfg.appState.containers || [];
  const n = (cfg.appState.projects || []).length + containers.length;
  const pos = gridCell(n, 6);
  containers.push({
    id, name: name || 'Untitled container', createdAt: Date.now(),
    x: pos.x, y: pos.y, topicId: topic.topicId, cwd: scratchCwd,
  });
  config.saveGlobal({ appState: { containers } });
  cfg = config.load(cwd);
  return snapshot();
});

// Shared by the file-picker flow and the desktop drag-a-project-onto-a-
// container flow: resolves each path (file or folder, folders recursed) into
// individual file refs, adds them, and kicks off incremental indexing for
// just what's new.
async function addPathsToContainer(container, paths) {
  const repo = getContainerRepository(container);
  const addedRefIds = [];
  for (const p of paths) {
    let isDir = false;
    try { isDir = fs.statSync(p).isDirectory(); } catch { continue; }
    const files = isDir ? collectFilesUnder(p) : [p];
    for (const f of files) {
      const ref = await repo.addContainerRef({ path: f, isDir: false });
      addedRefIds.push(ref.ref_id);
    }
  }
  // Auto-index just the newly added refs — everything else in the container
  // is already indexed and unchanged, so there's no reason to re-scan it.
  if (addedRefIds.length && agent) {
    agent.focus.spawnCustom({
      description: `index: ${container.name}`,
      role: 'indexer',
      runFn: (session) => indexContainer({ agent, repository: repo, topicId: container.topicId, session, refIds: addedRefIds }),
    });
  }
  return { addedCount: addedRefIds.length };
}

ipcMain.handle('container:addRefs', async (e, { id }) => {
  const container = findContainer(id);
  if (!container) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'openDirectory', 'multiSelections'] });
  if (res.canceled || !res.filePaths.length) return { addedCount: 0 };
  return addPathsToContainer(container, res.filePaths);
});

// Desktop drag-and-drop: drop a project icon onto a container icon to add
// that whole project folder as references — no dialog, the paths are
// already known (the project's own folder).
ipcMain.handle('container:addRefPaths', async (e, { id, paths }) => {
  const container = findContainer(id);
  if (!container || !Array.isArray(paths) || !paths.length) return { addedCount: 0 };
  return addPathsToContainer(container, paths);
});

ipcMain.handle('container:removeRef', async (e, { id, refId }) => {
  const container = findContainer(id);
  if (!container) return { ok: false };
  const repo = getContainerRepository(container);
  await repo.removeContainerRef(refId);
  return { ok: true };
});

ipcMain.handle('container:reindex', (e, { id }) => {
  const container = findContainer(id);
  if (!container || !agent) return { ok: false };
  const repo = getContainerRepository(container);
  const { id: focusId } = agent.focus.spawnCustom({
    description: `index: ${container.name}`,
    role: 'indexer',
    runFn: (session) => indexContainer({ agent, repository: repo, topicId: container.topicId, session }),
  });
  return { ok: true, focusId };
});

ipcMain.handle('container:open', async (e, id) => {
  const container = findContainer(id);
  if (!container) return snapshot();
  cwd = container.cwd;
  cfg = config.load(cwd);
  cfg.activeTopicId = container.topicId;
  session = new Session(cwd);
  const provider = buildAgent();
  return snapshot(provider);
});

ipcMain.handle('container:remove', (e, id) => {
  const container = findContainer(id);
  const containers = (cfg.appState.containers || []).filter((c) => c.id !== id);
  config.saveGlobal({ appState: { containers } });
  cfg = config.load(cwd);
  // Only ever removes VoidCode's OWN derived index (the scratch folder it
  // created) — never anything under a referenced path, which this code
  // never writes to or deletes under any circumstance.
  if (container) {
    containerRepoCache.get(container.id)?.close?.();
    containerRepoCache.delete(container.id);
    try { fs.rmSync(container.cwd, { recursive: true, force: true }); } catch {}
  }
  return snapshot();
});

ipcMain.handle('container:move', (e, { id, x, y }) => {
  const snapped = snapToGrid(x, y);
  const containers = (cfg.appState.containers || []).map((c) => (c.id === id ? { ...c, x: snapped.x, y: snapped.y } : c));
  config.saveGlobal({ appState: { containers } });
  cfg = config.load(cwd);
});

ipcMain.handle('container:arrange', (e, { by, cols }) => {
  const containers = (cfg.appState.containers || []).slice();
  const cmp = by === 'name'
    ? (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    : (a, b) => (a.createdAt || 0) - (b.createdAt || 0);
  containers.sort(cmp);
  const arranged = containers.map((c, i) => ({ ...c, ...gridCell(i, cols) }));
  config.saveGlobal({ appState: { containers: arranged } });
  cfg = config.load(cwd);
  return snapshot();
});

ipcMain.handle('container:status', async (e, id) => {
  const container = findContainer(id);
  if (!container) return null;
  const repo = getContainerRepository(container);
  const refs = await repo.listContainerRefs();
  const counts = { total: refs.length, indexed: 0, stale: 0, missing: 0, error: 0, pending: 0 };
  for (const r of refs) counts[r.status] = (counts[r.status] || 0) + 1;
  return { refs, counts };
});

ipcMain.handle('container:relationships', async (e, id) => {
  const container = findContainer(id);
  if (!container) return [];
  const repo = getContainerRepository(container);
  const records = await repo.list({ topicId: container.topicId, limit: 500 });
  const byId = new Map(records.map((r) => [r.record_id, r.title]));
  const relIds = new Set(records.map((r) => r.record_id));
  const all = await repo.driver.relationshipsFor(records);
  return all
    .filter((rel) => relIds.has(rel.from_record_id) && relIds.has(rel.to_record_id))
    .map((rel) => ({
      fromTitle: byId.get(rel.from_record_id) || rel.from_record_id,
      toTitle: byId.get(rel.to_record_id) || rel.to_record_id,
      type: rel.relationship_type,
    }));
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

ipcMain.handle('focus:detail', (e, { id }) => {
  if (!agent?.focus) return null;
  return agent.focus.getDetail(id);
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

// ---------------------------------------------------------------- bug report IPC

const { submitBugReport, REPO_OWNER, REPO_NAME } = require('../src/bugReport');

ipcMain.handle('bugreport:submit', async (e, { title, description, category }) => {
  let providerName = null;
  try { providerName = config.resolveProvider(cfg).name; } catch {}
  const context = { provider: providerName, model: cfg.model };
  return submitBugReport(cfg, { title, description, category, context, submittedBy: 'user' });
});

// Only ever opens a github.com/seed0001/voidcoder issue URL — either one we
// generated ourselves (the manual "new issue" fallback) or the filed issue's
// own URL returned by the GitHub API — never an arbitrary renderer-supplied URL.
ipcMain.handle('bugreport:openUrl', (e, url) => {
  if (typeof url !== 'string' || !url.startsWith(`https://github.com/${REPO_OWNER}/${REPO_NAME}/issues`)) return;
  shell.openExternal(url);
});

// ---------------------------------------------------------------- activity widget IPC

ipcMain.handle('activity:summary', () => require('../src/activityTracker').summary({ weeks: 20 }));

ipcMain.handle('cost:summary', () => costTracker.load(cwd));

ipcMain.handle('cost:rebuild', () => {
  const r = costTracker.rebuildFromSessions(cwd);
  return r;
});
