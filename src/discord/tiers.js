// Tier logic: turns a Discord contact's tier into a real cfg object droppable
// straight into `new Permissions(derivedCfg, promptFn)` / `new Agent({cfg: derivedCfg, ...})`.
// 'owner' always gets the real configured cfg, unmodified. Every other tier
// is a deep-merge override defined in cfg.discord.tiers[tier] — add or rename
// tiers there; nothing else hardcodes tier names.

const { deepMerge } = require('../config');

function deriveCfgForTier(baseCfg, tier) {
  const tierCfg = baseCfg.discord?.tiers?.[tier];
  if (!tierCfg) throw new Error(`Unknown tier "${tier}"`);
  if (tier === 'owner' || tierCfg.useRealConfig) return baseCfg;
  const overrides = {};
  if (tierCfg.permissions) overrides.permissions = tierCfg.permissions;
  if (tierCfg.autonomyLevel !== undefined) overrides.autonomyLevel = tierCfg.autonomyLevel;
  return deepMerge(baseCfg, overrides);
}

// capName: 'canManageContacts' | 'canManagePortfolio' | 'canUseVoice' | 'toolsEnabled'
function tierCapability(tier, cfg, capName) {
  const tierCfg = cfg.discord?.tiers?.[tier];
  return !!tierCfg?.[capName];
}

// Compares two tiers by their explicit `rank` (low-to-high) so "minimum tier
// allowed" checks (e.g. voice.minTierAllowed) work regardless of how the
// tiers object is ordered/edited by the user.
function tierRank(tier, cfg) {
  const rank = cfg.discord?.tiers?.[tier]?.rank;
  return Number.isFinite(rank) ? rank : -1;
}

function meetsMinTier(tier, minTier, cfg) {
  if (tier === 'owner') return true;
  return tierRank(tier, cfg) >= tierRank(minTier, cfg);
}

module.exports = { deriveCfgForTier, tierCapability, tierRank, meetsMinTier };
