// Unit tests for src/discord/sweepPrompt.js — pure string logic.

const assert = require('assert');
const { buildSweepPrompt, extractProposal, PROPOSAL_START, PROPOSAL_END } = require('../../src/discord/sweepPrompt');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${err.message}`); }
}

check('buildSweepPrompt includes project name/path and the proposal delimiter instructions', () => {
  const prompt = buildSweepPrompt({ name: 'Demo', path: '/tmp/demo', monetizationGoal: 'SaaS subscription' });
  assert.ok(prompt.includes('Demo'));
  assert.ok(prompt.includes('/tmp/demo'));
  assert.ok(prompt.includes('SaaS subscription'));
  assert.ok(prompt.includes(PROPOSAL_START));
  assert.ok(prompt.includes(PROPOSAL_END));
});

check('extractProposal parses a well-formed proposal block', () => {
  const text = `Found some gaps and fixed the linter.\n\n${PROPOSAL_START}\nDeploy to production.\n${PROPOSAL_END}\n\nEverything else looks fine.`;
  const { hasProposal, proposalText, rest } = extractProposal(text);
  assert.strictEqual(hasProposal, true);
  assert.strictEqual(proposalText, 'Deploy to production.');
  assert.ok(!rest.includes(PROPOSAL_START));
  assert.ok(rest.includes('Found some gaps'));
  assert.ok(rest.includes('Everything else looks fine.'));
});

check('extractProposal reports no proposal when the delimiter is absent', () => {
  const text = 'Just fixed a bug, nothing else needed.';
  const { hasProposal, proposalText, rest } = extractProposal(text);
  assert.strictEqual(hasProposal, false);
  assert.strictEqual(proposalText, '');
  assert.strictEqual(rest, text);
});

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall sweepPrompt tests passed');
process.exit(failures ? 1 : 0);
