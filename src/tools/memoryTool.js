// Project memory tool: persistent knowledge base per project.
// Stored in .voidcode-memory.md in the project root.
// The agent uses this to track architecture decisions, patterns, known issues,
// and any project context that should persist across sessions.

const fs = require('fs');
const path = require('path');
const { expand } = require('./fsTools');
const guardrails = require('../guardrails');

const MEMORY_FILE = '.voidcode-memory.md';

const defs = [
  {
    name: 'project_memory',
    description: 'Manage a persistent project memory file (.voidcode-memory.md). Use this to store architecture decisions, patterns, known issues, and other project context that should persist across sessions. Read it at the start of a new task, append findings/decisions as you work.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'append', 'overwrite'],
          description: 'read = return current memory; append = add to end; overwrite = replace entirely',
        },
        content: {
          type: 'string',
          description: 'text content for append or overwrite (omit for read)',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'log_lesson',
    description: 'Record a behavioral lesson in if/then form so future sessions remember it. Use this when you hit a wall, catch yourself drifting off-task, get a repeated error/empty search, or discover a fix you may need again. trigger = observed conditions (comma-separated keywords, all must appear, or /regex/); behavior = exactly what to do when the trigger recurs; category = focus|subagent|main|all.',
    parameters: {
      type: 'object',
      properties: {
        trigger: { type: 'string', description: 'observed conditions, e.g. "websearch, no results, minimax" or /^No search results/' },
        behavior: { type: 'string', description: 'one-line instruction to follow when the trigger occurs' },
        title: { type: 'string', description: 'short label (optional)' },
        category: { type: 'string', enum: ['all', 'main', 'subagent', 'focus'], description: 'which agent kind this applies to (default all)' },
      },
      required: ['trigger', 'behavior'],
    },
  },
  {
    name: 'list_lessons',
    description: 'List saved behavioral lessons (if trigger then behavior) from the learning memory.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'filter by category (all|main|subagent|focus)' },
      },
      required: [],
    },
  },
];

function memoryPath(cwd) {
  return path.join(cwd, MEMORY_FILE);
}

function readMemory(cwd) {
  const p = memoryPath(cwd);
  if (!fs.existsSync(p)) return '(memory is empty)';
  return fs.readFileSync(p, 'utf8');
}

// Programmatic append used by context retirement (src/contextRetirement.js)
// to persist durable facts extracted from a chunk about to be evicted from
// the active context window — same file/format the project_memory tool
// writes, just callable without going through a model tool call.
function appendMemory(cwd, content) {
  if (!content) return;
  const p = memoryPath(cwd);
  const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : `# Project Memory\n\n`;
  const updated = existing.endsWith('\n') ? existing + content + '\n' : existing + '\n' + content + '\n';
  fs.writeFileSync(p, updated, 'utf8');
}

function makeExecutors(ctx) {
  return {
    project_memory({ action, content }) {
      const p = memoryPath(ctx.cwd);
      switch (action) {
        case 'read': {
          return readMemory(ctx.cwd);
        }
        case 'append': {
          if (!content) throw new Error('content required for append');
          const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : `# Project Memory\n\n`;
          const updated = existing.endsWith('\n') ? existing + content + '\n' : existing + '\n' + content + '\n';
          fs.writeFileSync(p, updated, 'utf8');
          ctx.onFileChange?.(p, existing, updated);
          return `Appended to ${MEMORY_FILE} (${content.length} chars)`;
        }
        case 'overwrite': {
          if (!content) throw new Error('content required for overwrite');
          const before = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
          fs.writeFileSync(p, content, 'utf8');
          ctx.onFileChange?.(p, before, content);
          return `Wrote ${MEMORY_FILE} (${content.length} chars)`;
        }
        default:
          throw new Error(`unknown action "${action}"`);
      }
    },
    log_lesson({ trigger, behavior, title, category }) {
      const res = guardrails.recordLesson({
        title, trigger, behavior, category,
        maxLearnings: (ctx.cfg || {}).guardrails?.maxLearnings || 30,
      });
      return res.duplicated
        ? `Lesson already recorded for trigger "${trigger}" — ignoring duplicate.`
        : `Lesson recorded: if "${trigger}" then "${behavior}". It will be injected whenever that situation recurs.`;
    },
    list_lessons({ category }) {
      const lessons = guardrails.listLessons();
      const filtered = category ? lessons.filter((l) => !category || l.category === category || l.category === 'all') : lessons;
      if (!filtered.length) return '(no lessons recorded)';
      return filtered.map((l) => `- ${l.title} [${l.category}]: IF ${l.trigger} THEN ${l.behavior}`).join('\n');
    },
  };
}

module.exports = { defs, makeExecutors, MEMORY_FILE, readMemory, appendMemory };