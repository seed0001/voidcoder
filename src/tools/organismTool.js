// Organism treasury tool: read-only access for the agent to inspect its
// treasury balance, spending summary, and auditable ledger. Operator
// top-ups/refunds are an operator action exposed through the CLI (/organism),
// not through agent tools, so the agent can never mint its own credits.

const defs = [
  {
    name: 'organism_treasury',
    description: 'Inspect the digital-organism treasury: current USD balance, spending summary by kind/model, and the auditable ledger of every charge (model calls, subagents, focus agents, scheduled tasks, top-ups). Read-only — the agent cannot top up its own balance. Use this to check how much budget remains before expensive work.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['summary', 'ledger', 'balance'],
          description: 'summary = balance + totals by kind and model; ledger = recent ledger entries; balance = just the current balance',
        },
        limit: { type: 'number', description: 'max ledger rows to show (default 25)' },
        kind: { type: 'string', description: 'optional filter: model_call, subagent, work, focus, scheduled, initial, topup' },
      },
      required: ['action'],
    },
  },
];

const fmt = (n) => {
  if (!n) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(4)}`;
};

function makeExecutors(ctx) {
  return {
    organism_treasury({ action, limit = 25, kind = null }) {
      const organism = ctx.organism || null;
      if (!organism || !organism.enabled) {
        return 'Digital-organism mode is disabled. Enable it in config: { "organism": { "enabled": true } }';
      }
      switch (action) {
        case 'balance': {
          const s = organism.summary();
          return `Treasury balance: ${fmt(s.balance)} ${s.currency} (initial ${fmt(s.initialCredits)}, spent ${fmt(s.totalSpent)} total)`;
        }
        case 'ledger': {
          const rows = organism.queryLedger({ limit, kind });
          if (!rows.length) return 'Ledger is empty.';
          const lines = rows.map((e) => {
            const when = new Date(e.ts).toISOString().slice(0, 16).replace('T', ' ');
            const type = String(e.type || '?').padEnd(10);
            const actor = String(e.actor || '-').padEnd(10);
            const model = String(e.model || e.task || '-').slice(0, 44).padEnd(44);
            return `  ${when}  ${type}  ${actor}  ${model}  ${fmt(e.costUSD)}  → ${fmt(e.balanceAfter)}`;
          });
          return `Treasury ledger (last ${rows.length}):\n${lines.join('\n')}`;
        }
        case 'summary': {
          const s = organism.summary();
          const byKind = Object.entries(s.byKind).map(([k, v]) => `    ${k.padEnd(10)} ${fmt(v)}`).join('\n');
          const byModel = Object.entries(s.byModel).slice(0, 8).map(([k, v]) => `    ${k.padEnd(28)} ${fmt(v)}`).join('\n');
          return [
            `Treasury summary (${s.currency})`,
            `  balance:          ${fmt(s.balance)}`,
            `  initial credits:  ${fmt(s.initialCredits)}`,
            `  total spent:      ${fmt(s.totalSpent)}`,
            `  model calls:      ${s.modelCalls}`,
            `  ledger entries:   ${s.ledgerCount}`,
            byKind ? `  spent by kind:\n${byKind}` : '  spent by kind: (none)',
            byModel ? `  spent by model:\n${byModel}` : '  spent by model: (none)',
          ].join('\n');
        }
        default:
          throw new Error(`Unknown action "${action}"`);
      }
    },
  };
}

module.exports = { defs, makeExecutors };