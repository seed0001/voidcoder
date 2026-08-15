// Live model catalog: ONE shared source of truth for every process (CLI,
// desktop agent, tools, UI). Merges the stored models.json registry with the
// *live* OpenRouter catalog and the models actually installed on this machine
// (Ollama, llama.cpp server). Nothing here is hardcoded or stubbed.

const { ModelRegistry } = require('./config');

const OPENROUTER_CATALOG = 'https://openrouter.ai/api/v1/models';

let cache = { key: '', ts: 0, models: null };
const CACHE_TTL = 30000;

async function fetchJson(url, opts = {}, ms = 8000) {
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function familyOf(modelName) {
  const n = String(modelName || '');
  return n.split(/[:/]/)[0] || n;
}

// Attach display metadata to every entry (family + normalized id + pricing + tier).
function decorate(m) {
  const pricing = m.pricing || {};
  const promptPrice = Number(pricing.prompt) || 0;
  const completionPrice = Number(pricing.completion) || 0;
  const isFree = promptPrice === 0 && completionPrice === 0;
  const isLocal = m.provider === 'ollama' || m.provider === 'llamacpp';
  const isVision = (m.capabilities || []).includes('vision') || (m.inputModalities || []).includes('image');

  return {
    id: m.id,
    provider: m.provider || 'unknown',
    modelName: m.modelName || m.id,
    baseUrl: m.baseUrl || '',
    costCategory: m.costCategory || (isLocal ? 'free' : (isFree ? 'free' : 'paid')),
    costTier: m.costTier || classifyTier(promptPrice, completionPrice, isLocal),
    capabilities: m.capabilities || [],
    contextTokens: Number.isFinite(m.contextTokens) ? m.contextTokens : 0,
    family: familyOf(m.modelName || m.id),
    local: isLocal,
    live: !!m.live,
    // Pricing per token (USD), as returned by the OpenRouter API.
    pricing: { prompt: promptPrice, completion: completionPrice },
    // Pricing per 1M tokens (USD) — human-readable, what providers quote.
    pricePerMTokens: {
      input: +(promptPrice * 1e6).toFixed(4),
      output: +(completionPrice * 1e6).toFixed(4),
    },
    created: m.created || null,
    inputModalities: m.inputModalities || [],
    isVision,
    isReasoning: (m.capabilities || []).includes('reasoning') || !!m.reasoning,
  };
}

// Classify a model into a cost tier based on per-token pricing.
// Thresholds are per 1M input tokens (USD):
//   free    — $0 (free models + local)
//   economy — under $1/1M
//   average — $1–$10/1M
//   premium — over $10/1M
// These map to the user's "generations": the newest top-provider models
// land in premium, previous gen in average, two-gens-back + low-end in economy.
function classifyTier(promptPrice, completionPrice, isLocal) {
  if (isLocal) return 'free';
  if (promptPrice === 0 && completionPrice === 0) return 'free';
  const perM = promptPrice * 1e6;
  if (perM < 1) return 'economy';
  if (perM <= 10) return 'average';
  return 'premium';
}

async function discoverModels(cfg, cwd = process.cwd()) {
  // Signature over every configured provider (baseUrl + whether a key is set)
  // so adding a provider or pasting in a key busts the cache, not just the
  // three hardcoded ones below.
  const providerSig = Object.entries(cfg.providers || {})
    .map(([name, p]) => `${name}:${p?.baseUrl || ''}:${p?.apiKey ? '1' : '0'}`)
    .sort()
    .join(',');
  const key = [cwd, providerSig].join('|');
  const now = Date.now();
  if (cache.key === key && cache.ts && now - cache.ts < CACHE_TTL) return cache.models;

  const out = new Map(); // id -> entry (stored entries win on duplicate ids)

  const add = (m) => {
    if (!m?.id) return;
    const next = decorate(m);
    const previous = out.get(m.id);
    if (previous && m.live) {
      next.capabilities = [...new Set([...(previous.capabilities || []), ...(next.capabilities || [])])];
      next.costCategory = previous.costCategory || next.costCategory;
      next.contextTokens = next.contextTokens || previous.contextTokens || 0;
    }
    out.set(m.id, { existing: !!previous, ...next });
  };

  // 1) Stored registry (models.json) — explicit, user-authored choices.
  try {
    new ModelRegistry(cwd).getAll().forEach(add);
  } catch {}

  // 2) OpenRouter live catalog (with your key; free tier works unauth'd too).
  const orp = cfg.providers?.openrouter || {};
  const orKey = orp.apiKey || (process.env[orp.apiKeyEnv || ''] || '');
  const or = await fetchJson(OPENROUTER_CATALOG, orKey ? { headers: { Authorization: `Bearer ${orKey}` } } : {}, 8000);
  (or?.data || []).forEach((m) => {
    const inputModalities = m.architecture?.input_modalities || m.architecture?.inputModalities || [];
    const capabilities = [];
    if (inputModalities.includes('image')) capabilities.push('vision');
    if (inputModalities.includes('video')) capabilities.push('video');
    if (m.reasoning?.mandatory || m.reasoning?.default_enabled) capabilities.push('reasoning');
    add({
      id: `openrouter/${m.id}`,
      provider: 'openrouter',
      modelName: m.id,
      baseUrl: orp.baseUrl || 'https://openrouter.ai/api/v1',
      costCategory: (parseFloat(m.pricing?.prompt) > 0 || parseFloat(m.pricing?.completion) > 0) ? 'paid' : 'free',
      capabilities,
      contextTokens: Number(m.context_length) || 0,
      live: true,
      pricing: { prompt: parseFloat(m.pricing?.prompt) || 0, completion: parseFloat(m.pricing?.completion) || 0 },
      created: m.created || null,
      inputModalities,
      reasoning: m.reasoning,
    });
  });

  // 3) Ollama models currently pulled on this machine.
  const olBase = (cfg.providers?.ollama?.baseUrl || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '');
  const ol = await fetchJson(olBase + '/api/tags', {}, 2500);
  (ol?.models || []).forEach((m) => {
    add({ id: `ollama/${m.name}`, provider: 'ollama', modelName: m.name, baseUrl: cfg.providers?.ollama?.baseUrl || 'http://localhost:11434/v1', costCategory: 'free', live: true });
  });

  // 4) llama.cpp / LM Studio server (the GGUF loaded right now).
  const lcBase = (cfg.providers?.llamacpp?.baseUrl || 'http://localhost:8080/v1').replace(/\/+$/, '');
  const lc = await fetchJson(lcBase + '/models', {}, 2500);
  (lc?.data || []).forEach((m) => {
    const name = String(m.id);
    add({ id: `llamacpp/${name}`, provider: 'llamacpp', modelName: name, baseUrl: lcBase + '/v1', costCategory: 'free', live: true });
  });

  // 5) Any other configured OpenAI-compatible provider (a hosted router like
  // FairRouter, a self-hosted proxy, etc.) — query its /models endpoint the
  // same way. Nothing here is provider-specific: any entry added under
  // cfg.providers with a baseUrl gets discovered automatically.
  const KNOWN_PROVIDERS = new Set(['openrouter', 'ollama', 'llamacpp']);
  for (const [name, p] of Object.entries(cfg.providers || {})) {
    if (KNOWN_PROVIDERS.has(name) || !p?.baseUrl) continue;
    const base = p.baseUrl.replace(/\/+$/, '');
    const apiKey = p.apiKey || (process.env[p.apiKeyEnv || ''] || '');
    const list = await fetchJson(base + '/models', apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}, 5000);
    (list?.data || []).forEach((m) => {
      const modelName = String(m.id || m.name || '');
      if (!modelName) return;
      add({
        id: `${name}/${modelName}`,
        provider: name,
        modelName,
        baseUrl: p.baseUrl,
        costCategory: 'paid',
        contextTokens: Number(m.context_length || m.context_window) || 0,
        live: true,
      });
    });
  }

  const models = Array.from(out.values());
  cache = { key, ts: Date.now(), models };
  return models;
}

// Normalize "deepseek v3.2", "DeepSeek V3", "qwen2.5" -> compact slug for
// forgiving human-ish matching against ids/model names.
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Substring/family filter used by conversational tools.
function searchModels(models, query) {
  if (!query) return models;
  const q = slug(query);
  if (!q) return models;
  return models.filter((m) =>
    slug([m.id, m.modelName, m.provider, m.family, (m.capabilities || []).join(' ')].join(' ')).includes(q));
}

// Resolve a human-ish model reference to a provider/model string:
//   "deepseek v3"  -> provider/model found in the catalog
//   "ollama/llama3" -> already a provider/model string
// Resolves with a hint: { resolved, type, hits } or null when nothing matches.
async function resolveModelRef(cfg, cwd, modelId) {
  const ref = String(modelId || '').trim();
  if (!ref) return null;

  const models = await discoverModels(cfg, cwd);
  const exact = models.find((m) => m.id === ref);
  if (exact) return { resolved: `${exact.provider}/${exact.modelName}`, type: 'exact', hits: [exact] };

  const hits = searchModels(models, ref);
  if (hits.length === 1) return { resolved: `${hits[0].provider}/${hits[0].modelName}`, type: 'single', hits };
  if (hits.length > 1) return { resolved: `${hits[0].provider}/${hits[0].modelName}`, type: 'ambiguous', hits };

  // Direct provider/model syntax (e.g. ollama/llama3.2:latest, openrouter/anthropic/...)
  const firstSeg = ref.split('/')[0];
  if (cfg.providers?.[firstSeg]) {
    if (firstSeg === 'openrouter') {
      return null; // Bypassed and not in live catalog -> invalid model name
    }
    return { resolved: ref, type: 'provider', hits: [] };
  }

  return null;
}

// Existing simple API used elsewhere: provider/model string or null.
async function resolveModelString(cfg, cwd, modelId) {
  const r = await resolveModelRef(cfg, cwd, modelId);
  return r ? r.resolved : null;
}

// Sort models within a tier: cheapest first, most expensive last.
function sortByCost(models) {
  return models.slice().sort((a, b) => {
    const aCost = (a.pricing?.prompt || 0) + (a.pricing?.completion || 0);
    const bCost = (b.pricing?.prompt || 0) + (b.pricing?.completion || 0);
    return aCost - bCost;
  });
}

// Sort models by recency (newest first), using created timestamp then id.
function sortByRecency(models) {
  return models.slice().sort((a, b) => {
    if (a.created && b.created) return b.created - a.created;
    if (a.created) return -1;
    if (b.created) return 1;
    return String(a.id).localeCompare(String(b.id));
  });
}

// Group models into tier buckets. Vision-capable models appear in their cost
// tier AND are flagged isVision for the vision-only view.
function groupByTier(models) {
  const tiers = { free: [], economy: [], average: [], premium: [], vision: [] };
  for (const m of models) {
    const t = m.costTier || 'free';
    if (tiers[t]) tiers[t].push(m);
    if (m.isVision) tiers.vision.push(m);
  }
  return tiers;
}

// Estimate cost (USD) for a usage profile on a model.
// usage = { inputTokens, outputTokens, turns }
function estimateCost(model, usage = {}) {
  const { inputTokens = 0, outputTokens = 0, turns = 1 } = usage;
  const pIn = model.pricing?.prompt || 0;
  const pOut = model.pricing?.completion || 0;
  const perTurn = (inputTokens * pIn) + (outputTokens * pOut);
  return {
    perTurnUSD: +perTurn.toFixed(6),
    totalUSD: +(perTurn * turns).toFixed(6),
    inputCostUSD: +(inputTokens * pIn * turns).toFixed(6),
    outputCostUSD: +(outputTokens * pOut * turns).toFixed(6),
    inputTokensPerTurn: inputTokens,
    outputTokensPerTurn: outputTokens,
    turns,
  };
}

module.exports = { discoverModels, findModels: searchModels, resolveModelString, resolveModelRef, familyOf, classifyTier, sortByCost, sortByRecency, groupByTier, estimateCost };