// Schedule data store: persistent scheduled tasks.
// Lives in ~/.voidcode/schedule.json

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SCHEDULE_FILE = path.join(os.homedir(), '.voidcode', 'schedule.json');

const DEFAULTS = {
  tasks: [],
};

function load() {
  try {
    const raw = fs.readFileSync(SCHEDULE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { ...DEFAULTS, tasks: [] };
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(SCHEDULE_FILE), { recursive: true });
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

// Validate a simple cron expression: "min hour dom mon dow"
// Each field: * | num | num,num | num-num | */n
// Returns { valid, error }
function validateCron(expr) {
  if (!expr || typeof expr !== 'string') return { valid: false, error: 'Cron expression required' };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { valid: false, error: 'Expected 5 fields (min hour dom mon dow)' };
  const names = ['minute (0-59)', 'hour (0-23)', 'day-of-month (1-31)', 'month (1-12)', 'day-of-week (0-6, 0=Sun)'];
  const ranges = [
    [0, 59], [0, 23], [1, 31], [1, 12], [0, 6],
  ];
  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    if (field === '*') continue;
    // step: */n
    const stepMatch = field.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const n = parseInt(stepMatch[1], 10);
      if (n < 1 || n > ranges[i][1]) return { valid: false, error: `Invalid step in ${names[i]}: ${n}` };
      continue;
    }
    // comma-separated values and ranges
    const items = field.split(',');
    for (const item of items) {
      const rangeMatch = item.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const lo = parseInt(rangeMatch[1], 10);
        const hi = parseInt(rangeMatch[2], 10);
        if (lo < ranges[i][0] || hi > ranges[i][1] || lo > hi) {
          return { valid: false, error: `Invalid range in ${names[i]}: ${item}` };
        }
      } else {
        const val = parseInt(item, 10);
        if (isNaN(val) || val < ranges[i][0] || val > ranges[i][1]) {
          return { valid: false, error: `Invalid value in ${names[i]}: ${item}` };
        }
      }
    }
  }
  return { valid: true };
}

// Match a 5-field cron expression against a Date.
function cronMatches(expr, date) {
  const parts = expr.trim().split(/\s+/);
  const min = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay();
  const values = [min, hour, dom, mon, dow];
  for (let i = 0; i < 5; i++) {
    const field = parts[i];
    if (field === '*') continue;
    // step: */n
    const stepMatch = field.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const n = parseInt(stepMatch[1], 10);
      if (values[i] % n !== 0) return false;
      continue;
    }
    const items = field.split(',');
    let matched = false;
    for (const item of items) {
      const rangeMatch = item.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const lo = parseInt(rangeMatch[1], 10);
        const hi = parseInt(rangeMatch[2], 10);
        if (values[i] >= lo && values[i] <= hi) { matched = true; break; }
      } else {
        if (values[i] === parseInt(item, 10)) { matched = true; break; }
      }
    }
    if (!matched) return false;
  }
  return true;
}

// Calculate next run time from a cron expression (look ahead up to 366 days).
function nextRun(cronExpr, after = new Date()) {
  const probe = new Date(after);
  probe.setSeconds(0, 0);
  for (let i = 0; i < 525600; i++) { // up to 365 days ahead in minutes
    if (cronMatches(cronExpr, probe)) return new Date(probe);
    probe.setMinutes(probe.getMinutes() + 1);
  }
  return null;
}

// Simple interval-based schedule: run every N minutes.
function nextRunInterval(intervalMins, after = new Date()) {
  return new Date(after.getTime() + intervalMins * 60 * 1000);
}

function addTask({ title, prompt, cron, interval, autonomyLevel = 'safe', enabled = true, source = 'user', projectPath = '' }) {
  const data = load();
  const id = newId();
  const now = new Date();
  let next = null;
  if (cron) {
    const v = validateCron(cron);
    if (!v.valid) throw new Error(`Invalid cron: ${v.error}`);
    next = nextRun(cron, now);
  } else if (interval) {
    next = nextRunInterval(interval, now);
  } else {
    throw new Error('Either cron expression or interval (minutes) is required');
  }
  const task = {
    id,
    title: title || `Task ${id.slice(0, 6)}`,
    prompt,
    cron: cron || '',
    interval: interval || 0,
    autonomyLevel,
    enabled,
    // 'user' = created via the schedule tool by a person; 'portfolio-sweep' =
    // auto-managed by src/discord/portfolio.js's reconcileScheduledSweeps().
    // projectPath, when set, is the cwd this task's turn should run against —
    // omitted (default '') preserves prior behavior (whatever cwd the calling
    // process is bound to).
    source,
    projectPath,
    createdAt: now.toISOString(),
    lastRun: null,
    lastResult: null,
    nextRun: next ? next.toISOString() : null,
  };
  data.tasks.push(task);
  save(data);
  return task;
}

function updateTask(id, patch) {
  const data = load();
  const idx = data.tasks.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error(`No scheduled task with id "${id}"`);
  const task = data.tasks[idx];
  if (patch.title !== undefined) task.title = patch.title;
  if (patch.prompt !== undefined) task.prompt = patch.prompt;
  if (patch.autonomyLevel !== undefined) task.autonomyLevel = patch.autonomyLevel;
  if (patch.enabled !== undefined) task.enabled = patch.enabled;
  if (patch.cron !== undefined) {
    const v = validateCron(patch.cron);
    if (!v.valid) throw new Error(`Invalid cron: ${v.error}`);
    task.cron = patch.cron;
    task.interval = 0;
    task.nextRun = nextRun(task.cron)?.toISOString() || null;
  }
  if (patch.interval !== undefined) {
    task.interval = patch.interval;
    task.cron = '';
    task.nextRun = nextRunInterval(task.interval)?.toISOString() || null;
  }
  save(data);
  return task;
}

function removeTask(id) {
  const data = load();
  const idx = data.tasks.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error(`No scheduled task with id "${id}"`);
  const task = data.tasks.splice(idx, 1)[0];
  save(data);
  return task;
}

function listTasks() {
  const data = load();
  return data.tasks;
}

function listTasksBySource(source) {
  return load().tasks.filter((t) => (t.source || 'user') === source);
}

function getDueTasks() {
  const now = new Date();
  return load().tasks.filter((t) => t.enabled && t.nextRun && new Date(t.nextRun) <= now);
}

function markRan(id, result) {
  const data = load();
  const task = data.tasks.find((t) => t.id === id);
  if (!task) return;
  task.lastRun = new Date().toISOString();
  task.lastResult = String(result).slice(0, 5000);
  // Recalculate next run
  if (task.cron) {
    task.nextRun = nextRun(task.cron)?.toISOString() || null;
  } else if (task.interval > 0) {
    task.nextRun = nextRunInterval(task.interval)?.toISOString() || null;
  }
  save(data);
}

module.exports = {
  load, save, addTask, updateTask, removeTask, listTasks, listTasksBySource, getDueTasks, markRan,
  validateCron, cronMatches, nextRun, nextRunInterval,
};