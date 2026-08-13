// Project-level cost & time tracker. Aggregates across all sessions for a project.
// Lives in ~/.voidcode/projects/<project-slug>-<hash>/cost.json

const fs = require('fs');
const path = require('path');
const { projectDir } = require('./sessions');

function costFile(cwd) {
  return path.join(projectDir(cwd), 'cost.json');
}

function load(cwd) {
  try {
    return JSON.parse(fs.readFileSync(costFile(cwd), 'utf8'));
  } catch {
    return { sessions: 0, totalCost: 0, totalActiveTimeMs: 0, totalInputTokens: 0, totalOutputTokens: 0, totalTurns: 0, lastUpdated: null };
  }
}

function save(cwd, data) {
  fs.mkdirSync(path.dirname(costFile(cwd)), { recursive: true });
  fs.writeFileSync(costFile(cwd), JSON.stringify(data, null, 2), 'utf8');
}

// Called after every session save to update the rolling aggregate.
function syncFromSession(cwd, session) {
  const agg = load(cwd);
  agg.sessions += 1;
  agg.totalCost += session.usage.cost || 0;
  agg.totalActiveTimeMs += session.usage.activeTimeMs || 0;
  agg.totalInputTokens += session.usage.input || 0;
  agg.totalOutputTokens += session.usage.output || 0;
  agg.totalTurns += session.usage.turns || 0;
  agg.lastUpdated = new Date().toISOString();
  save(cwd, agg);
  return agg;
}

// Rebuild aggregates from all saved session files (for data integrity).
function rebuildFromSessions(cwd) {
  const agg = { sessions: 0, totalCost: 0, totalActiveTimeMs: 0, totalInputTokens: 0, totalOutputTokens: 0, totalTurns: 0, lastUpdated: new Date().toISOString() };
  const dir = projectDir(cwd);
  if (!fs.existsSync(dir)) return agg;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'cost.json');
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const u = data.usage || {};
      agg.sessions += 1;
      agg.totalCost += u.cost || 0;
      agg.totalActiveTimeMs += u.activeTimeMs || 0;
      agg.totalInputTokens += u.input || 0;
      agg.totalOutputTokens += u.output || 0;
      agg.totalTurns += u.turns || 0;
    } catch { /* skip corrupt */ }
  }
  save(cwd, agg);
  return agg;
}

function formatDuration(ms) {
  if (!ms || ms < 1000) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  return parts.join(' ') || '0s';
}

function formatCost(cost) {
  if (!cost || cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(6)}`;
  return `$${cost.toFixed(4)}`;
}

module.exports = { load, save, syncFromSession, rebuildFromSessions, formatDuration, formatCost };