// Regression suite for the control-handoff bug: after a tool call (read,
// edit, bash, ...) some providers/models return a completion with neither
// text nor a tool call. The harness used to paper over this by pushing a
// blank, fabricated `{ role: 'user', content: '[continue]' }` message into
// the conversation, forcing the model to guess what to do next from nothing
// — and, for the main session, permanently persisting that fake turn to
// disk. This suite proves:
//
//   1. That gap is now filled with a structured continuation packet (task,
//      plan step, previous intended action, tool called, tool result/error,
//      completed work, expected next step, remaining steps, stop
//      conditions) — never a blank or fake user message.
//   2. The packet is delivered as an ephemeral system message on the SAME
//      execution turn — it is never pushed into the persisted session (or
//      subagent/worker/focus buffer) history.
//   3. If the model still doesn't act after being given real continuation
//      state, the harness stops and reports the failure instead of
//      continuing to guess indefinitely.
//   4. The fix holds across: successful read, successful edit, failed edit,
//      shell errors, truncated results, retries, sub-agents, focus agents,
//      and scheduled tasks (autonomous sends with an organism task label).
//   5. Normal user messages and existing session behavior are unaffected.
//   6. The packet also fires on a blank completion with NO prior tool call
//      this turn (a fresh user message, subagent prompt, or worker handoff) —
//      that used to skip retries entirely and throw immediately, since the
//      recovery was gated on the previous message being a tool result.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${err.stack || err.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${err.stack || err.message}`); }
}

const { Agent, buildContinuationPacket, describePlanStep, describeRemainingSteps } = require('../src/agent');

// ---------------------------------------------------------------- helpers

// Scripts a sequence of streamChatFn results. Each entry is either a result
// object { content, toolCalls, usage } or a function (snapshot, callNumber)
// => result, so later steps can assert on what was actually sent. Indexing
// clamps to the last entry, so a short script naturally repeats its final
// step for as many extra rounds as the loop needs.
function scriptStreamChat(steps) {
  const calls = [];
  let i = 0;
  const fn = async (prov, messages) => {
    const snapshot = messages.map((m) => ({ role: m.role, content: m.content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id }));
    calls.push(snapshot);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const resolved = typeof step === 'function' ? (step(snapshot, calls.length) || {}) : step;
    return {
      content: resolved.content ?? '',
      toolCalls: resolved.toolCalls ?? [],
      finishReason: (resolved.toolCalls && resolved.toolCalls.length) ? 'tool_calls' : 'stop',
      usage: resolved.usage || null,
    };
  };
  return { fn, calls };
}

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function makeSession() {
  return {
    messages: [],
    usage: { input: 0, output: 0, turns: 0, cost: 0, activeTimeMs: 0 },
    contextTraces: [],
    title: '',
    scratchpad: '',
    fileBackups: [],
    saved: false,
    save() { this.saved = true; },
    recordFileChange(file, before, after) { this.fileBackups.push({ file, before, after }); },
  };
}

function makeAgent({ cwd, script, cfgOverrides = {} }) {
  const session = makeSession();
  const cfg = {
    provider: 'mock', model: 'mock-model', agentMode: 'legacy',
    maxToolRounds: 20, compactAt: 0.75, contextTokens: 128000,
    providers: { mock: { baseUrl: 'http://127.0.0.1:1/v1' } },
    ...cfgOverrides,
  };
  const provider = { name: 'mock', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: 'mock-model', contextTokens: 128000 };
  const permissions = { check: async () => true };
  const agent = new Agent({ cfg, provider, session, permissions, events: {}, cwd, streamChatFn: script.fn });
  return { agent, session };
}

// No message in a persisted/ephemeral message array may be a blank or
// fabricated user turn ("[continue]", or literally empty user content).
function assertNoFakeUserTurns(messages, label) {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    assert(content.trim() !== '', `${label}: found a blank user message`);
    assert(!content.startsWith('[continue]'), `${label}: found the old fake "[continue]" user message`);
  }
}

function findSystemPacket(messages) {
  // Match on a phrase unique to the real packet body (not just the
  // "[Continuation Packet" tag name, which now also appears as an example
  // in the system prompt's own anti-narration instructions).
  return messages.find((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('the harness is resuming this turn for you'));
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function main() {

  // ================================================================
  // Unit: buildContinuationPacket / describePlanStep / describeRemainingSteps
  // ================================================================

  check('describePlanStep returns the in_progress todo over pending ones', () => {
    const todos = [
      { content: 'write tests', status: 'pending' },
      { content: 'fix the bug', status: 'in_progress' },
    ];
    assert.strictEqual(describePlanStep(todos), 'fix the bug');
  });

  check('describePlanStep falls back to the first pending todo when none is in_progress', () => {
    const todos = [{ content: 'write tests', status: 'pending' }];
    assert.strictEqual(describePlanStep(todos), 'write tests');
  });

  check('describePlanStep returns null (not a guess) when there is no todo list', () => {
    assert.strictEqual(describePlanStep(undefined), null);
    assert.strictEqual(describePlanStep([]), null);
  });

  check('describeRemainingSteps counts non-completed todos honestly', () => {
    const todos = [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
      { content: 'c', status: 'in_progress' },
    ];
    assert.strictEqual(describeRemainingSteps(todos), '2 of 3 todo item(s) not yet completed');
    assert.strictEqual(describeRemainingSteps([]), 'no todo list recorded for this turn');
  });

  // ================================================================
  // Unit: guardrails.stripLeakedSystemTags — narration leak guard
  // ================================================================

  const guardrails = require('../src/guardrails');

  check('stripLeakedSystemTags removes a verbatim leaked [System Rule] line but keeps the real answer', () => {
    const leaked = '[System Rule - Goal Anchor] The tool "bash" just finished and returned real output: "ok". Do not just restate the output; use it.\nHere is the actual answer for you.';
    const cleaned = guardrails.stripLeakedSystemTags(leaked);
    assert(!cleaned.includes('[System Rule'));
    assert(cleaned.includes('Here is the actual answer for you.'));
  });

  check('stripLeakedSystemTags removes a fully-echoed continuation packet block', () => {
    const packet = buildContinuationPacket({
      activeTask: 'x', toolCalled: 'read', toolResult: { ok: true, output: 'y' }, completedWork: [], stopConditions: [],
    });
    const leaked = `${packet}\nAnd here is my real reply to you.`;
    const cleaned = guardrails.stripLeakedSystemTags(leaked);
    assert(!cleaned.includes('[Continuation Packet'));
    assert(!cleaned.includes('Tool called:'));
    assert(cleaned.includes('And here is my real reply to you.'));
  });

  check('stripLeakedSystemTags never touches ordinary prose (including prose that mentions tool names)', () => {
    const normal = 'I read the file and the bash command ran fine. Tool called out to me for help once, unrelated to any of this.';
    assert.strictEqual(guardrails.stripLeakedSystemTags(normal), normal);
  });

  check('guardrails.intercept appends a silent-compliance trailer whenever another rule fires, and never otherwise', () => {
    const noRuleFired = guardrails.intercept({ messages: [{ role: 'user', content: 'hi' }], kind: 'main', context: {} });
    assert.strictEqual(noRuleFired.length, 0);

    const ruleFired = guardrails.intercept({
      messages: [{ role: 'tool', content: 'No search results found.' }],
      kind: 'main',
      context: {},
    });
    assert(ruleFired.some((r) => /Silent Compliance/.test(r)), 'expected the never-narrate trailer alongside a fired rule');
  });

  check('buildContinuationPacket names the task, tool, and result and never invents unknown fields', () => {
    const packet = buildContinuationPacket({
      activeTask: 'refactor the parser',
      planStep: 'update the tokenizer',
      remainingSteps: '1 of 2 todo item(s) not yet completed',
      previousIntendedAction: 'read(src/tokenizer.js)',
      toolCalled: 'read',
      toolResult: { ok: true, output: 'file contents here' },
      completedWork: ['read: ok — file contents here'],
      expectedNextStep: 'apply the change',
      stopConditions: ['stop if unsure'],
    });
    assert(packet.includes('[Continuation Packet'));
    assert(packet.includes('Active task: refactor the parser'));
    assert(packet.includes('Current plan step: update the tokenizer'));
    assert(packet.includes('Previous intended action: read(src/tokenizer.js)'));
    assert(packet.includes('Tool called: read'));
    assert(packet.includes('Tool result: OK — file contents here'));
    assert(packet.includes('read: ok — file contents here'));
    assert(packet.includes('Expected next step: apply the change'));
    assert(packet.includes('Remaining steps: 1 of 2 todo item(s) not yet completed'));
    assert(packet.includes('stop if unsure'));
    assert(!/this is a new (user )?message/i.test(packet));
  });

  check('buildContinuationPacket marks a failed tool result as FAILED, not OK', () => {
    const packet = buildContinuationPacket({
      activeTask: 'x', toolCalled: 'edit',
      toolResult: { ok: false, output: 'ERROR: oldString not found in file.' },
      completedWork: [], stopConditions: [],
    });
    assert(packet.includes('Tool result: FAILED — ERROR: oldString not found in file.'));
  });

  check('buildContinuationPacket states missing fields explicitly instead of guessing', () => {
    const packet = buildContinuationPacket({ activeTask: '', toolCalled: null, toolResult: null, completedWork: [], stopConditions: [] });
    assert(packet.includes('Active task: (not recorded)'));
    assert(packet.includes('Tool called: (unknown)'));
    assert(packet.includes('Tool result: unavailable (no result captured for this call)'));
    assert(packet.includes('(nothing completed yet this turn)'));
    assert(packet.includes('Stop conditions:\n  - (none)'));
  });

  check('buildContinuationPacket clips a very long tool result instead of dumping it all', () => {
    const huge = 'x'.repeat(5000);
    const packet = buildContinuationPacket({ activeTask: 'x', toolCalled: 'read', toolResult: { ok: true, output: huge }, completedWork: [], stopConditions: [] });
    assert(packet.includes('…'), 'expected an ellipsis marking truncation');
    assert(packet.length < huge.length, 'packet must not just re-embed the entire tool output');
    const resultLine = packet.split('\n').find((l) => l.startsWith('Tool result:'));
    assert(resultLine.length < 600, `Tool result line should be clipped to ~500 chars, got ${resultLine.length}`);
  });

  // ================================================================
  // e2e (scripted provider, real tool executors): successful read
  // ================================================================

  await checkAsync('successful read: empty completion after the tool gets a structured packet, not a blank user turn', async () => {
    const cwd = mkTmp('voidcode-cont-read-');
    fs.writeFileSync(path.join(cwd, 'note.txt'), 'hello world', 'utf8');

    const script = scriptStreamChat([
      { toolCalls: [toolCall('c1', 'read', { filePath: 'note.txt' })] },
      { content: '', toolCalls: [] }, // the bug trigger: blank completion right after a tool round
      { content: 'Done — I read the file.' },
    ]);
    const { agent, session } = makeAgent({ cwd, script });

    const result = await agent.send('read note.txt and tell me what it says');
    assert.strictEqual(result, 'Done — I read the file.');

    // The retry request (3rd call) must carry a real continuation packet.
    const retryReq = script.calls[2];
    const packetMsg = findSystemPacket(retryReq);
    assert(packetMsg, 'expected a [Continuation Packet] system message on the retry request');
    assert(packetMsg.content.includes('Tool called: read'));
    assert(packetMsg.content.includes('Tool result: OK'));
    assert(packetMsg.content.includes('hello world'));
    assert(!packetMsg.content.match(/this is a new user message/i));

    // The persisted session must never contain the fake "[continue]" turn or
    // any blank user message, and must never gain a persisted system packet.
    assertNoFakeUserTurns(session.messages, 'session.messages');
    assert(!session.messages.some((m) => m.role === 'system'), 'continuation packet leaked into persisted session history');
    assert(session.saved, 'session.save() should still be called on a successful turn');

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ================================================================
  // e2e: successful edit
  // ================================================================

  await checkAsync('successful edit: empty completion after the tool gets a structured packet and the edit lands on disk', async () => {
    const cwd = mkTmp('voidcode-cont-edit-');
    const file = path.join(cwd, 'code.txt');
    fs.writeFileSync(file, 'version: 1', 'utf8');

    const script = scriptStreamChat([
      { toolCalls: [toolCall('c1', 'edit', { filePath: 'code.txt', oldString: 'version: 1', newString: 'version: 2' })] },
      { content: '', toolCalls: [] },
      { content: 'Bumped the version.' },
    ]);
    const { agent, session } = makeAgent({ cwd, script });

    const result = await agent.send('bump the version in code.txt');
    assert.strictEqual(result, 'Bumped the version.');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'version: 2');

    const packetMsg = findSystemPacket(script.calls[2]);
    assert(packetMsg, 'expected a continuation packet after the edit');
    assert(packetMsg.content.includes('Tool called: edit'));
    assert(packetMsg.content.includes('Tool result: OK'));
    assertNoFakeUserTurns(session.messages, 'session.messages');
    assert(!session.messages.some((m) => m.role === 'system'));

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ================================================================
  // e2e: failed edit
  // ================================================================

  await checkAsync('failed edit: the packet marks the failure and tells the model not to repeat the identical call', async () => {
    const cwd = mkTmp('voidcode-cont-editfail-');
    fs.writeFileSync(path.join(cwd, 'code2.txt'), 'foo', 'utf8');

    const script = scriptStreamChat([
      { toolCalls: [toolCall('c1', 'edit', { filePath: 'code2.txt', oldString: 'does-not-exist', newString: 'x' })] },
      { content: '', toolCalls: [] },
      { content: 'That text was not found; I will re-check the file first.' },
    ]);
    const { agent, session } = makeAgent({ cwd, script });

    const result = await agent.send('replace does-not-exist with x in code2.txt');
    assert.strictEqual(result, 'That text was not found; I will re-check the file first.');

    const packetMsg = findSystemPacket(script.calls[2]);
    assert(packetMsg, 'expected a continuation packet after the failed edit');
    assert(packetMsg.content.includes('Tool called: edit'));
    assert(packetMsg.content.includes('Tool result: FAILED'));
    assert(packetMsg.content.includes('oldString not found'));
    assert(/[Dd]o not repeat the identical call/.test(packetMsg.content));
    assertNoFakeUserTurns(session.messages, 'session.messages');

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ================================================================
  // e2e: shell error (non-zero exit / stderr) — still surfaced truthfully
  // ================================================================

  await checkAsync('shell error: bash failures are reflected in the packet\'s tool result, never hidden or invented', async () => {
    const cwd = mkTmp('voidcode-cont-bash-');
    const failCmd = process.platform === 'win32' ? 'exit 1' : 'exit 1';

    const script = scriptStreamChat([
      { toolCalls: [toolCall('c1', 'bash', { command: failCmd })] },
      { content: '', toolCalls: [] },
      { content: 'The command failed; investigating.' },
    ]);
    const { agent, session } = makeAgent({ cwd, script });

    const result = await agent.send('run the failing command');
    assert.strictEqual(result, 'The command failed; investigating.');

    const packetMsg = findSystemPacket(script.calls[2]);
    assert(packetMsg, 'expected a continuation packet after the shell error');
    assert(packetMsg.content.includes('Tool called: bash'));
    assert(/exit code 1/.test(packetMsg.content), packetMsg.content);
    assertNoFakeUserTurns(session.messages, 'session.messages');

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ================================================================
  // e2e: truncated / very long tool result stays bounded
  // ================================================================

  await checkAsync('truncated result: a huge tool output is clipped in the packet instead of blowing up the request', async () => {
    const cwd = mkTmp('voidcode-cont-trunc-');
    const bigContent = Array.from({ length: 2000 }, (_, i) => `line ${i} `.repeat(5)).join('\n');
    fs.writeFileSync(path.join(cwd, 'big.txt'), bigContent, 'utf8');

    const script = scriptStreamChat([
      { toolCalls: [toolCall('c1', 'read', { filePath: 'big.txt' })] },
      { content: '', toolCalls: [] },
      { content: 'Summarized the big file.' },
    ]);
    const { agent, session } = makeAgent({ cwd, script });

    const result = await agent.send('summarize big.txt');
    assert.strictEqual(result, 'Summarized the big file.');

    const packetMsg = findSystemPacket(script.calls[2]);
    assert(packetMsg, 'expected a continuation packet after reading the large file');
    assert(packetMsg.content.includes('…'), 'expected the long tool output to be truncated with an ellipsis');
    assert(packetMsg.content.length < bigContent.length, 'packet must not just re-embed the entire tool output');
    assertNoFakeUserTurns(session.messages, 'session.messages');

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ================================================================
  // e2e: retries exhausted -> stop and report, never guess forever
  // ================================================================

  await checkAsync('retries exhausted: after repeated empty completions the loop stops and reports rather than inventing further turns', async () => {
    const cwd = mkTmp('voidcode-cont-retry-');
    fs.writeFileSync(path.join(cwd, 'note.txt'), 'hello', 'utf8');

    // Script clamps to its last entry, so this repeats an empty completion
    // for every round after the initial tool call — forcing the harness
    // past its continuation-packet retry budget.
    const script = scriptStreamChat([
      { toolCalls: [toolCall('c1', 'read', { filePath: 'note.txt' })] },
      { content: '', toolCalls: [] },
    ]);
    const { agent, session } = makeAgent({ cwd, script });

    let thrown = null;
    try {
      await agent.send('read note.txt');
    } catch (err) {
      thrown = err;
    }
    assert(thrown, 'expected the loop to stop and throw once continuation retries are exhausted');
    assert(/[Ss]topping rather than guessing/.test(thrown.message), thrown.message);
    assert(/read/.test(thrown.message), thrown.message);

    // Exactly 2 packet-guided retries should have been attempted before the
    // loop gives up (bounded — not a silent infinite spin).
    const packetRequests = script.calls.filter((reqMsgs) => findSystemPacket(reqMsgs));
    assert.strictEqual(packetRequests.length, 2, `expected exactly 2 continuation-packet retries, got ${packetRequests.length}`);

    assertNoFakeUserTurns(session.messages, 'session.messages');
    assert(!session.messages.some((m) => m.role === 'system'), 'no packet should have leaked into persisted history even on failure');

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ================================================================
  // e2e: fresh turn, no tool anchor yet — the harness used to throw
  // immediately here instead of retrying, because the packet was gated on
  // the previous message being a tool result.
  // ================================================================

  await checkAsync('fresh turn: an empty completion with no prior tool call this turn still gets a continuation packet, not an immediate stop', async () => {
    const cwd = mkTmp('voidcode-cont-freshturn-');
    const script = scriptStreamChat([
      { content: '', toolCalls: [] }, // the bug trigger: blank completion on round 1, before any tool has run
      { content: 'Sure — happy to help with that.' },
    ]);
    const { agent, session } = makeAgent({ cwd, script });

    const result = await agent.send('hello, are you there?');
    assert.strictEqual(result, 'Sure — happy to help with that.');

    const retryReq = script.calls[1];
    const packetMsg = findSystemPacket(retryReq);
    assert(packetMsg, 'expected a [Continuation Packet] system message on the retry request even with no tool anchor');
    assert(packetMsg.content.includes('Tool called: (unknown)'));
    assert(packetMsg.content.includes('Tool result: unavailable'));
    assert(packetMsg.content.includes('Nothing has run yet this turn'));
    assert(!packetMsg.content.match(/this is a new user message/i));

    assertNoFakeUserTurns(session.messages, 'session.messages');
    assert(!session.messages.some((m) => m.role === 'system'), 'continuation packet leaked into persisted session history');

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  await checkAsync('fresh turn retries exhausted: repeated blank completions with no tool anchor still stop and report, never loop forever', async () => {
    const cwd = mkTmp('voidcode-cont-freshretry-');
    const script = scriptStreamChat([{ content: '', toolCalls: [] }]);
    const { agent, session } = makeAgent({ cwd, script });

    let thrown = null;
    try {
      await agent.send('hello?');
    } catch (err) {
      thrown = err;
    }
    assert(thrown, 'expected the loop to stop and throw once continuation retries are exhausted');
    assert(/[Ss]topping rather than guessing/.test(thrown.message), thrown.message);
    assert(/no tool call to anchor/.test(thrown.message), thrown.message);

    const packetRequests = script.calls.filter((reqMsgs) => findSystemPacket(reqMsgs));
    assert.strictEqual(packetRequests.length, 2, `expected exactly 2 continuation-packet retries, got ${packetRequests.length}`);

    assertNoFakeUserTurns(session.messages, 'session.messages');
    assert(!session.messages.some((m) => m.role === 'system'));

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ================================================================
  // e2e: sub-agents — the same fix applies inside runSubagent's own buffer,
  // and never touches the parent session.
  // ================================================================

  await checkAsync('sub-agents: continuation packet recovers an empty completion inside the subagent buffer, isolated from the main session', async () => {
    const cwd = mkTmp('voidcode-cont-subagent-');
    fs.writeFileSync(path.join(cwd, 'note.txt'), 'sub agent data', 'utf8');

    const script = scriptStreamChat([
      { toolCalls: [toolCall('c1', 'read', { filePath: 'note.txt' })] },
      { content: '', toolCalls: [] },
      { content: 'Subagent report: found the data.' },
    ]);
    const { agent, session } = makeAgent({ cwd, script });

    const report = await agent.runSubagent({ description: 'inspect note.txt', prompt: 'Read note.txt and report its contents.' });
    assert.strictEqual(report, 'Subagent report: found the data.');

    const packetMsg = findSystemPacket(script.calls[2]);
    assert(packetMsg, 'expected a continuation packet inside the subagent loop');
    assert(packetMsg.content.includes('Tool called: read'));
    assert(/subagent: inspect note\.txt/.test(packetMsg.content));

    // The parent/main session must be completely untouched by the subagent's
    // internal recovery — no fake turns, no leaked packets, nothing at all
    // since we never called agent.send() on the main session in this test.
    assert.deepStrictEqual(session.messages, []);

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ================================================================
  // e2e: scheduled tasks — autonomous send() carries the scheduled task's
  // label into the continuation packet's "Active task" field.
  // ================================================================

  await checkAsync('scheduled tasks: an autonomous send() labels the continuation packet with the scheduled task, not a guess', async () => {
    const cwd = mkTmp('voidcode-cont-sched-');
    fs.writeFileSync(path.join(cwd, 'report.txt'), 'nightly data', 'utf8');

    const script = scriptStreamChat([
      { toolCalls: [toolCall('c1', 'read', { filePath: 'report.txt' })] },
      { content: '', toolCalls: [] },
      { content: 'Nightly report reviewed; all clear.' },
    ]);
    const { agent, session } = makeAgent({ cwd, script });

    const result = await agent.send('run the nightly report check', {
      autonomous: true,
      organismTask: 'scheduled: nightly report check',
    });
    assert.strictEqual(result, 'Nightly report reviewed; all clear.');

    const packetMsg = findSystemPacket(script.calls[2]);
    assert(packetMsg, 'expected a continuation packet for the scheduled run');
    assert(packetMsg.content.includes('Active task: scheduled: nightly report check'));
    assertNoFakeUserTurns(session.messages, 'session.messages');

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ================================================================
  // e2e: normal flows are unaffected — a plain conversational turn with no
  // tool calls at all still works exactly as before.
  // ================================================================

  await checkAsync('normal user turns are preserved: a plain no-tool-call reply still returns immediately with no packet involved', async () => {
    const cwd = mkTmp('voidcode-cont-normal-');
    const script = scriptStreamChat([{ content: 'Hi there — happy to help.' }]);
    const { agent, session } = makeAgent({ cwd, script });

    const result = await agent.send('hello!');
    assert.strictEqual(result, 'Hi there — happy to help.');
    assert.strictEqual(script.calls.length, 1, 'a plain reply should not trigger any retry');
    assert.strictEqual(session.messages[0].role, 'user');
    assert.strictEqual(session.messages[0].content, 'hello!');
    assert(!findSystemPacket(session.messages));

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ================================================================
  // e2e: narration leak — if a model still echoes an internal tag back
  // (despite the instructions), it never reaches the persisted answer.
  // ================================================================

  await checkAsync('narration leak: a model that echoes a [System Rule] tag back gets it stripped before the reply is persisted', async () => {
    const cwd = mkTmp('voidcode-cont-leak-');
    fs.writeFileSync(path.join(cwd, 'note.txt'), 'hello', 'utf8');

    const script = scriptStreamChat([
      { toolCalls: [toolCall('c1', 'read', { filePath: 'note.txt' })] },
      // The model narrates the ephemeral goal-anchor rule it just received,
      // verbatim, glued onto its own real answer with no separator — exactly
      // the leak pattern observed in the wild.
      { content: '[System Rule - Goal Anchor] The tool "read" just finished and returned real output: "hello". Do not just restate the output; use it.The file just says hello.' },
    ]);
    const { agent, session } = makeAgent({ cwd, script });

    const result = await agent.send('what does note.txt say?');
    assert(!result.includes('[System Rule'), `leaked tag reached the visible reply: ${result}`);
    assert(result.includes('The file just says hello.'));

    const lastMsg = session.messages[session.messages.length - 1];
    assert.strictEqual(lastMsg.role, 'assistant');
    assert(!lastMsg.content.includes('[System Rule'), 'leaked tag was persisted into session history');

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ================================================================
  // e2e: focus agents — same principle, own loop implementation.
  // ================================================================

  await checkAsync('focus agents: an empty round after a tool call gets a structured, ephemeral packet — never a persisted fake user nudge', async () => {
    const { FocusSession } = require('../src/focus');
    const cwd = mkTmp('voidcode-cont-focus-');

    let requestCount = 0;
    let scratchpadCalls = 0;
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        if (payload.stream === false) {
          // Scratchpad generation (generateScratchpad -> complete()) is a
          // plain non-streaming completion, distinct from the main
          // streaming loop below — must not shift the round-numbered
          // branching, and must get back valid JSON (not an SSE stream) or
          // it throws and is silently swallowed by run()'s best-effort catch.
          scratchpadCalls++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'Goal: write the note. Status: in progress.' } }] }));
          return;
        }
        requests.push(payload);
        requestCount++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (requestCount === 1) {
          // Round 1: a normal tool call.
          const args = JSON.stringify({ filePath: 'note.txt', content: 'hello focus' });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write', arguments: args } }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        } else if (requestCount === 2) {
          // Round 2: the bug trigger — blank completion right after the tool ran.
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] })}\n\n`);
        } else {
          // Round 3: must have received a structured continuation packet by now.
          const args = JSON.stringify({ report: 'All done — file written.' });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c2', type: 'function', function: { name: 'focus_complete', arguments: args } }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const mockManager = { emit: () => {} };
    const session = new FocusSession({
      id: 'f-continuation-test',
      manager: mockManager,
      description: 'write a note and finish',
      prompt: 'Write hello focus to note.txt, then finish.',
      deadlineMs: 5 * 60 * 1000,
      mode: 'task',
      agentRefs: {
        provider: { name: 'mock', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model', contextTokens: 128000 },
        cfg: { contextTokens: 128000, compactAt: 0.75, guardrails: {} },
        cwd,
        mcpServers: [],
        toolCtx: { onFileChange: () => {}, onContextTrace: () => {} },
        contextResolver: null,
        organism: null,
      },
    });

    await session.run();
    server.close();

    assert.strictEqual(session.status, 'done', `expected status done, got ${session.status}`);
    assert.strictEqual(session.finalReport, 'All done — file written.');
    assert.strictEqual(requestCount, 3, `expected exactly 3 main-loop requests, got ${requestCount}`);
    assert(scratchpadCalls > 0, 'expected the scratchpad to actually be generated (regression check for generateScratchpad\'s missing complete() import)');

    // Request #3 must have carried the structured packet.
    const req3 = requests[2];
    const packetMsg = req3.messages.find((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('the harness is resuming this turn for you'));
    assert(packetMsg, 'expected a continuation packet on the retry request');
    assert(packetMsg.content.includes('Tool called: write'));
    assert(packetMsg.content.includes('Tool result: OK'));

    // The session's own working buffer must never have gained a fake/blank
    // user nudge, nor a permanently-persisted packet.
    assertNoFakeUserTurns(session.messages, 'focus session.messages');
    for (const m of session.messages) {
      if (m.role === 'system') {
        assert(!String(m.content).includes('[Continuation Packet'), 'continuation packet must stay ephemeral, never persisted into focus session.messages');
      }
    }

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall continuation tests passed');
  process.exit(failures ? 1 : 0);
}

main();
