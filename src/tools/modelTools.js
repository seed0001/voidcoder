// Conversational model tools: let the main agent query the live model
// catalog, switch its own model, and assign models to sub-agents by role or
// explicit agent. All operate on the single shared model catalog and the
// persisted AgentRoles store — never on a hardcoded list.

const { discoverModels, resolveModelRef, sortByCost, sortByRecency, groupByTier, estimateCost } = require('../modelCatalog');
const { AgentRoles } = require('../agentRoles');

const MODEL_DEFS = [
  {
    name: 'list_models',
    description: 'List available models from the live catalog (OpenRouter + locally installed Ollama/Llama.cpp + stored models.json). Optional query filters by name/family/provider. Useful to see what is available before selecting or assigning models.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional filter, e.g. "deepseek", "qwen", "claude", "llama"' },
        showAll: { type: 'boolean', description: 'Include every match (default true). Set false to return a count only.' }
      },
      required: []
    }
  },
  {
    name: 'model_info',
    description: 'Inspect metadata (provider, base URL, cost category, capabilities) for a specific model id.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Model id, e.g. "openrouter/deepseek/deepseek-chat-v3.1" or "ollama/qwen2.5-coder:latest"' }
      },
      required: ['id']
    }
  },
  {
    name: 'current_model',
    description: 'Show which model the main agent is currently using.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'set_model',
    description: 'Switch the main agent to a different model. Provide a model id (e.g. "openrouter/deepseek/deepseek-chat-v3.1") or a name/family ("deepseek") when unambiguous.',
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model id or name to switch to' }
      },
      required: ['model']
    }
  },
  {
    name: 'assign_model',
    description: 'Assign a model to a sub-agent role (e.g. researcher, summarizer, fact-checker, reviewer) or to an explicit agent. Future sub-agents spawned with that role will use the assigned model. This does not change the main agent model.',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Role name, e.g. "researcher", "summarizer", "analyst", "reviewer"' },
        agent: { type: 'string', description: 'Optional explicit focus/agent id to assign (overrides role default)' },
        model: { type: 'string', description: 'Model id or name, e.g. "ollama/qwen2.5-coder:latest" or "deepseek"' }
      },
      required: ['model']
    }
  },
  {
    name: 'agent_structure',
    description: 'Show the current agent -> model structure: the main agent model, all role assignments, and every running sub-agent.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'model_tiers',
    description: 'List models organized by cost tier: free, economy (cheap paid), average (previous gen / mid-range), premium (newest / most expensive), and vision (image/video-capable). Within each tier, models are sorted cheapest to most expensive by per-token price. Use this to compare model costs and pick the right tier for a project budget.',
    parameters: {
      type: 'object',
      properties: {
        tier: { type: 'string', description: 'Filter to a specific tier: free, economy, average, premium, or vision. Omit to show a summary of all tiers.', enum: ['free', 'economy', 'average', 'premium', 'vision'] },
        limit: { type: 'number', description: 'Max models per tier (default 15). Use a higher number to see more options.' },
        sort: { type: 'string', description: 'Sort order within tier: cost (cheapest first, default) or newest (most recently added first).', enum: ['cost', 'newest'] },
      },
      required: [],
    }
  },
  {
    name: 'cost_estimate',
    description: 'Estimate the projected USD cost for using a model on a project. Provide the model, expected number of turns (conversation rounds or tool-call rounds), average input tokens per turn (system prompt + history + user message), and average output tokens per turn. Returns per-turn and total cost. Use this to budget a project before committing to a model.',
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model id (e.g. "openrouter/anthropic/claude-opus-5") or name ("claude opus")' },
        turns: { type: 'number', description: 'Expected number of turns / API calls (default 100)' },
        inputTokens: { type: 'number', description: 'Average input tokens per turn — system prompt + conversation history + user input (default 5000)' },
        outputTokens: { type: 'number', description: 'Average output tokens per turn — model response (default 1500)' },
      },
      required: ['model'],
    }
  },
  {
    name: 'recommend_models',
    description: 'Recommend models that fit within a project budget. Given a max USD budget, expected usage (turns + tokens), and optional task type, returns models sorted by best value (cost vs capability) that stay under budget. Covers all tiers so you can see the trade-off between premium reasoning models and economy options.',
    parameters: {
      type: 'object',
      properties: {
        budgetUSD: { type: 'number', description: 'Maximum USD you want to spend on this project' },
        turns: { type: 'number', description: 'Expected number of turns / API calls (default 100)' },
        inputTokens: { type: 'number', description: 'Average input tokens per turn (default 5000)' },
        outputTokens: { type: 'number', description: 'Average output tokens per turn (default 1500)' },
        task: { type: 'string', description: 'Optional task type to filter by: coding, research, reasoning, vision, writing, long-context' },
        tier: { type: 'string', description: 'Optional: restrict to a tier (free, economy, average, premium)', enum: ['free', 'economy', 'average', 'premium'] },
        maxResults: { type: 'number', description: 'Max number of recommendations (default 10)' },
      },
      required: ['budgetUSD'],
    }
  },
];

function formatModel(m) {
  const caps = (m.capabilities || []).length ? ` — ${m.capabilities.join(', ')}` : '';
  const local = m.local ? 'local' : (m.costTier || 'paid');
  let price = '';
  if (!m.local && m.pricePerMTokens) {
    if (m.costTier === 'free' || (m.pricePerMTokens.input === 0 && m.pricePerMTokens.output === 0)) {
      price = ' [free]';
    } else {
      price = ` [$${m.pricePerMTokens.input}/$${m.pricePerMTokens.output} per 1M tok]`;
    }
  } else if (m.local) {
    price = ' [free, local]';
  }
  return `  ${m.id}${price} (${local})${caps}`;
}

function formatTierModel(m) {
  const caps = (m.capabilities || []).length ? ` [${m.capabilities.join(',')}]` : '';
  if (m.local || m.costTier === 'free') return `  ${m.id} — FREE${caps}`;
  const pi = m.pricePerMTokens?.input ?? '?';
  const po = m.pricePerMTokens?.output ?? '?';
  return `  ${m.id} — $${pi}/$${po} per 1M tok${caps}`;
}

function currentProvider(ctx) {
  if (ctx.provider) return ctx.provider;
  if (ctx.cfg) return { name: ctx.cfg.provider, model: ctx.cfg.model };
  return { name: 'unknown', model: 'unknown' };
}

function makeExecutors(ctx) {
  const cwd = ctx.cwd || process.cwd();
  const roles = ctx.roles || new AgentRoles(cwd);

  async function catalog() {
    return discoverModels(ctx.cfg, cwd);
  }

  async function matchModels(query) {
    const models = await catalog();
    const q = String(query || '').toLowerCase();
    if (!q) return models;
    const qq = q.replace(/[^a-z0-9]+/g, '');
    if (!qq) return [];
    return models.filter((m) => {
      const blob = [m.id, m.modelName, m.family, m.provider].join(' ').toLowerCase().replace(/[^a-z0-9]+/g, '');
      return blob.includes(qq);
    });
  }

  return {
    list_models: async ({ query, showAll = true } = {}) => {
      const list = await matchModels(query);
      if (!list.length) return `No models match "${query}". Run list_models without a query to see everything.`;
      if (showAll === false) return `${list.length} model(s) match${query ? ` "${query}"` : ''}.`;
      const header = query ? `${list.length} model(s) matching "${query}":` : `${list.length} available models:`;
      return header + '\n' + list.map(formatModel).join('\n');
    },

    model_info: async ({ id }) => {
      const models = await catalog();
      const m = models.find((x) => x.id === id || x.modelName === id);
      if (!m) return `Unknown model "${id}". Use list_models to see what is available.`;
      return `${m.id}\n  provider: ${m.provider}\n  model: ${m.modelName}\n  baseUrl: ${m.baseUrl}\n  cost: ${m.costCategory || 'n/a'}\n  local: ${!!m.local}\n  family: ${m.family}\n  capabilities: ${(m.capabilities || []).join(', ') || 'none'}`;
    },

    current_model: async () => {
      const p = currentProvider(ctx);
      return `Current model: ${p.name}/${p.model}`;
    },

    set_model: async ({ model }) => {
      if (!ctx.setModel) throw new Error('model switching unavailable in this context');
      const ref = await resolveModelRef(ctx.cfg, cwd, model);
      if (!ref) {
        const list = await matchModels(model);
        return `Could not resolve "${model}". ${list.length ? 'Matching:\n' + list.map(formatModel).join('\n') : "Run list_models to see what's available."}`;
      }
      if (ref.type === 'ambiguous') {
        return `Ambiguous model reference "${model}". Matches:\n${ref.hits.map(formatModel).join('\n')}\nPick an exact id and try again.`;
      }
      const res = await ctx.setModel(ref.resolved);
      if (!res?.ok) return `Failed to switch model: ${res?.error || 'unknown error'}`;
      return `Switched main agent to ${res.provider.name}/${res.provider.model || model}`;
    },

    assign_model: async ({ role, agent, model }) => {
      const ref = await resolveModelRef(ctx.cfg, cwd, model);
      if (!ref) {
        const list = await matchModels(model);
        const avail = list.slice(0, 30).map((m) => m.id).join(', ') || 'none';
        return `Could not resolve "${model}" to a known model. ${list.length ? 'Matching:\n' + list.map(formatModel).join('\n') : `Available examples: ${avail}`}`;
      }
      if (ref.type === 'ambiguous') {
        return `Ambiguous model reference "${model}". Matches:\n${ref.hits.map(formatModel).join('\n')}\nPick an exact id and try again.`;
      }
      if (agent) {
        roles.setAgent(agent, { model: ref.resolved, role: role || 'worker' });
        return `${ref.resolved} assigned to agent ${agent}.`;
      }
      if (!role) return 'assign_model needs a role or an explicit agent to update.';
      roles.setRole(role, ref.resolved);
      return `"${ref.resolved}" now used for role "${role}".`;
    },

    agent_structure: async () => {
      const p = currentProvider(ctx);
      const focusList = ctx.focus?.list ? await ctx.focus.list() : [];
      const focusAgents = {};
      for (const s of focusList) focusAgents[s.id] = { model: s.model || null, role: 'focus' };
      const structure = roles.structure({
        main: `${p.name}/${p.model}`,
        agents: focusAgents,
      });
      const lines = [`main: ${structure.main || '(none)'}`, 'roles:'];
      const roleEntries = Object.entries(structure.roles || {});
      if (!roleEntries.length) lines.push('  (no role assignments)');
      for (const [r, m] of roleEntries) lines.push(`  ${r} -> ${m}`);
      lines.push('agents:');
      const agentEntries = Object.entries(structure.agents || {});
      if (!agentEntries.length) lines.push('  (no running subagents)');
      for (const [id, a] of agentEntries) lines.push(`  ${id} [${a.role}] -> ${a.model || '(inherits main)'}`);
      return lines.join('\n');
    },

    model_tiers: async ({ tier, limit = 15, sort = 'cost' } = {}) => {
      const models = await catalog();
      const tiers = groupByTier(models);
      const sortFn = sort === 'newest' ? sortByRecency : sortByCost;

      if (tier) {
        const list = tiers[tier];
        if (!list || !list.length) return `No models in tier "${tier}".`;
        const sorted = sortFn(list).slice(0, limit);
        const header = `${tier.toUpperCase()} tier — ${list.length} model(s)${sort === 'newest' ? ' (newest first)' : ' (cheapest first)'}:\n`;
        return header + sorted.map(formatTierModel).join('\n');
      }

      // Summary of all tiers
      const lines = [];
      const order = ['premium', 'average', 'economy', 'free', 'vision'];
      for (const t of order) {
        const list = tiers[t] || [];
        if (!list.length) continue;
        const sorted = sortFn(list);
        const costs = list.filter(m => !m.local).map(m => m.pricePerMTokens?.input || 0);
        const minCost = costs.length ? Math.min(...costs).toFixed(2) : '0';
        const maxCost = costs.length ? Math.max(...costs).toFixed(2) : '0';
        lines.push(`=== ${t.toUpperCase()} (${list.length} models, $${minCost}–$${maxCost}/1M input) ===`);
        for (const m of sorted.slice(0, limit)) lines.push(formatTierModel(m));
        if (list.length > limit) lines.push(`  ... and ${list.length - limit} more (raise limit to see all)`);
        lines.push('');
      }
      return lines.join('\n');
    },

    cost_estimate: async ({ model, turns = 100, inputTokens = 5000, outputTokens = 1500 } = {}) => {
      const models = await catalog();
      const ref = await resolveModelRef(ctx.cfg, cwd, model);
      let target;
      if (ref && ref.hits.length === 1) target = ref.hits[0];
      else target = models.find((m) => m.id === model || m.modelName === model);
      if (!target && ref) target = ref.hits[0];
      if (!target) {
        const list = await matchModels(model);
        return `Could not find model "${model}".${list.length ? ' Matching:\n' + list.slice(0, 10).map(formatModel).join('\n') : ' Use list_models to see available models.'}`;
      }
      const est = estimateCost(target, { inputTokens, outputTokens, turns });
      const lines = [
        `Cost estimate for: ${target.id}`,
        `  Tier: ${target.costTier}  |  Capabilities: ${(target.capabilities || []).join(', ') || 'none'}`,
        `  Pricing: $${target.pricePerMTokens?.input || 0}/$${target.pricePerMTokens?.output || 0} per 1M tokens (input/output)`,
        `  Usage: ${turns} turns × ${inputTokens} in / ${outputTokens} out tokens per turn`,
        `  ─────────────────────────────────────`,
        `  Per turn:    $${est.perTurnUSD}`,
        `  Input total: $${est.inputCostUSD} (${(inputTokens * turns).toLocaleString()} tokens)`,
        `  Output total:$${est.outputCostUSD} (${(outputTokens * turns).toLocaleString()} tokens)`,
        `  ─────────────────────────────────────`,
        `  PROJECTED TOTAL: $${est.totalUSD}`,
      ];
      return lines.join('\n');
    },

    recommend_models: async ({ budgetUSD, turns = 100, inputTokens = 5000, outputTokens = 1500, task, tier, maxResults = 10 } = {}) => {
      const models = await catalog();
      let candidates = models.filter((m) => !m.local); // skip local for cost recs

      if (tier) candidates = candidates.filter((m) => m.costTier === tier);

      if (task) {
        const taskLower = String(task).toLowerCase();
        candidates = candidates.filter((m) => {
          const caps = (m.capabilities || []).join(' ').toLowerCase();
          const blob = [m.id, m.modelName, m.family, caps].join(' ').toLowerCase();
          return blob.includes(taskLower.replace(/[^a-z0-9]+/g, ''));
        });
      }

      // Compute projected cost for each candidate
      const withCosts = candidates.map((m) => {
        const est = estimateCost(m, { inputTokens, outputTokens, turns });
        return { model: m, est };
      });

      // Filter to those within budget
      const affordable = withCosts.filter((x) => x.est.totalUSD <= budgetUSD);

      // Sort by best value: cheaper + more capable is better. Use a simple
      // score: capabilities count / cost. Free models rank high.
      affordable.sort((a, b) => {
        const capA = (a.model.capabilities || []).length;
        const capB = (b.model.capabilities || []).length;
        const costA = a.est.totalUSD || 0.0001;
        const costB = b.est.totalUSD || 0.0001;
        return (capB / costB) - (capA / costA);
      });

      if (!affordable.length) {
        const cheapest = sortByCost(withCosts.map((x) => x.model)).slice(0, 5);
        const lines = [
          `No models fit your budget of $${budgetUSD} for ${turns} turns × ${inputTokens}/${outputTokens} tokens.`,
          `Cheapest available:`,
          ...cheapest.map((m) => {
            const est = estimateCost(m, { inputTokens, outputTokens, turns });
            return `  ${m.id} — $${est.totalUSD} (${m.costTier})`;
          }),
        ];
        return lines.join('\n');
      }

      const lines = [
        `Recommended models for a $${budgetUSD} budget`,
        `  Usage: ${turns} turns × ${inputTokens} in / ${outputTokens} out tokens per turn`,
        `  ${affordable.length} model(s) fit the budget (showing top ${Math.min(maxResults, affordable.length)}):`,
        '',
      ];
      for (const { model: m, est } of affordable.slice(0, maxResults)) {
        const caps = (m.capabilities || []).length ? ` [${m.capabilities.join(',')}]` : '';
        lines.push(`  ${m.id}${caps}`);
        lines.push(`    tier: ${m.costTier}  |  $${m.pricePerMTokens?.input || 0}/$${m.pricePerMTokens?.output || 0} per 1M tok  |  total: $${est.totalUSD}`);
      }
      return lines.join('\n');
    },
  };
}

module.exports = { MODEL_DEFS, makeExecutors };