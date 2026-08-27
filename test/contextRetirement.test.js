// Unit tests for the pure functions in src/contextRetirement.js — the
// chunked "retire the oldest safe chunk, protect the rest" logic that
// replaced the old "flatten the whole conversation into one summary"
// compaction (see src/agent.js Agent.compact()).

const assert = require('assert');
const {
  classifyUnits,
  planRetirement,
  parseRetirementReply,
  mergeRoadmap,
  renderRoadmap,
  PROTECT_UNITS,
} = require('../src/contextRetirement');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${err.stack || err.message}`); }
}

function toolCall(id, name) {
  return { id, type: 'function', function: { name, arguments: '{}' } };
}

check('classifyUnits groups a tool_calls message with its matching tool results as one atomic unit', () => {
  const messages = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [toolCall('a', 'read'), toolCall('b', 'read')] },
    { role: 'tool', tool_call_id: 'a', content: 'file a' },
    { role: 'tool', tool_call_id: 'b', content: 'file b' },
    { role: 'assistant', content: 'done' },
  ];
  const units = classifyUnits(messages);
  assert.strictEqual(units.length, 3, `expected 3 units, got ${units.length}: ${JSON.stringify(units)}`);
  assert.deepStrictEqual(units[1], { start: 1, end: 4 }, 'the tool_calls message and both its results must be one unit');
});

check('classifyUnits never splits a unit even when the message list ends on a tool result (the original bug scenario)', () => {
  const messages = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [toolCall('a', 'read')] },
    { role: 'tool', tool_call_id: 'a', content: 'file a' },
  ];
  const units = classifyUnits(messages);
  // Last unit must be the whole tool round, not an empty/partial slice.
  const last = units[units.length - 1];
  assert.strictEqual(last.end, messages.length);
  assert.strictEqual(last.start, 1);
});

check('planRetirement never touches the most recent PROTECT_UNITS units', () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }));
  const plan = planRetirement(messages);
  assert(plan, 'expected a retirement plan for 10 single-message units');
  const units = classifyUnits(messages);
  const protectedStart = units[units.length - PROTECT_UNITS].start;
  assert(plan.end <= protectedStart, `retirement plan must not reach into the protected tail (plan.end=${plan.end}, protectedStart=${protectedStart})`);
});

check('planRetirement returns null when nothing is safely retirable (short conversation)', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  assert.strictEqual(planRetirement(messages), null);
});

check('planRetirement retires oldest-first and never returns a plan reaching past the last message', () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` }));
  const plan = planRetirement(messages);
  assert.strictEqual(plan.start, 0, 'must retire from the oldest message');
  assert(plan.end <= messages.length);
});

check('parseRetirementReply parses the labeled format', () => {
  const reply = `ROADMAP:
complete: 0, 2
in_progress: 1
new: Setup :: Configure the build
new: Verify :: Run the test suite

MEMORY:
- The API base URL is https://api.example.com
- none

POINTER: Investigated the build config and found two issues.`;
  const parsed = parseRetirementReply(reply);
  assert.deepStrictEqual(parsed.completeIdx, [0, 2]);
  assert.deepStrictEqual(parsed.inProgressIdx, [1]);
  assert.strictEqual(parsed.newItems.length, 2);
  assert.strictEqual(parsed.newItems[0].phase, 'Setup');
  assert.strictEqual(parsed.newItems[0].content, 'Configure the build');
  assert.strictEqual(parsed.memoryFacts.length, 1, '"- none" line must be filtered out');
  assert(parsed.memoryFacts[0].includes('api.example.com'));
  assert(parsed.pointer.includes('Investigated the build config'));
});

check('parseRetirementReply degrades gracefully to a pointer-only summary on unrecognized text', () => {
  const parsed = parseRetirementReply('The agent read three files and made no changes.');
  assert.strictEqual(parsed.completeIdx.length, 0);
  assert.strictEqual(parsed.newItems.length, 0);
  assert(parsed.pointer.includes('read three files'), 'unparseable reply must still be kept as the pointer, never dropped');
});

check('mergeRoadmap only ever advances status forward, never regresses it', () => {
  const existing = [
    { phase: 'Setup', content: 'a', status: 'completed' },
    { phase: 'Setup', content: 'b', status: 'pending' },
  ];
  const merged = mergeRoadmap(existing, { completeIdx: [], inProgressIdx: [0], newItems: [] });
  assert.strictEqual(merged[0].status, 'completed', 'a completed item must never regress to in_progress');
  assert.strictEqual(existing[0].status, 'completed', 'mergeRoadmap must not mutate its input');
});

check('mergeRoadmap appends new items under their phase', () => {
  const merged = mergeRoadmap([], { completeIdx: [], inProgressIdx: [], newItems: [{ phase: 'Refactor', content: 'extract helper' }] });
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].phase, 'Refactor');
  assert.strictEqual(merged[0].status, 'pending');
});

check('renderRoadmap groups by phase and marks the current step', () => {
  const todos = [
    { phase: 'Setup', content: 'read files', status: 'completed' },
    { phase: 'Setup', content: 'identify targets', status: 'in_progress' },
    { phase: 'Refactor', content: 'extract helper', status: 'pending' },
  ];
  const rendered = renderRoadmap(todos);
  assert(rendered.includes('## Setup'));
  assert(rendered.includes('## Refactor'));
  assert(rendered.includes('[x] read files'));
  assert(rendered.includes('identify targets  ← current step'));
  assert(rendered.includes('2 of 3 step(s) remaining'));
});

check('renderRoadmap handles an empty roadmap without inventing content', () => {
  assert(renderRoadmap([]).includes('no roadmap yet'));
  assert(renderRoadmap(null).includes('no roadmap yet'));
});

if (failures) {
  console.error(`\n${failures} contextRetirement test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll contextRetirement tests passed.');
}
