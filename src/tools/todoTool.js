// Session-scoped todo list. The model uses it to plan multi-step work;
// the UI renders it after each update.

const defs = [
  {
    name: 'todowrite',
    description: 'Replace the session roadmap/todo list. This is the durable plan — it survives context compaction and stays visible in every system prompt, so it is the source of truth for "where am I" after a compaction notice. For multi-step work, group items under a `phase` (a top-level category, e.g. "Setup", "Refactor", "Verify"); items without a phase are grouped under "Tasks". Mark exactly one item in_progress at a time, complete items as you finish them.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              phase: { type: 'string', description: 'top-level category this item belongs to (optional; default "Tasks")' },
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
];

function makeExecutors(ctx) {
  return {
    todowrite({ todos }) {
      ctx.todos = todos;
      ctx.onTodos?.(todos);
      const done = todos.filter((t) => t.status === 'completed').length;
      return `Todo list updated (${done}/${todos.length} complete).`;
    },
  };
}

module.exports = { defs, makeExecutors };
