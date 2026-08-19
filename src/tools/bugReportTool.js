// Lets the agent itself file a bug report/feature request as a tracked
// GitHub issue — either after the user asks it to, or proactively once it
// notices a real bug (report what happened, then ask or just do it, per the
// conversation).

const { submitBugReport } = require('../bugReport');

const defs = [
  {
    name: 'submit_bug_report',
    description: 'File a bug report, feature request, or question as a tracked GitHub issue in the VoidCode repo. Use this when the user asks you to report something, or when you notice a real bug/crash/incorrect behavior worth tracking — either ask the user first ("want me to file this as a bug report?") or, if they already said to just report anything you find, file it and tell them you did.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'short summary, <= 80 chars. Omit to auto-derive from the description.' },
        description: { type: 'string', description: 'what happened: steps to reproduce, expected vs. actual behavior, any error text.' },
        category: { type: 'string', enum: ['bug', 'feature-request', 'question'], description: 'defaults to bug' },
      },
      required: ['description'],
    },
  },
];

function makeExecutors(ctx) {
  return {
    async submit_bug_report({ title, description, category }) {
      const cfg = ctx.cfg || {};
      const context = { provider: ctx.provider?.name, model: ctx.provider?.model };
      const res = await submitBugReport(cfg, { title, description, category, context, submittedBy: 'agent' });
      if (res.ok) return `Filed as issue #${res.number}: ${res.url}`;
      if (res.manualUrl) return `Could not file it automatically (${res.error}) — no GitHub token is configured in Settings. Manual link to file it yourself: ${res.manualUrl}`;
      return `Failed to file bug report: ${res.error}`;
    },
  };
}

module.exports = { defs, makeExecutors };
