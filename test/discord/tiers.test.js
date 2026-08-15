// Unit tests for src/discord/tiers.js — pure logic, no filesystem, so no
// HOME/USERPROFILE isolation is needed here.

const assert = require('assert');
const { deriveCfgForTier, tierCapability, meetsMinTier } = require('../../src/discord/tiers');
const { DEFAULTS } = require('../../src/config');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${err.message}`); }
}

const cfg = { ...DEFAULTS, permissions: { bash: 'ask', write: 'allow', edit: 'allow', webfetch: 'allow' }, autonomyLevel: 'full' };

check('owner tier passes the real cfg through unchanged', () => {
  const derived = deriveCfgForTier(cfg, 'owner');
  assert.strictEqual(derived, cfg);
});

check('trusted tier denies bash/write/edit, allows webfetch, autonomy off', () => {
  const derived = deriveCfgForTier(cfg, 'trusted');
  assert.strictEqual(derived.permissions.bash, 'deny');
  assert.strictEqual(derived.permissions.write, 'deny');
  assert.strictEqual(derived.permissions.edit, 'deny');
  assert.strictEqual(derived.permissions.webfetch, 'allow');
  assert.strictEqual(derived.autonomyLevel, 'off');
});

check('guest tier denies everything including webfetch', () => {
  const derived = deriveCfgForTier(cfg, 'guest');
  assert.strictEqual(derived.permissions.bash, 'deny');
  assert.strictEqual(derived.permissions.write, 'deny');
  assert.strictEqual(derived.permissions.edit, 'deny');
  assert.strictEqual(derived.permissions.webfetch, 'deny');
});

check('deriving for trusted/guest never mutates the base cfg', () => {
  deriveCfgForTier(cfg, 'trusted');
  assert.strictEqual(cfg.permissions.bash, 'ask');
  assert.strictEqual(cfg.autonomyLevel, 'full');
});

check('tierCapability reads flags from cfg.discord.tiers', () => {
  assert.strictEqual(tierCapability('owner', cfg, 'canManageContacts'), true);
  assert.strictEqual(tierCapability('trusted', cfg, 'canManageContacts'), false);
  assert.strictEqual(tierCapability('guest', cfg, 'toolsEnabled'), false);
  assert.strictEqual(tierCapability('trusted', cfg, 'toolsEnabled'), true);
});

check('meetsMinTier respects declared rank (guest < trusted < owner)', () => {
  assert.strictEqual(meetsMinTier('guest', 'trusted', cfg), false);
  assert.strictEqual(meetsMinTier('trusted', 'trusted', cfg), true);
  assert.strictEqual(meetsMinTier('owner', 'trusted', cfg), true);
});

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall tiers tests passed');
process.exit(failures ? 1 : 0);
