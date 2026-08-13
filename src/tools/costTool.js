// Cost tracker tool: query project cost and time usage.
// The agent uses this to report spending and time spent on the project.

const fs = require('fs');
const path = require('path');
const costTracker = require('../costTracker');

const defs = [
  {
    name: 'cost_tracker',
    description: 'Query project-level cost and time usage statistics. Returns total tokens used, total cost (USD), active time spent, and session count. Use this to inform the user about spending or time invested in the project.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['summary', 'sessions'],
          description: 'summary = overall project stats; sessions = per-session breakdown',
        },
      },
      required: ['action'],
    },
  },
];

function makeExecutors(ctx) {
  return {
    cost_tracker({ action }) {
      const cwd = ctx.cwd || process.cwd();
      switch (action) {
        case 'summary': {
          const agg = costTracker.load(cwd);
          return [
            'Project cost & time',
            `  sessions:        ${agg.sessions}`,
            `  total turns:     ${agg.totalTurns}`,
            `  total input:     ${agg.totalInputTokens.toLocaleString()} tokens`,
            `  total output:    ${agg.totalOutputTokens.toLocaleString()} tokens`,
            `  total cost:      ${costTracker.formatCost(agg.totalCost)}`,
            `  active time:     ${costTracker.formatDuration(agg.totalActiveTimeMs)}`,
            agg.lastUpdated ? `  last updated:    ${new Date(agg.lastUpdated).toLocaleString()}` : '',
          ].filter(Boolean).join('\n');
        }
        case 'sessions': {
          const { projectDir } = require('../sessions');
          const dir = projectDir(cwd);
          const files = [];
          try {
            const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'cost.json');
            for (const f of entries) {
              const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
              const u = data.usage || {};
              files.push({
                id: data.id || f.replace(/\.json$/, ''),
                title: data.title || '(untitled)',
                cost: u.cost || 0,
                activeTimeMs: u.activeTimeMs || 0,
                turns: u.turns || 0,
              });
            }
          } catch { /* empty */ }
          if (!files.length) return 'No sessions found.';
          const lines = files.sort((a, b) => b.cost - a.cost).map((s) => {
            return `  ${s.id.slice(0, 10)}  "${s.title.slice(0, 40)}"  ${costTracker.formatCost(s.cost)}  ${costTracker.formatDuration(s.activeTimeMs)}  ${s.turns} turns`;
          });
          return `Session breakdown (${files.length}):\n${lines.join('\n')}`;
        }
        default:
          throw new Error(`Unknown action "${action}"`);
      }
    },
  };
}

module.exports = { defs, makeExecutors };