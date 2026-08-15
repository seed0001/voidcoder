// Unit tests for the source/projectPath extension to src/schedule.js added
// for portfolio sweeps. Redirects HOME/USERPROFILE before requiring the
// module so this never touches the real ~/.voidcode/schedule.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'voidcode-schedule-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const schedule = require('../../src/schedule');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${err.message}`); }
}

check('addTask persists source and projectPath when given', () => {
  const task = schedule.addTask({ title: 'sweep', prompt: 'audit', interval: 60, source: 'portfolio-sweep', projectPath: '/tmp/proj' });
  assert.strictEqual(task.source, 'portfolio-sweep');
  assert.strictEqual(task.projectPath, '/tmp/proj');
  const reloaded = schedule.listTasks().find((t) => t.id === task.id);
  assert.strictEqual(reloaded.source, 'portfolio-sweep');
  assert.strictEqual(reloaded.projectPath, '/tmp/proj');
});

check('addTask omitting source/projectPath preserves prior behavior', () => {
  const task = schedule.addTask({ title: 'reminder', prompt: 'ping me', interval: 30 });
  assert.strictEqual(task.source, 'user');
  assert.strictEqual(task.projectPath, '');
});

check('listTasksBySource filters correctly', () => {
  const sweeps = schedule.listTasksBySource('portfolio-sweep');
  const userTasks = schedule.listTasksBySource('user');
  assert.ok(sweeps.every((t) => t.source === 'portfolio-sweep'));
  assert.ok(userTasks.every((t) => t.source === 'user'));
  assert.strictEqual(sweeps.length + userTasks.length, schedule.listTasks().length);
});

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall schedule field tests passed');
process.exit(failures ? 1 : 0);
