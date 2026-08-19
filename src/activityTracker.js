// Cross-project daily activity aggregate — every session file under
// ~/.voidcode/projects/*/ contributes to a day's count (by local calendar
// date), regardless of which project it belongs to. Powers the GitHub-style
// contribution widget on the desktop (see app/renderer/app.js).
//
// A session's whole turn count is attributed to the day it was last updated
// (there's no per-turn timestamp to bucket by) — an approximation, but a
// working session almost always starts and ends the same day.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_ROOT = path.join(os.homedir(), '.voidcode', 'projects');

function dateKeyFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateKeyFromIso(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return dateKeyFromDate(d);
}

// dateKey -> { turns, sessions, activeTimeMs }
function buildDailyActivity() {
  const days = new Map();
  let dirs;
  try { dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()); }
  catch { return days; }

  for (const dirEnt of dirs) {
    const dir = path.join(PROJECTS_ROOT, dirEnt.name);
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'cost.json'); }
    catch { continue; }
    for (const f of files) {
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const key = dateKeyFromIso(data.updatedAt || data.createdAt);
      if (!key) continue;
      const usage = data.usage || {};
      const entry = days.get(key) || { turns: 0, sessions: 0, activeTimeMs: 0 };
      entry.turns += usage.turns || 0;
      entry.sessions += 1;
      entry.activeTimeMs += usage.activeTimeMs || 0;
      days.set(key, entry);
    }
  }
  return days;
}

// Builds a GitHub-style contribution grid: `weeks` full Sun-Sat columns
// ending on today. cells[i] is always a Sunday when i % 7 === 0, so the
// renderer can chunk the flat array into columns without recomputing
// day-of-week alignment.
function summary({ weeks = 20 } = {}) {
  const daily = buildDailyActivity();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (weeks * 7 - 1));
  start.setDate(start.getDate() - start.getDay()); // snap back to the Sunday on/before start

  const cells = [];
  const cursor = new Date(start);
  let maxTurns = 0;
  let activeDays = 0;
  let totalTurns = 0;
  const todayKey = dateKeyFromDate(today);
  while (cursor <= today) {
    const key = dateKeyFromDate(cursor);
    const entry = daily.get(key);
    const turns = entry?.turns || 0;
    if (turns > 0) { activeDays++; totalTurns += turns; if (turns > maxTurns) maxTurns = turns; }
    cells.push({ date: key, turns, activeTimeMs: entry?.activeTimeMs || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  // Current streak of consecutive active days ending today — but a quiet
  // "today" (no turns yet) doesn't break a streak that's still in progress.
  let streak = 0;
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i];
    if (c.date === todayKey && c.turns === 0) continue;
    if (c.turns > 0) streak++;
    else break;
  }

  const last7 = cells.slice(-7);
  const activeThisWeek = last7.filter((c) => c.turns > 0).length;

  return { cells, weeks, maxTurns, activeDays, streak, activeThisWeek, totalTurns };
}

module.exports = { summary, buildDailyActivity };
