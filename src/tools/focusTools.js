// Focus tools for the main agent: spawn, status, answer, and board access.
// Spawn supports role + model assignment from the shared AgentRoles store.

const { resolveModelString } = require('../modelCatalog');

const FOCUS_DEFS = [
  {
    name: 'focus',
    description: 'Spawn a background focus subagent that works autonomously on a task with a time budget. Returns immediately with a session ID. mode "task" (default): finish as soon as the work is done. mode "research": a timed research sweep that keeps searching across many sources (web, GitHub, npm, Hacker News, RSS) until the time budget is exhausted, then compiles a report — early finish attempts are rejected while time remains. The subagent can pause to ask questions via focus_pause. Check status with focus_status and answer with focus_answer.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Short label for the task (e.g., "research auth libraries")' },
        prompt: { type: 'string', description: 'Complete standalone instructions for the subagent' },
        minutes: { type: 'number', description: 'Time budget in minutes (default 30)', default: 30 },
        mode: { type: 'string', enum: ['task', 'research'], default: 'task', description: '"task" finishes when done; "research" sweeps sources until the time budget is gone' },
        role: { type: 'string', description: 'Role of this subagent (e.g. researcher, summarizer, analyst, reviewer). If a model role assignment exists it is used unless model is given.' },
        model: { type: 'string', description: 'Model id or name for this subagent (optional; falls back to role assignment, then the main agent model)' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'focus_status',
    description: 'List all focus sessions or get details for a specific one. Shows status (working/waiting/done/error), time remaining, and any pending question.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional session ID to get details for' }
      },
      required: []
    }
  },
  {
    name: 'focus_answer',
    description: 'Answer a waiting focus subagent\'s question. The subagent resumes on its next cycle with the answer.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Focus session ID' },
        answer: { type: 'string', description: 'Your answer to the subagent\'s question' }
      },
      required: ['id', 'answer']
    }
  },
  {
    name: 'focus_board_read',
    description: 'Read messages on the shared board addressed to "main" (the main agent).',
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Timestamp to read messages after' }
      },
      required: []
    }
  },
  {
    name: 'focus_board_write',
    description: 'Post a message to the shared board for a focus subagent (or "main").',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target subagent ID (or "main")' },
        kind: { type: 'string', enum: ['note', 'result', 'request'], default: 'note' },
        content: { type: 'string' }
      },
      required: ['to', 'content']
    }
  }
];

function formatModel(m) {
  const caps = (m.capabilities || []).length ? ` — ${m.capabilities.join(', ')}` : '';
  const cost = m.costCategory || (m.local ? 'free' : 'paid');
  return `  ${m.id} (${m.provider}/${m.modelName}) [${cost}, local:${!!m.local}]${caps}`;
}

function makeExecutors(ctx) {
  const focus = ctx.focus;
  if (!focus) throw new Error('Focus manager not available in tool context');

  async function listAllModels(ctx) {
    try {
      const { discoverModels } = require('../modelCatalog');
      return await discoverModels(ctx.cfg, ctx.cwd || process.cwd());
    } catch { return []; }
  }

  async function resolveModelId(ctx, modelId) {
    const { resolveModelRef } = require('../modelCatalog');
    const rr = await resolveModelRef(ctx.cfg, ctx.cwd || process.cwd(), modelId).catch(() => null);
    if (rr?.resolved) return rr.resolved;
    // Cost/locality words ("free", "local") pick a sensible fallback so the
    // spawn never fails just because the user asked for a free/local model.
    const w = String(modelId).toLowerCase();
    const models = await listAllModels(ctx);
    let pick = null;
    if (/(^|[^a-z])(free|cheapest)([^a-z]|$)/.test(w)) {
      pick = models.find((m) => m.local || m.costCategory === 'free') || null;
    } else if (/local|ollama|llama/.test(w)) {
      pick = models.find((m) => m.local) || null;
    }
    return pick ? `${pick.provider}/${pick.modelName}` : null;
  }

  return {
    focus: async ({ description, prompt, minutes = 30, role, model, mode = 'task' }) => {
      let modelId = model;
      // Role assignment takes precedence when no explicit model was given.
      if (!modelId && role) {
        modelId = ctx.roles?.getRole(role) || null;
      }
      let resolved = null;
      let note = '';
      if (modelId && !/^(current|main)$/i.test(String(modelId))) {
        const { resolveModelRef } = require('../modelCatalog');
        const ref = await resolveModelRef(ctx.cfg, ctx.cwd || process.cwd(), modelId).catch(() => null);
        if (ref) {
          if (ref.type === 'ambiguous') {
            return `Ambiguous model reference "${modelId}". Matches:\n${ref.hits.map(formatModel).join('\n')}\nPick an exact id and try again.`;
          }
          resolved = ref.resolved;
        } else {
          resolved = await resolveModelId(ctx, modelId);
        }
        if (!resolved) {
          const available = (await listAllModels(ctx)).slice(0, 10).map((m) => m.id);
          note = ` Note: could not resolve model "${modelId}", so it inherits the main agent's model. Available examples: ${available.join(', ') || 'none'}`;
        }
      }
      const { id } = focus.spawn({ description, prompt, minutes, model: resolved, role, mode });
      if (ctx.roles) {
        ctx.roles.setAgent(id, { model: resolved || null, role: role || 'worker' });
      }
      const modelInfo = resolved ? ` using ${resolved}` : '';
      const modeNote = mode === 'research'
        ? ` It is a timed research sweep — it will keep searching (web, GitHub, npm, Hacker News, RSS) until the ${minutes}min budget is gone, then deliver a compiled report. Search logs stream live.`
        : ' It runs autonomously and reports when done.';
      return `⧉ Spawned focus session ${id}${description ? ` (${description})` : ''}${modelInfo} — ${minutes}min budget.${modeNote} Use focus_status to check progress; if it asks a question, use focus_answer.${note}`;
    },

    focus_status: async ({ id }) => {
      if (id) {
        const s = focus.get(id);
        if (!s) return `No focus session ${id}`;
        const st = s.getStatus();
        let out = `Focus ${st.id} [${st.status}]\n`;
        out += `  Task: ${st.description}\n`;
        out += `  Time: ${st.remainingMin}min remaining\n`;
        if (st.question) out += `  ❓ Waiting: ${st.question}\n`;
        if (st.finalReport) out += `  ✓ Report: ${st.finalReport}\n`;
        if (st.log.length) out += `  Log: ${st.log.map(l => l.entry).join('; ')}`;
        return out;
      }
      const list = focus.list();
      if (!list.length) return 'No active focus sessions';
      return list.map(s => {
        let line = `  ${s.id} [${s.status}] — ${s.description} (${s.remainingMin}min)`;
        if (s.question) line += ` ❓ ${s.question}`;
        return line;
      }).join('\n');
    },

    focus_answer: async ({ id, answer }) => {
      const res = focus.answer(id, answer);
      if (res.ok) return `Answered focus ${id}. Subagent will continue on next cycle.`;
      return `Error: ${res.error}`;
    },

    focus_board_read: async ({ since = 0 }) => {
      const msgs = focus.board ? focus.board.read({ to: 'main', since }) : [];
      if (!msgs.length) return '(no messages)';
      return msgs.map(m => `[${m.from}] ${m.kind}: ${m.content}`).join('\n---\n');
    },

    focus_board_write: async ({ to, kind = 'note', content }) => {
      if (focus.board) focus.board.post({ to, from: 'main', kind, content });
      return `Posted to ${to}`;
    }
  };
}

module.exports = { FOCUS_DEFS, makeExecutors };