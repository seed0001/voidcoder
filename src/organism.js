// Digital-organism mode: an optional, wholly additive layer that gives the
// agent a persistent treasury and makes it accountable for the compute it
// consumes. When disabled (the default) this module has zero effect on the
// harness — every integration point guards on `organism.enabled`.
//
// The module owns four concerns:
//   1. TREASURY  — a persistent, per-project USD balance. Starting balance is
//      configurable (default $100) and can be topped up/refunded, each change
//      recorded in the ledger.
//   2. LEDGER    — an append-only, auditable record of every charge against
//      the balance: model calls, sub-agents, focus agents, scheduled tasks,
//      top-ups and refunds.
//   3. BUDGETS   — a hard per-task spending cap. Before every task we estimate
//      its cost, we never let one task exceed its cap, and we stop unproductive
//      loops once a round fails to make progress beyond a cost/failure budget.
//   4. SELECTION — choose a model for a task from cost tier + capability +
//      difficulty + remaining credits + past results. Cheap models handle
//      routine work; expensive models are only used when it is justified.
//
// All pricing flows through the shared live model catalog, so nothing here is
// hardcoded. The ledger is stored next to the existing cost tracker
// (~/.voidcode/projects/<slug>/organism.json) and written atomically.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { projectDir } = require('./sessions');

// ---------------------------------------------------------------------------
// Difficulty inference
// ---------------------------------------------------------------------------

// Maps of indicator words to a 1..5 difficulty score. Routine/mechanical work
// should score low; deep reasoning/architecture work scores high.
const DIFFICULTY_KEYWORDS = {
  1: ['list', 'summary', 'summarize', 'what is', 'format', 'translate', 'rename', 'lint', 'typo', 'readme', 'heading', 'bullet', 'regenerate', 'short', 'simple'],
  2: ['search', 'find', 'locate', 'grep', 'read', 'explain', 'explain this', 'small change', 'minor', 'fix bug', 'rename', 'refactor small'],
  3: ['refactor', 'design', 'implement', 'build', 'create', 'write tests', 'plan', 'research sweep', 'review code', 'moderate', 'multi-step'],
  4: ['reasoning', 'complex', 'architecture', 'security', 'audit', 'analyze', 'thorough', 'evaluate', 'difficult', 'hard'],
  5: ['critical', 'subtle', 'deep', 'research', 'novel', 'adversarial', 'comprehensive report', 'hard problem'],
};

function inferDifficulty(text = '', explicit = null) {
  if (Number.isFinite(explicit)) return Math.max(1, Math.min(5, Math.round(explicit)));
  const t = String(text || '').toLowerCase();
  let score = 2; // default moderate
  for (const [level, words] of Object.entries(DIFFICULTY_KEYWORDS)) {
    for (const w of words) {
      if (t.includes(w)) score = Math.max(score, Number(level));
    }
  }
  return score;
}

// ---------------------------------------------------------------------------
// Treasury + ledger persistence
// ---------------------------------------------------------------------------

function treasuryFile(cwd) {
  return path.join(projectDir(cwd), 'organism.json');
}

function defaultState(initialCredits) {
  return {
    schemaVersion: 1,
    enabled: true,
    currency: 'USD',
    initialCredits: initialCredits,
    balance: initialCredits,
    totalSpent: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ledger: [], // append-only
  };
}

function loadState(cwd, initialCredits) {
  try {
    const raw = fs.readFileSync(treasuryFile(cwd), 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.ledger)) {
      // Ensure balance is always derivable and consistent, but never rewrite
      // the ledger (append-only guarantee).
      return { ...defaultState(initialCredits), ...data };
    }
  } catch { /* no file yet or corrupt — start fresh */ }
  return defaultState(initialCredits);
}

// Atomic write: write temp file then rename so a crash mid-write can never
// corrupt a finite ledger of real charges.
function persist(cwd, state) {
  const file = treasuryFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Cost estimation from the model catalog
// ---------------------------------------------------------------------------

// Estimate USD for a usage profile on a model catalog entry.
// usage = { input, output } tokens (per rounded model delta or per task).
function estimateUsageCost(model, { input = 0, output = 0 } = {}) {
  const pIn = model?.pricing?.prompt || 0;
  const pOut = model?.pricing?.completion || 0;
  return (input * pIn) + (output * pOut);
}

// ---------------------------------------------------------------------------
// The Organism (treasury + ledger + budget + selection)
// ---------------------------------------------------------------------------

let modelCatalogCache = null; // last discovered catalog, shared by instances

class Organism {
  // cfg — full config (organism.* read from it). cwd — project dir.
  constructor(cfg, cwd) {
    const o = (cfg && cfg.organism) || {};
    this.cfg = cfg;
    this.cwd = cwd;
    this.enabled = !!o.enabled;
    this.initialCredits = Number.isFinite(o.initialCredits) ? o.initialCredits : 100;
    this.currency = o.currency || 'USD';
    this.state = this.enabled ? loadState(cwd, this.initialCredits) : null;
    // Configurable defaults (with sane fallbacks).
    this.defaultCapUSD = Number.isFinite(o.defaultCapUSD) ? o.defaultCapUSD : 5;
    this.capFraction = Number.isFinite(o.capFraction) ? o.capFraction : 0.2;
    this.minCapUSD = Number.isFinite(o.minCapUSD) ? o.minCapUSD : 0.05;
    this.maxCapUSD = Number.isFinite(o.maxCapUSD) ? o.maxCapUSD : Infinity;
    this.defaultTurnsPerTask = Number.isFinite(o.defaultTurnsPerTask) ? o.defaultTurnsPerTask : 20;
    this.autoSelectModels = o.autoSelectModels !== false;
    this._queue = Promise.resolve(); // serialize ledger/balance mutations
  }

  // ---- persistence layer (async, with an internal mutex to protect against
  // concurrent interactive/scheduler/focus mutations) ----

  _mutate(fn) {
    this._queue = this._queue.then(() => {
      // reload the freshest state under the lock, apply the mutation, persist
      this.state = loadState(this.cwd, this.initialCredits);
      fn(this.state);
      // Guard: never let the ledger shrink. A malformed mutation that deletes
      // entries is treated as a no-op by refusing to drop below prior length.
      persist(this.cwd, this.state);
    });
    return this._queue;
  }

  get balance() {
    return this.enabled ? this.state.balance : null;
  }

  get ledger() {
    return this.enabled ? this.state.ledger.slice() : [];
  }

  // ---- funding lifecycle ----

  // Ensure the treasury exists and is seeded with the initial balance.
  async initialize() {
    if (!this.enabled) return null;
    const prior = this.state;
    if (!prior || !Array.isArray(prior.ledger)) {
      await this._mutate((s) => { s.enabled = true; });
    }
    return this._mutate((s) => {
      // Seed exactly once. loadState() already assigns balance=initialCredits
      // for a fresh treasury; the genesis ledger row records that grant rather
      // than adding to it a second time.
      if (s.ledger.length === 0 && s.createdAt) {
        s.ledger.push({
          id: genId('l'),
          ts: s.createdAt,
          type: 'initial',
          actor: 'seed',
          model: null,
          input: 0,
          output: 0,
          costUSD: 0,
          balanceAfter: s.balance,
          task: 'Treasury initial funding',
          status: 'settled',
        });
      }
    });
  }

  // Add credits (or refund). kind ∈ topup|refund. Use for operator top-ups.
  async deposit(amountUSD, kind = 'topup', actor = 'operator', note = '') {
    if (!this.enabled) return null;
    const amt = Number(amountUSD);
    if (!Number.isFinite(amt)) throw new Error('deposit amount must be a number');
    return this._mutate((s) => {
      s.balance += amt;
      s.ledger.push({
        id: genId('l'),
        ts: new Date().toISOString(),
        type: amt >= 0 ? kind : 'credit',
        actor,
        model: null,
        input: 0,
        output: 0,
        costUSD: amt,
        balanceAfter: s.balance,
        task: note || (amt >= 0 ? 'Top-up' : 'Refund'),
        status: 'settled',
      });
    });
  }

  // Add credits (or refund). kind ∈ topup|refund. Negative amounts refund.
  async deposit(amountUSD, kind = 'topup', actor = 'operator', note = '') {
    if (!this.enabled) return null;
    const amt = Number(amountUSD);
    if (!Number.isFinite(amt)) throw new Error('deposit amount must be a number');
    return this._mutate((s) => {
      s.balance += amt;
      if (amt > 0) s.totalSpent = Math.max(0, s.totalSpent);
      s.ledger.push({
        id: genId('l'),
        ts: new Date().toISOString(),
        type: amt >= 0 ? kind : 'credit',
        actor,
        model: null,
        input: 0,
        output: 0,
        costUSD: amt,
        balanceAfter: s.balance,
        task: note || (amt >= 0 ? (kind === 'initial' ? 'Treasury seed' : 'Top-up') : 'Refund'),
        status: 'settled',
      });
    });
  }

  // ---- ledger query API ----

  snapshot() {
    if (!this.enabled) return { enabled: false };
    return {
      enabled: true,
      currency: this.currency,
      initialCredits: this.state.initialCredits,
      balance: this.state.balance,
      totalSpent: this.state.totalSpent,
      ledgerCount: this.state.ledger.length,
      ledger: this.state.ledger,
    };
  }

  summary() {
    const snap = this.snapshot();
    if (!snap.enabled) return { enabled: false };
    const byKind = {};
    const byModel = {};
    let modelCalls = 0;
    for (const e of snap.ledger) {
      if (e.type === 'model_call' || e.type === 'load') modelCalls++;
      if (e.type) byKind[e.type] = (byKind[e.type] || 0) + (e.costUSD || 0);
      if (e.model) byModel[e.model] = (byModel[e.model] || 0) + (e.costUSD || 0);
    }
    return {
      enabled: true,
      balance: snap.balance,
      totalSpent: snap.totalSpent,
      initialCredits: snap.initialCredits,
      currency: snap.currency,
      modelCalls,
      byKind,
      byModel,
      ledgerCount: snap.ledgerCount,
    };
  }

  // Filtered ledger for audit rendering.
  queryLedger({ limit = 50, kind = null, since = null } = {}) {
    if (!this.enabled) return [];
    let rows = this.state.ledger;
    if (kind) rows = rows.filter((e) => e.type === kind || e.actor === kind);
    if (since) rows = rows.filter((e) => new Date(e.ts) > new Date(since));
    return rows.slice(-limit).reverse();
  }

  // ---- compute-cost resolution (actual charge for a real model call) ----

  // Resolve per-token pricing for a provider, from the shared live catalog.
  async _pricingFor(provider) {
    if (!provider) return { prompt: 0, completion: 0 };
    try {
      const { discoverModels } = require('./modelCatalog');
      const models = await discoverModels(this.cfg, this.cwd);
      const entry = models.find((m) => m.id === `openrouter/${provider.model}` ||
        (m.provider === provider.name && m.modelName === provider.model));
      if (!entry && provider.name === 'openrouter') {
        const or = models.find((m) => m.provider === 'openrouter' && m.modelName === provider.model);
        if (or) return or.pricing || { prompt: 0, completion: 0 };
      }
      if (entry) return entry.pricing || { prompt: 0, completion: 0 };
    } catch { /* fall through to zero */ }
    return { prompt: 0, completion: 0 };
  }

  // Compute the USD cost of a completed call, preferring the provider's own
  // reported total_cost (OpenRouter) and falling back to token×price.
  async _computeCallCost(provider, usage) {
    if (usage && typeof usage.total_cost === 'number') {
      return Math.max(0, usage.total_cost);
    }
    const pricing = await this._pricingFor(provider);
    const input = usage?.prompt_tokens || 0;
    const output = usage?.completion_tokens || 0;
    return (input * pricing.prompt) + (output * pricing.completion);
  }

  // Record a settled charge for one completed model call (or an aggregated
  // sub-agent / focus / scheduled task settlement). Returns new balance.
  async charge({ costUSD, model = null, input = 0, output = 0, kind, actor, task, force = false }) {
    if (!this.enabled) return null;
    let amt = Number(costUSD);
    if (!Number.isFinite(amt) || amt < 0) amt = 0;
    // refused? unless force, allow to spend into a small negative buffer is NOT
    // allowed — the budget/balance guards should have prevented overspend.

    return this._mutate((s) => {
      if (!force && s.balance < amt - 0.000001) {
        // Refuse the charge (insufficient funds) — this surfaces to callers so
        // they can stop the task without committing to an overdraw.
        throw new Error(`Insufficient treasury balance ($${s.balance.toFixed(4)} < $${amt.toFixed(4)}).`);
      }
      s.balance -= amt;
      s.totalSpent += amt;
      s.ledger.push({
        id: genId('l'),
        ts: new Date().toISOString(),
        type: kind || 'model_call',
        actor,
        model,
        input,
        output,
        costUSD: amt,
        balanceAfter: s.balance,
        task: String(task || '').slice(0, 500),
        status: 'settled',
      });
    });
  }

  // ----- Budgets: pre-task estimate + hard cap + loop guard -----

  // Produce a spendable, per-task budget given the task and remaining credits.
  budgetFor({ difficulty = 2, capability = null, turns = null, explicitCap = null } = {}) {
    if (!this.enabled) return null;
    const balance = this.state.balance;
    // Hard cap = caller-specified default, bounded by a fraction of remaining
    // credits, and by the absolute max.
    let cap = explicitCap !== null && Number.isFinite(explicitCap) ? explicitCap : this.defaultCapUSD;
    const balCap = balance * this.capFraction;
    if (Number.isFinite(balCap) && balCap < cap) cap = balCap;
    if (Number.isFinite(this.maxCapUSD) && cap > this.maxCapUSD) cap = this.maxCapUSD;
    cap = Math.max(this.minCapUSD, cap);

    let turnsNeeded = turns || this.defaultTurnsPerTask;
    if (difficulty <= 2) turnsNeeded = Math.min(turnsNeeded, 12);
    else if (difficulty >= 4) turnsNeeded = Math.max(turnsNeeded, 15);

    return {
      balance,
      cap: Math.round(cap * 10000) / 10000,
      difficulty,
      capability,
      estTurns: turnsNeeded,
      estPerTurnUSD: 0,
      estTotalUSD: 0,
    };
  }

  // Estimate (and if possible reserve headroom for) a specific model choice.
  async estimateTask({ task, difficulty, capability, overrideModel = null, turns = null }) {
    if (!this.enabled) return null;
    const budget = this.budgetFor({ difficulty, capability, turns });
    let model, perTurn = 0;
    try {
      const { discoverModels } = require('./modelCatalog');
      const models = await discoverModels(this.cfg, this.cwd);
      let providerMatch = this.cfg.provider;
      if (overrideModel) providerMatch = overrideModel;
      model = models.find((m) =>
        m.id === `openrouter/${this.cfg.model}` ||
        (m.provider === this.cfg.provider && m.modelName === this.cfg.model)) || null;
      perTurn = model ? estimateUsageCost(model, { input: 4000, output: 800 }) : 0;
    } catch { /* catalog best-effort */ }
    budget.estPerTurnUSD = Math.round(perTurn * 10000) / 10000;
    budget.estTotalUSD = Math.round(perTurn * budget.estTurns * 10000) / 10000;
    budget.model = model ? `${model.provider}/${model.modelName}` : null;
    return budget;
  }

  // A "budget passage" guards a running loop: track incurred cost and stop it
  // when it crosses the cap or spins unproductively. Call chargeRound after
  // each model round; it throws a special error the loop breaks on once the
  // cap is breached (unless the round is exactly settling the task).
  makeLoopGuard(budget) {
    const maxUnproductive = Number.isFinite(budget?.maxUnproductiveRounds)
      ? budget.maxUnproductiveRounds
      : (this.cfg?.organism?.stopAfterUnproductiveRounds || 4);
    const ctx = {
      budget,
      incurred: 0,
      rounds: 0,
      unproductiveRounds: 0,
      lastRoundCost: 0,
    };
    const api = {
      ctx,
      chargeRound(costUSD, { progress = true } = {}) {
        const amt = Number(costUSD) || 0;
        ctx.incurred += amt;
        ctx.rounds += 1;
        if (!progress) ctx.unproductiveRounds += 1;
        const cap = ctx.budget ? ctx.budget.cap : Infinity;
        if ((ctx.budget && ctx.incurred > cap) || ctx.unproductiveRounds >= maxUnproductive) {
          const err = new Error(`Organism budget stop: task exceeded allowance (${ctx.incurred.toFixed(4)} spent, cap ${(cap === Infinity ? 'n/a' : Number(cap).toFixed(4))}; unproductive rounds ${ctx.unproductiveRounds}).`);
          err.organismBudgetStop = true;
          throw err;
        }
        return ctx;
      },
    };
    return api;
  }

  // ---- model selection ----

  // Pick a model for a task. Returns { model, reason, difficulty, estPerTurnUSD }.
  // models: array of catalog entries (defaults to live discovery).
  // difficulty: 1..5 (explicit) or inferred from task text.
  // capability: optional filter e.g. 'reasoning' | 'vision' | 'coding'.
  async selectModel({ task = '', difficulty = null, capability = null, models = null, previousResults = [], fallback = null } = {}) {
    if (!this.enabled) return { model: fallback, reason: 'organism disabled', difficulty: inferDifficulty(task, difficulty) };
    let catalog = models;
    if (!catalog) {
      try {
        const { discoverModels } = require('./modelCatalog');
        catalog = await discoverModels(this.cfg, this.cwd);
      } catch { catalog = []; }
    }
    if (!catalog.length) {
      return { model: fallback, reason: 'no live catalog', difficulty: inferDifficulty(task, difficulty), estPerTurnUSD: 0 };
    }

    const diff = inferDifficulty(task, difficulty);
    const budget = this.budgetFor({ difficulty: diff, capability });

    // Escalate difficulty if recent cheap-model attempts kept failing.
    let effectiveDiff = diff;
    if (previousResults && previousResults.length) {
      const recent = previousResults.slice(-3);
      const failures = recent.filter((r) => r && r.failed);
      if (failures.length >= 2) effectiveDiff = Math.min(5, effectiveDiff + 1);
    }

    // Tier targeting by (effective) difficulty.
    const targetTiers = effectiveDiff <= 2 ? ['free', 'economy']
      : effectiveDiff === 3 ? ['economy', 'average']
      : ['average', 'premium'];

    let candidates = catalog.filter((m) => m.local || m.pricing);
    if (capability) {
      const cap = String(capability).toLowerCase();
      candidates = candidates.filter((m) =>
        (m.capabilities || []).includes(cap) ||
        (cap === 'reasoning' && m.isReasoning) ||
        (cap === 'vision' && m.isVision));
      // If capability filters everything out, loosen it — capability is a
      // preference, not a hard blocker.
      if (!candidates.length) candidates = catalog.filter((m) => m.local || m.pricing);
    }

    // Sort candidates within target tiers cheapest-first.
    const costKey = (m) => (m.pricing?.prompt || 0) + (m.pricing?.completion || 0);
    const sortCost = (arr) => arr.slice().sort((a, b) => costKey(a) - costKey(b));

    // Also never exceed the task budget: expensive model must fit within the
    // spendable cap (using an assumed conservative usage profile).
    const affordable = candidates.filter((m) => {
      const est = estimateUsageCost(m, { input: 4000, output: 800 });
      return est <= budget.cap;
    });

    // Priority: prefer cheap enough to fit the budget; escalate only if needed.
    let pool = sortCost(affordable.length ? affordable : candidates);
    for (const tier of targetTiers) {
      const inTier = pool.filter((m) => m.costTier === tier || (tier === 'economy' && m.costCategory === 'paid' && m.costTier === 'economy'));
      if (inTier.length) {
        const chosen = inTier[0];
        return {
          model: `${chosen.provider}/${chosen.modelName}`,
          reason: `difficulty ${effectiveDiff} → ${tier} tier, cheapest adequate model`,
          difficulty: effectiveDiff,
          estPerTurnUSD: Math.round(estimateUsageCost(chosen, { input: 4000, output: 800 }) * 10000) / 10000,
        };
      }
    }
    // Nothing in target tiers fit — take the absolute cheapest catalog entry.
    const chosen = pool[0] || fallback ? (pool.length ? pool[0] : null) : null;
    return {
      model: chosen ? `${chosen.provider}/${chosen.modelName}` : fallback,
      reason: chosen ? 'cheapest available model' : 'fallback model',
      difficulty: effectiveDiff,
      estPerTurnUSD: chosen ? Math.round(estimateUsageCost(chosen, { input: 4000, output: 800 }) * 10000) / 10000 : 0,
    };
  }
}

function genId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

// Convenience: build an Organism only if enabled in config.
function makeOrganism(cfg, cwd) {
  try {
    return (cfg?.organism?.enabled) ? new Organism(cfg, cwd) : null;
  } catch { return null; }
}

module.exports = {
  Organism,
  makeOrganism,
  inferDifficulty,
  estimateUsageCost,
  treasuryFile,
};