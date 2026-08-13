// Agent model assignments: a persisted map of agent_id -> model_id plus
// role -> model_id defaults, scoped per project directory. Fully dynamic —
// there is no fixed relationship between the main agent's model and any
// sub-agent's model. Everything here is user/agent-determined.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.voidcode', 'agent-roles.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}

function save(data) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch {}
}

class AgentRoles {
  constructor(cwd = process.cwd()) {
    this.cwd = cwd;
    this.data = load();
    this.scope = this.data[cwd] || { roles: {}, agents: {} };
    this.data[cwd] = this.scope;
  }

  _persist() {
    this.data[this.cwd] = this.scope;
    save(this.data);
  }

  // role -> modelId (e.g. 'researcher' -> 'openrouter/deepseek/deepseek-chat-v3.1')
  setRole(role, modelId) {
    this.scope.roles[role] = modelId;
    this._persist();
  }

  getRole(role) {
    return this.scope.roles[role] || null;
  }

  unsetRole(role) {
    delete this.scope.roles[role];
    this._persist();
  }

  roles() {
    return { ...this.scope.roles };
  }

  // agentId -> { model, role } (any running sub-agent's assignment)
  setAgent(agentId, { model, role } = {}) {
    this.scope.agents[agentId] = {
      model: model || null,
      role: role || 'worker',
      updatedAt: Date.now(),
    };
    this._persist();
  }

  getAgent(agentId) {
    return this.scope.agents[agentId] || null;
  }

  agents() {
    return { ...this.scope.agents };
  }

  // Resolve the model string (provider/model or registry id) that a given
  // scope should run on. Priority: agent override -> role assignment ->
  // default (main agent's model).
  resolveModelFor(agentId, role, { defaultModel, modelCatalog } = {}) {
    const agentEntry = agentId ? this.getAgent(agentId) : null;
    if (agentEntry?.model) return agentEntry.model;
    if (role && this.scope.roles[role]) return this.scope.roles[role];
    return defaultModel || null;
  }

  // Full structure snapshot: main agent + all roles + live agent assignments.
  structure({ main, agents } = {}) {
    return {
      main: main || null,
      roles: { ...this.scope.roles },
      agents: { ...this.scope.agents, ...(agents || {}) },
    };
  }
}

module.exports = { AgentRoles };