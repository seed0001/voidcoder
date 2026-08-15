// Portfolio registry: the projects under autonomous management. Additive/
// no-op when empty — reconcileScheduledSweeps() simply has nothing to do.
// Reuses the existing Scheduler/schedule.json machinery (src/schedule.js)
// rather than a bespoke autonomy engine: each enabled project gets exactly
// one tagged (source: 'portfolio-sweep') scheduled task.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const schedule = require('../schedule');
const { buildSweepPrompt } = require('./sweepPrompt');

const PORTFOLIO_FILE = path.join(os.homedir(), '.voidcode', 'portfolio.json');

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8'));
    if (data && Array.isArray(data.projects)) return data;
  } catch { /* no file yet or corrupt — start fresh */ }
  return { projects: [] };
}

function save(data) {
  fs.mkdirSync(path.dirname(PORTFOLIO_FILE), { recursive: true });
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function newId() {
  return 'p-' + crypto.randomBytes(4).toString('hex');
}

function addProject({ name, path: projectPath, monetizationGoal = '', cadenceMinutes, reportChannelId = '' }) {
  const data = load();
  if (data.projects.some((p) => p.path === projectPath)) {
    throw new Error(`"${projectPath}" is already registered.`);
  }
  const project = {
    id: newId(),
    name: name || path.basename(projectPath),
    path: projectPath,
    monetizationGoal,
    cadenceMinutes: Number.isFinite(cadenceMinutes) ? cadenceMinutes : null, // null = use cfg default
    reportChannelId,
    enabled: true,
    addedAt: new Date().toISOString(),
  };
  data.projects.push(project);
  save(data);
  return project;
}

function removeProject(id) {
  const data = load();
  const idx = data.projects.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`No portfolio project with id "${id}"`);
  const removed = data.projects.splice(idx, 1)[0];
  save(data);
  return removed;
}

function setEnabled(id, enabled) {
  const data = load();
  const project = data.projects.find((p) => p.id === id);
  if (!project) throw new Error(`No portfolio project with id "${id}"`);
  project.enabled = enabled;
  save(data);
  return project;
}

function listProjects() {
  return load().projects;
}

// Idempotent: ensures exactly one 'portfolio-sweep' schedule.json task exists
// per enabled project (adds if missing, updates cadence if changed, removes
// if the project was deregistered/disabled). Safe to call on daemon start
// and after every portfolio mutation.
function reconcileScheduledSweeps(cfg) {
  const projects = listProjects();
  const sweepTasks = schedule.listTasksBySource('portfolio-sweep');
  const byProjectId = new Map(sweepTasks.map((t) => [t.title.match(/\[(p-[0-9a-f]+)\]/)?.[1], t]));

  for (const project of projects) {
    const existing = byProjectId.get(project.id);
    const cadence = project.cadenceMinutes || cfg.discord.portfolio.defaultCadenceMinutes;

    if (!project.enabled) {
      if (existing) schedule.removeTask(existing.id);
      continue;
    }

    if (!existing) {
      schedule.addTask({
        title: `portfolio sweep: ${project.name} [${project.id}]`,
        prompt: buildSweepPrompt(project),
        interval: cadence,
        autonomyLevel: cfg.discord.portfolio.defaultAutonomyLevel,
        source: 'portfolio-sweep',
        projectPath: project.path,
      });
    } else if (existing.interval !== cadence) {
      schedule.updateTask(existing.id, { interval: cadence });
    }
  }

  // Remove sweep tasks for projects no longer registered at all.
  const liveIds = new Set(projects.map((p) => p.id));
  for (const [projectId, task] of byProjectId) {
    if (projectId && !liveIds.has(projectId)) schedule.removeTask(task.id);
  }
}

// Which channel a given scheduled task's sweep results should post to:
// the project's own override, else the global report channel.
function reportChannelForTask(task, cfg) {
  const projectId = task.title?.match(/\[(p-[0-9a-f]+)\]/)?.[1];
  const project = listProjects().find((p) => p.id === projectId);
  return project?.reportChannelId || cfg.discord.reportChannelId;
}

module.exports = {
  addProject, removeProject, setEnabled, listProjects, reconcileScheduledSweeps, reportChannelForTask, PORTFOLIO_FILE,
};
