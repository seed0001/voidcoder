// One Agent+Session+Permissions per contact (not per channel/context — voice
// and text intentionally share the same session so context carries over,
// per the plan). Lazily constructs on first message/utterance from a known
// contact and resumes their persisted Session across daemon restarts via
// discord-sessions.json.

const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../config');
const { Agent } = require('../agent');
const { Session } = require('../sessions');
const { Permissions } = require('../permissions');
const contacts = require('./contacts');
const { deriveCfgForTier, tierCapability } = require('./tiers');
const { makePromptFn } = require('./permissionBridge');
const notifyTool = require('./tools/notifyTool');

const SESSIONS_FILE = path.join(os.homedir(), '.voidcode', 'discord-sessions.json');

function loadMap() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) || {}; } catch { return {}; }
}

function saveMap(map) {
  fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(map, null, 2), 'utf8');
}

class SessionRegistry {
  // cfg — base (owner-level) config. mcpServers — shared started MCP servers.
  // client — the discord.js Client, needed to give the owner's session the
  // discord_post tool (see tools/notifyTool.js).
  constructor({ cfg, mcpServers = [], client = null }) {
    this.cfg = cfg;
    this.mcpServers = mcpServers;
    this.client = client;
    this.live = new Map(); // discordUserId -> { agent, session, permissions, tier, lastUsedAt }
    this.idMap = loadMap(); // discordUserId -> { sessionId, updatedAt }
    this._evictTimer = setInterval(() => this._evictIdle(), 5 * 60 * 1000);
    this._evictTimer.unref?.();
  }

  _cwd() {
    return this.cfg.discord.projectPath || process.cwd();
  }

  // Returns null if the user isn't a contact (caller should already have
  // checked via contacts.getTier, but this stays defensive).
  get(discordUserId) {
    const cached = this.live.get(discordUserId);
    if (cached) { cached.lastUsedAt = Date.now(); return cached; }

    const tier = contacts.getTier(discordUserId, this.cfg);
    if (!tier) return null;

    const derivedCfg = deriveCfgForTier(this.cfg, tier);
    const provider = config.resolveProvider(derivedCfg);
    const cwd = this._cwd();

    const mapping = this.idMap[discordUserId];
    let session;
    if (mapping?.sessionId) {
      try { session = Session.load(cwd, mapping.sessionId); } catch { session = null; }
    }
    if (!session) session = new Session(cwd);
    this.idMap[discordUserId] = { sessionId: session.id, updatedAt: new Date().toISOString() };
    saveMap(this.idMap);

    const permissions = new Permissions(derivedCfg, makePromptFn(discordUserId, this.cfg, null));
    const agent = new Agent({ cfg: derivedCfg, provider, session, permissions, mcpServers: this.mcpServers, events: {}, cwd });
    if (!tierCapability(tier, this.cfg, 'toolsEnabled')) {
      agent.tools = { apiDefs: [], executors: {} };
    } else if (tier === 'owner' && this.client) {
      const wrapped = notifyTool.defs.map((d) => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } }));
      agent.tools.apiDefs = [...agent.tools.apiDefs, ...wrapped];
      Object.assign(agent.tools.executors, notifyTool.makeExecutors({ client: this.client, defaultChannelId: this.cfg.discord.reportChannelId }));
    }

    const entry = { agent, session, permissions, tier, lastUsedAt: Date.now() };
    this.live.set(discordUserId, entry);
    return entry;
  }

  // Points this contact's Permissions prompt (and future events) at the
  // channel their current message/utterance actually came from.
  bindChannel(discordUserId, channel) {
    const entry = this.live.get(discordUserId);
    if (!entry) return;
    entry.permissions.promptFn = makePromptFn(discordUserId, this.cfg, channel);
  }

  _evictIdle() {
    const cutoffMs = (this.cfg.discord.sessionIdleEvictMinutes || 60) * 60 * 1000;
    const now = Date.now();
    for (const [id, entry] of this.live) {
      if (now - entry.lastUsedAt > cutoffMs) {
        try { entry.session.save(); } catch { /* best effort */ }
        this.live.delete(id);
      }
    }
  }

  saveAll() {
    for (const entry of this.live.values()) {
      try { entry.session.save(); } catch { /* best effort on shutdown */ }
    }
  }

  stop() {
    clearInterval(this._evictTimer);
    this.saveAll();
  }
}

module.exports = { SessionRegistry, SESSIONS_FILE };
