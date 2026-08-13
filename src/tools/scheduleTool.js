// Schedule tool: agent-managed calendar and timed tasks.
// The agent uses this to create, list, update, delete, and inspect scheduled tasks.

const schedule = require('../schedule');

const defs = [
  {
    name: 'schedule',
    description: 'Manage your scheduled tasks — like a personal calendar for the agent. Use this to view all tasks, create a new one (cron or interval), update an existing task, remove one, or inspect details of a specific task. Tasks run automatically in the background at the autonomy level you set. Useful for recurring research, daily digests, periodic builds, or any regular automation.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'update', 'remove', 'show'],
          description: 'operation to perform',
        },
        taskId: {
          type: 'string',
          description: 'id for update/remove/show actions',
        },
        title: {
          type: 'string',
          description: 'human-readable name for the scheduled task (used for add/update)',
        },
        prompt: {
          type: 'string',
          description: 'the instruction the agent will run when the task fires (used for add/update)',
        },
        cron: {
          type: 'string',
          description: '5-field cron expression e.g. "0 9 * * 1-5" for weekdays at 9am, or "*/30 * * * *" every 30 min. Mutually exclusive with interval.',
        },
        interval: {
          type: 'number',
          description: 'run every N minutes e.g. 60 for hourly. Mutually exclusive with cron.',
        },
        autonomyLevel: {
          type: 'string',
          enum: ['research', 'safe', 'full'],
          description: 'autonomy level for this specific task (default: safe)',
        },
        enabled: {
          type: 'boolean',
          description: 'whether the task is active (set false to pause without deleting)',
        },
      },
      required: ['action'],
    },
  },
];

function makeExecutors(/* ctx unused */) {
  return {
    schedule({ action, taskId, title, prompt, cron, interval, autonomyLevel, enabled }) {
      switch (action) {
        case 'list': {
          const tasks = schedule.listTasks();
          if (!tasks.length) return 'No scheduled tasks.';
          const lines = tasks.map((t) => {
            const status = t.enabled ? '●' : '○';
            const when = t.cron || `every ${t.interval}min`;
            const last = t.lastRun ? ` last: ${t.lastRun.slice(0, 16)}` : '';
            return `  ${status} ${t.id.slice(0, 8)}  ${t.title}  (${when})${last}`;
          });
          return `Scheduled tasks (${tasks.length}):\n${lines.join('\n')}`;
        }
        case 'add': {
          if (!prompt) throw new Error('prompt is required');
          if (!cron && !interval) throw new Error('cron or interval is required');
          const task = schedule.addTask({ title, prompt, cron, interval, autonomyLevel, enabled });
          const when = task.cron || `every ${task.interval}min`;
          return `Created task ${task.id.slice(0, 8)} "${task.title}" — ${when}. Next run: ${task.nextRun ? new Date(task.nextRun).toLocaleString() : 'never'}`;
        }
        case 'update': {
          if (!taskId) throw new Error('taskId is required');
          const patch = {};
          if (title !== undefined) patch.title = title;
          if (prompt !== undefined) patch.prompt = prompt;
          if (cron !== undefined) patch.cron = cron;
          if (interval !== undefined) patch.interval = interval;
          if (autonomyLevel !== undefined) patch.autonomyLevel = autonomyLevel;
          if (enabled !== undefined) patch.enabled = enabled;
          const task = schedule.updateTask(taskId, patch);
          return `Updated task ${taskId.slice(0, 8)}. Next run: ${task.nextRun ? new Date(task.nextRun).toLocaleString() : 'never'}`;
        }
        case 'remove': {
          if (!taskId) throw new Error('taskId is required');
          const task = schedule.removeTask(taskId);
          return `Removed task ${taskId.slice(0, 8)} "${task.title}"`;
        }
        case 'show': {
          if (!taskId) throw new Error('taskId is required');
          const task = schedule.listTasks().find((t) => t.id === taskId);
          if (!task) throw new Error(`No task with id "${taskId}"`);
          const lines = [
            `  id:       ${task.id}`,
            `  title:    ${task.title}`,
            `  enabled:  ${task.enabled}`,
            `  prompt:   ${task.prompt.slice(0, 200)}`,
            `  schedule: ${task.cron || `every ${task.interval} minutes`}`,
            `  autonomy: ${task.autonomyLevel || 'safe'}`,
            `  created:  ${task.createdAt ? new Date(task.createdAt).toLocaleString() : 'unknown'}`,
            `  last run: ${task.lastRun ? new Date(task.lastRun).toLocaleString() : 'never'}`,
            `  next run: ${task.nextRun ? new Date(task.nextRun).toLocaleString() : 'never (check schedule)'}`,
          ];
          if (task.lastResult) {
            lines.push(`  last result: ${task.lastResult.slice(0, 300)}`);
          }
          return lines.join('\n');
        }
        default:
          throw new Error(`Unknown action "${action}"`);
      }
    },
  };
}

module.exports = { defs, makeExecutors };