// Session-scoped todo list. The model uses it to plan multi-step work;
// the UI renders it after each update.

const defs = [
  {
    name: 'todowrite',
    description: 'Replace the session todo list. Use for multi-step tasks: mark exactly one item in_progress at a time, complete items as you finish them.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
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
