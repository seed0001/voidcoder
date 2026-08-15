// Unit tests for src/discord/portfolio.js. Redirects HOME/USERPROFILE to a
// throwaway temp dir before requiring portfolio.js (and transitively
// schedule.js) so this never touches the real ~/.voidcode/portfolio.json or
// ~/.voidcode/schedule.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'voidcode-portfolio-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const portfolio = require('../../src/discord/portfolio');
const schedule = require('../../src/schedule');
const { DEFAULTS } = require('../../src/config');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${err.message}`); }
}

const cfg = { ...DEFAULTS, discord: { ...DEFAULTS.discord, reportChannelId: 'chan-default' } };

check('addProject/listProjects/removeProject round-trip', () => {
  const p = portfolio.addProject({ name: 'Demo', path: '/tmp/demo-project' });
  assert.strictEqual(portfolio.listProjects().length, 1);
  assert.strictEqual(portfolio.listProjects()[0].name, 'Demo');
  portfolio.removeProject(p.id);
  assert.strictEqual(portfolio.listProjects().length, 0);
});

check('addProject rejects a duplicate path', () => {
  portfolio.addProject({ name: 'A', path: '/tmp/dup' });
  assert.throws(() => portfolio.addProject({ name: 'B', path: '/tmp/dup' }), /already registered/);
});

check('reconcileScheduledSweeps is idempotent — one task per enabled project', () => {
  portfolio.reconcileScheduledSweeps(cfg);
  const first = schedule.listTasksBySource('portfolio-sweep').length;
  portfolio.reconcileScheduledSweeps(cfg);
  const second = schedule.listTasksBySource('portfolio-sweep').length;
  assert.strictEqual(first, second);
  assert.strictEqual(second, portfolio.listProjects().filter((p) => p.enabled).length);
});

check('disabling a project removes its scheduled sweep task', () => {
  const p = portfolio.addProject({ name: 'ToDisable', path: '/tmp/to-disable' });
  portfolio.reconcileScheduledSweeps(cfg);
  assert.ok(schedule.listTasksBySource('portfolio-sweep').some((t) => t.title.includes(p.id)));
  portfolio.setEnabled(p.id, false);
  portfolio.reconcileScheduledSweeps(cfg);
  assert.ok(!schedule.listTasksBySource('portfolio-sweep').some((t) => t.title.includes(p.id)));
});

check('reportChannelForTask falls back to the global report channel', () => {
  const p = portfolio.addProject({ name: 'NoOverride', path: '/tmp/no-override' });
  portfolio.reconcileScheduledSweeps(cfg);
  const task = schedule.listTasksBySource('portfolio-sweep').find((t) => t.title.includes(p.id));
  assert.strictEqual(portfolio.reportChannelForTask(task, cfg), 'chan-default');
});

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall portfolio tests passed');
process.exit(failures ? 1 : 0);
