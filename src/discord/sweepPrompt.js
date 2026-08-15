// The standard instruction given to a portfolio-sweep task (see
// src/discord/portfolio.js), and the parser for the proposal marker it's
// told to use when it wants to do something irreversible instead of just
// doing it.

const PROPOSAL_START = '===PROPOSAL===';
const PROPOSAL_END = '===END PROPOSAL===';

function buildSweepPrompt({ name, path: projectPath, monetizationGoal }) {
  const goal = monetizationGoal ? `The stated monetization goal for this project: ${monetizationGoal}.` : '';
  return [
    `You are running a periodic autonomy sweep over the project "${name}" (${projectPath}).`,
    `Audit it for gaps between its current state and a shippable, monetizable product: missing tests, obvious bugs, broken builds, unclear docs, unfinished features, rough edges a user would hit immediately. ${goal}`,
    '',
    'Fix anything safe and reversible directly: bugs, missing tests, docs, polish, small refactors — normal coding work.',
    '',
    'Do NOT deploy anything, spend any money, publish or post anything publicly, or make a pricing/business decision on your own — even if it seems like the obvious next step. For exactly that category of action, stop short of doing it and instead write ONE proposal block, delimited exactly like this:',
    '',
    PROPOSAL_START,
    '<a clear, specific description of the single irreversible action you want to take and why>',
    PROPOSAL_END,
    '',
    'Only include a proposal block if there is something irreversible worth proposing this sweep — most sweeps should end with just a plain summary of what you found/fixed and no proposal block at all.',
  ].join('\n');
}

function extractProposal(resultText) {
  const text = String(resultText || '');
  const startIdx = text.indexOf(PROPOSAL_START);
  const endIdx = text.indexOf(PROPOSAL_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { hasProposal: false, proposalText: '', rest: text };
  }
  const proposalText = text.slice(startIdx + PROPOSAL_START.length, endIdx).trim();
  const rest = (text.slice(0, startIdx) + text.slice(endIdx + PROPOSAL_END.length)).trim();
  return { hasProposal: true, proposalText, rest };
}

module.exports = { buildSweepPrompt, extractProposal, PROPOSAL_START, PROPOSAL_END };
