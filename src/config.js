// Configuration: global ~/.voidcode/config.json merged with project .voidcode.json.
// Project instructions load from AGENTS.md (or CLAUDE.md) in the project root.
// Model registry loads from models.json at project root or global dir.

const fs = require('fs');
const path = require('path');
const os = require('os');

const GLOBAL_DIR = path.join(os.homedir(), '.voidcode');
const GLOBAL_CONFIG = path.join(GLOBAL_DIR, 'config.json');
const GLOBAL_MODELS = path.join(GLOBAL_DIR, 'models.json');
const PROJECT_MODELS = 'models.json';

const DEFAULTS = {
  provider: 'openrouter',
  model: 'anthropic/claude-sonnet-4.5',
  smallModel: '', // used for compaction/titles; falls back to `model`
  persona: '',
  memory: '',
  providers: {
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', apiKeyEnv: 'OPENROUTER_API_KEY' },
    // Local models default to a 16K window (sent as num_ctx) so the ~5-7K
    // fixed overhead (system prompt + tool defs) leaves room for an actual
    // conversation. Ollama/llama.cpp silently drop the OLDEST messages past
    // num_ctx instead of erroring, so an undersized window reads as amnesia.
    // Lower this per-provider if the machine can't fit the KV cache.
    ollama: { baseUrl: 'http://localhost:11434/v1', apiKey: '', apiKeyEnv: '', contextTokens: 16384 },
    llamacpp: { baseUrl: 'http://localhost:8080/v1', apiKey: '', apiKeyEnv: '', contextTokens: 16384 },
    openai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', apiKeyEnv: 'OPENAI_API_KEY' },
    fairrouter: { baseUrl: 'https://fairrouter.ai/v1', apiKey: '', apiKeyEnv: 'FAIRROUTER_API_KEY' },
  },
  integrations: {
    githubToken: '',
    railwayToken: '',
  },
  permissions: {
    // allow = run without asking; ask = interactive y/n; deny = always refuse
    bash: 'ask',
    write: 'allow',
    edit: 'allow',
    webfetch: 'allow',
  },
  // bash commands matching these patterns run without asking even when bash=ask.
  // '*' matches any sequence. Matched against the full command string.
  bashAllow: ['git status*', 'git diff*', 'git log*', 'ls*', 'dir*', 'node --version', 'npm --version'],
  // 0 means auto-detect from live model/provider metadata; the runtime falls
  // back to 200K when a remote catalog cannot be reached.
  contextTokens: 0,
  compactAt: 0.75,       // auto-compact when estimated usage crosses this fraction
  maxToolRounds: 100,
  // Single-agent mode (default 'legacy'): a monolithic agent with inline tools
  // and shared context window. 'split' mode uses a two-sided setup where the
  // chat side delegates work to an action agent.
  agentMode: 'legacy',
  chatModel: '',           // chat-side model; '' = the main model
  // 0 = use the active model's/provider's context window automatically.
  chatContextTokens: 0,
  workerModel: '',         // action-side model; '' = the main model
  workerContextTokens: 0,  // action-side window; 0 = provider contextTokens (the limited one)
  contextDb: {
    enabled: true,
    path: '.voidcode/context.sqlite',
    command: 'sqlite3',
    timeoutMs: 10000,
    cacheTtlMs: 30000,
    cacheSize: 100,
    budgetTokens: 6000,
    maxRecords: 40,
  },
  guardrails: {
    // Universal turn interceptor + behavioral learning memory (src/guardrails.js).
    enabled: true,           // set false to disable all dynamic turn-time rules
    maxZeroHitStreak: 3,     // consecutive empty/error tool results before a forced stop/pause rule
    repeatedToolCallWarningAt: 3, // identical non-web tool calls before a diagnostic warning
    repeatedToolCallStopAt: 4, // identical non-web tool calls before a mechanical stop
    maxToolCalls: 25,        // focus subagents are soft-capped here and forced to report
    researchMaxToolCalls: 250, // research-mode sweeps are capped much higher (time, not calls, ends them)
    maxLearnings: 30,        // entries kept in ~/.voidcode/learnings.md (newest win; dedup on trigger)
    maxLearningsInjected: 3, // matched lessons injected per turn, at most
    anchorLength: 4000,      // tool outputs longer than this trigger the digest rule
  },
  interactionStyle: 'collaborative', // collaborative | direct — see prompt.js
  autonomyLevel: 'off',  // off | research | safe | full — see permissions.js
  protectedPaths: ['src/**', 'app/**', 'bin/**', 'test/**'], // glob patterns requiring approval at 'safe' level
  mcpServers: {},        // name -> { command, args: [], env: {} }
  voice: {
    autoSpeak: true,
    handsFree: false,
    stt: {
      // any OpenAI-compatible /audio/transcriptions endpoint (Groq free tier works well)
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: '',
      model: 'whisper-large-v3-turbo',
    },
    tts: {
      backend: 'edge', // fish | edge | sapi (falls back down the chain on failure)
      fish: { apiKey: '', voiceId: '', model: 's1' },
      edge: { voice: 'en-US-AndrewMultilingualNeural' },
      sapi: { voice: '' },
    },
  },
  appState: { lastCwd: '', projects: [] }, // desktop app: last working folder + desktop shell project icons
  // Desktop appearance (renderer only). Unknown theme ids fall back to 'void'.
  ui: {
    theme: 'void',   // void | ember | mono | violet
    pacer: true,     // walk the bottom avatar while the agent is thinking
  },
  // Web portal (app/portal.js): mobile remote control via a token-auth HTTP
  // panel, optionally exposed through a Cloudflare quick tunnel (cloudflared).
  webPortal: {
    enabled: false,       // autostart the portal when the desktop app launches
    tunnel: 'off',        // off | cloudflared
    port: 8777,           // localhost bind port (never exposed directly)
    cloudflaredPath: '',  // optional explicit path to cloudflared.exe
  },
  // Desktop app auto-updates (electron-updater, GitHub Releases). Opt-in —
  // checking for updates on launch only happens if autoCheck is true; a
  // manual "Check for updates now" button works either way.
  updates: {
    autoCheck: false,
  },
  // Discord integration (src/discord/*). Wholly OPTIONAL and additive — the
  // daemon (bin/voidcode-discord.js) simply exits if discord.enabled is false,
  // and nothing here affects the terminal/desktop/portal paths.
  discord: {
    enabled: false,
    tokenEnv: 'DISCORD_BOT_TOKEN', // env var holding the bot token (mirrors providers[].apiKeyEnv)
    token: '', // optional inline override; prefer tokenEnv — never commit a real token here
    // The ONLY Discord user id that can manage contacts/tiers/portfolio. Set
    // this by hand here — it is never writable via any Discord command or LLM tool.
    ownerId: '',
    projectPath: '',               // cwd interactive chat sessions run against; '' = daemon's own cwd
    guildIds: [],                  // servers the bot operates in; [] = DMs only
    allowedChannelIds: [],         // designated channels to listen in within those guilds
    reportChannelId: '',           // scheduled-task/focus/portfolio notifications land here
    permissionTimeoutSec: 120,     // owner permission prompt (reaction/reply) auto-denies after this
    sessionIdleEvictMinutes: 60,   // idle per-contact Agent/Session instances save+evict after this
    // Per-tier overrides applied to a cloned cfg before constructing that
    // contact's Permissions. 'owner' always uses the real cfg unmodified.
    // Add/rename tiers here — nothing else hardcodes tier names.
    // rank orders tiers low-to-high for "minimum tier allowed" checks (e.g.
    // voice.minTierAllowed) — explicit, so it doesn't depend on object key
    // declaration order if a user reorders/edits this in their config file.
    tiers: {
      guest: {
        rank: 0,
        permissions: { bash: 'deny', write: 'deny', edit: 'deny', webfetch: 'deny' },
        autonomyLevel: 'off', canManageContacts: false, canManagePortfolio: false, canUseVoice: false, toolsEnabled: false,
      },
      trusted: {
        rank: 1,
        permissions: { bash: 'deny', write: 'deny', edit: 'deny', webfetch: 'allow' },
        autonomyLevel: 'off', canManageContacts: false, canManagePortfolio: false, canUseVoice: true, toolsEnabled: true,
      },
      owner: { rank: 2, useRealConfig: true, canManageContacts: true, canManagePortfolio: true, canUseVoice: true, toolsEnabled: true },
    },
    voice: {
      enabled: false,
      opusLib: 'opusscript',       // pure-JS, no native build; '@discordjs/opus' is a faster native alternative
      minTierAllowed: 'trusted',
    },
    portfolio: {
      enabled: false,               // additive/no-op — false means zero behavior change
      defaultCadenceMinutes: 720,
      defaultAutonomyLevel: 'safe', // sweeps always run at this level regardless of the owner's real cfg
    },
  },
  // Digital-organism mode (src/organism.js). Wholly OPTIONAL and additive —
  // when disabled (the default) every integration point is a no-op and nothing
  // about the existing terminal / desktop / portal / sessions / permissions /
  // schedules / model catalog / cost tracking changes. When enabled, the agent
  // operates under a persistent treasury with an auditable ledger, per-task
  // spending caps, and cost-aware model selection.
  organism: {
    enabled: false,        // the master switch
    initialCredits: 100,   // USD seed for a brand-new treasury (configurable)
    currency: 'USD',
    defaultCapUSD: 5,      // default hard per-task spending cap
    capFraction: 0.2,      // a task may not exceed this fraction of remaining balance
    minCapUSD: 0.05,       // floor on the computed cap
    maxCapUSD: 100,        // absolute ceiling on any single task cap
    defaultTurnsPerTask: 20, // assumed turns for a task when estimating
    autoSelectModels: true, // route sub-agents/focus/worker to the cheapest adequate model
    stopAfterUnproductiveRounds: 4, // stop a loop after this many cost-incurring, no-progress rounds
  },
};

// Model Registry: loads models.json from project dir, ancestors, the app
// install dir, or global dir. No hardcoded catalog — the processes fetch the
// live catalog (OpenRouter API, installed Ollama/Llama.cpp models) and merge.
class ModelRegistry {
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
    this.models = this._loadModels();
  }

  _findModelsFile() {
    // 1) project dir + ancestors (walk up so a nested project still finds it)
    let dir = path.resolve(this.cwd);
    const seen = new Set();
    while (dir && !seen.has(dir) && seen.size < 12) {
      seen.add(dir);
      const p = path.join(dir, PROJECT_MODELS);
      if (fs.existsSync(p)) return p;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    // 2) the app's own models.json (lives at repo root, one up from src/)
    const appModels = path.join(__dirname, '..', PROJECT_MODELS);
    if (fs.existsSync(appModels)) return appModels;
    // 3) global ~/.voidcode/models.json
    if (fs.existsSync(GLOBAL_MODELS)) return GLOBAL_MODELS;
    return null;
  }

  _loadModels() {
    const file = this._findModelsFile();
    this._sourceFile = file;
    if (file) {
      const data = readJson(file);
      // data.models = array of entries; data itself may be a single entry
      if (data) {
        if (Array.isArray(data.models)) return data.models;
        if (data.id && data.provider) return [data];
        if (Array.isArray(data)) return data;
      }
    }
    // No local registry. Live catalog is fetched separately and merged in the
    // UI; report nothing here rather than hardcode a stale list.
    return [];
  }

  getAll() {
    return this.models;
  }

  get(id) {
    return this.models.find(m => m.id === id);
  }

  getDefault() {
    return this.models.find(m => m.id === this._getDefaultId()) || this.models[0] || null;
  }

  _getDefaultId() {
    const file = this._sourceFile || this._findModelsFile();
    const data = file ? readJson(file) : null;
    return data?.defaultModel || this.models[0]?.id;
  }

  getByCapability(cap) {
    return this.models.filter(m => m.capabilities?.includes(cap));
  }

  getByCostCategory(category) {
    return this.models.filter(m => m.costCategory === category);
  }

  // Suggest model based on autonomy level
  suggestForAutonomy(level) {
    switch (level) {
      case 'research':
        return this.getByCostCategory('free').find(m => m.capabilities?.includes('research')) || this.getByCostCategory('free')[0];
      case 'safe':
        return this.getByCostCategory('free').find(m => m.capabilities?.includes('coding')) || this.getByCostCategory('free')[0];
      case 'full':
        return this.getByCostCategory('paid').find(m => m.capabilities?.includes('reasoning')) || this.getByCostCategory('paid')[0];
      default:
        return this.getDefault();
    }
  }
}

function deepMerge(base, over) {
  if (over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || base === null ||
      typeof over !== 'object' || over === null) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

function readJson(p) {
  // strip UTF-8 BOM — Windows editors and PowerShell add it routinely
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function load(cwd = process.cwd()) {
  const global = readJson(GLOBAL_CONFIG) || {};
  const project = readJson(path.join(cwd, '.voidcode.json')) || {};
  const cfg = deepMerge(deepMerge(DEFAULTS, global), project);
  cfg._globalPath = GLOBAL_CONFIG;
  cfg._projectPath = path.join(cwd, '.voidcode.json');
  return cfg;
}

function saveGlobal(patch) {
  fs.mkdirSync(GLOBAL_DIR, { recursive: true });
  const current = readJson(GLOBAL_CONFIG) || {};
  const next = deepMerge(current, patch);
  fs.writeFileSync(GLOBAL_CONFIG, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// Resolve the active provider {name, baseUrl, apiKey, model}.
function resolveProvider(cfg, overrideModel) {
  let providerName = cfg.provider;
  let model = overrideModel || cfg.model;
  
  if (overrideModel) {
    // "provider/model..." syntax: openrouter/anthropic/claude-sonnet-4.5
    const firstSeg = model.split('/')[0];
    if (cfg.providers[firstSeg]) {
      providerName = firstSeg;
      model = model.slice(firstSeg.length + 1);
    }
  } else {
    // If resolving config directly, only strip the provider prefix if it explicitly matches cfg.provider
    const firstSeg = model.split('/')[0];
    if (firstSeg === providerName && cfg.providers[firstSeg]) {
      model = model.slice(firstSeg.length + 1);
    }
  }
  
  const p = cfg.providers[providerName];
  if (!p) throw new Error(`Unknown provider "${providerName}". Configured: ${Object.keys(cfg.providers).join(', ')}`);
  const apiKey = p.apiKey || (p.apiKeyEnv ? process.env[p.apiKeyEnv] || '' : '');
  return {
    ...p,
    name: providerName,
    baseUrl: p.baseUrl,
    apiKey,
    model,
    configuredContextTokens: Number.isFinite(p.contextTokens) ? p.contextTokens : 0,
  };
}

// Project instruction files, most specific first.
function loadProjectInstructions(cwd = process.cwd()) {
  const parts = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md', '.voidcode.md']) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) {
      try { parts.push({ file: name, content: fs.readFileSync(p, 'utf8').slice(0, 20000) }); } catch { }
    }
  }
  return parts;
}

module.exports = { load, saveGlobal, resolveProvider, loadProjectInstructions, GLOBAL_DIR, DEFAULTS, ModelRegistry, deepMerge };
