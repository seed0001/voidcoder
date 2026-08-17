// Regression suite for the focus-agent activity feed used by the desktop
// "drill into a focus agent" detail view (src/focus.js addLog/getDetail,
// app/main.js focus:detail IPC, app/renderer/app.js detail panel).
//
// Before this, FocusSession.addLog only recorded sparse narrative strings on
// error/milestone events (compaction, stream errors, questions, finish) —
// normal tool-call rounds never logged anything, so the desktop UI's "time
// remaining" and activity preview both read as frozen for most of a run,
// and there was no way to see what a session was actually doing. This suite
// proves:
//
//   1. Every tool call a session executes is logged as a structured 'tool'
//      record (tool name, args, ok/fail, output) — not just edge cases.
//   2. The model's own prose ("thinking") is logged as a 'thought' record,
//      both when it appears alongside a tool call and when it appears alone.
//   3. getStatus() (used by the list view) still returns only the last 5
//      entries; getDetail() (used by the drill-down view) returns the full
//      recent history, plus fields the list view doesn't need (scratchpad,
//      prompt, toolCalls count).
//   4. FocusManager.getDetail(id) round-trips to the right session, and
//      returns null for an unknown id (mirrors how the IPC handler treats
//      a session that was cleared or never existed).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

let failures = 0;
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${err.stack || err.message}`); }
}

const { FocusSession, FocusManager } = require('../src/focus');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Mock provider server: round 1 emits thinking prose alongside a tool call,
// round 2 emits thinking-only prose then a focus_complete call. Any
// non-streaming (stream:false) request is scratchpad generation — answered
// with plain JSON so it succeeds, without disturbing the round numbering.
function startMockServer() {
  let mainRequestCount = 0;
  let scratchpadCalls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      if (payload.stream === false) {
        scratchpadCalls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Goal: inspect note.txt.' } }] }));
        return;
      }
      mainRequestCount++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (mainRequestCount === 1) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Let me read the note first.' } }] })}\n\n`);
        const args = JSON.stringify({ filePath: 'note.txt' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read', arguments: args } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'That covers it — wrapping up.' } }] })}\n\n`);
        const args = JSON.stringify({ report: 'note.txt says hello.' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c2', type: 'function', function: { name: 'focus_complete', arguments: args } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, counts: () => ({ mainRequestCount, scratchpadCalls }) }));
  });
}

async function main() {
  await checkAsync('tool calls and thinking prose are logged as structured activity, readable from both getStatus and getDetail', async () => {
    const cwd = mkTmp('voidcode-focus-activity-');
    fs.writeFileSync(path.join(cwd, 'note.txt'), 'hello', 'utf8');

    const { server, port } = await startMockServer();
    const mockManager = { emit: () => {} };
    const session = new FocusSession({
      id: 'f-activity-test',
      manager: mockManager,
      description: 'inspect note.txt',
      prompt: 'Read note.txt and report its contents.',
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

    assert.strictEqual(session.status, 'done', `expected done, got ${session.status}`);
    assert.strictEqual(session.finalReport, 'note.txt says hello.');

    // getDetail() exposes the full recent log — must contain a real tool
    // record for the "read" call and thought records for both rounds' prose.
    const detail = session.getDetail();
    const toolEntry = detail.log.find((l) => l.kind === 'tool');
    assert(toolEntry, 'expected a tool-kind log entry');
    assert.strictEqual(toolEntry.tool, 'read');
    assert.deepStrictEqual(toolEntry.args, { filePath: 'note.txt' });
    assert.strictEqual(toolEntry.ok, true);
    assert(toolEntry.output.includes('hello'), `expected the tool output to include the file contents, got: ${toolEntry.output}`);

    const thoughts = detail.log.filter((l) => l.kind === 'thought').map((l) => l.text);
    assert(thoughts.some((t) => t.includes('Let me read the note first')), 'expected the first round\'s thinking prose to be logged');
    assert(thoughts.some((t) => t.includes('wrapping up')), 'expected the second round\'s thinking prose to be logged');

    assert.strictEqual(detail.toolCalls, 1, 'focus_complete must not count toward the tool-call tally');
    assert.strictEqual(detail.prompt, 'Read note.txt and report its contents.');
    assert.strictEqual(detail.finalReport, 'note.txt says hello.');

    // getStatus() (the list-card view) stays a lightweight last-5 preview —
    // same underlying records, just capped, so the list never balloons.
    const status = session.getStatus();
    assert(status.log.length <= 5);
    assert(status.log.every((l) => 'kind' in l), 'status log entries must still be structured records, not bare strings');

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  await checkAsync('getStatus caps at the last 5 entries even when far more activity occurred', async () => {
    const cwd = mkTmp('voidcode-focus-cap-');
    const mockManager = { emit: () => {} };
    const session = new FocusSession({
      id: 'f-cap-test',
      manager: mockManager,
      description: 'cap test',
      prompt: 'irrelevant',
      deadlineMs: 60000,
      mode: 'task',
      agentRefs: { provider: {}, cfg: {}, cwd, mcpServers: [], toolCtx: {}, contextResolver: null, organism: null },
    });

    for (let i = 0; i < 20; i++) {
      session.addLog({ kind: 'tool', tool: `tool_${i}`, args: {}, ok: true, output: `result ${i}` });
    }

    assert.strictEqual(session.getStatus().log.length, 5);
    assert.strictEqual(session.getStatus().log[4].tool, 'tool_19', 'the last-5 preview must be the MOST RECENT entries');
    assert.strictEqual(session.getDetail().log.length, 20, 'getDetail should return the full recent history, not just 5');

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  await checkAsync('addLog stays backward compatible with plain-string narrative calls (existing error/milestone sites)', () => {
    const cwd = mkTmp('voidcode-focus-strcompat-');
    const mockManager = { emit: () => {} };
    const session = new FocusSession({
      id: 'f-str-test', manager: mockManager, description: 'x', prompt: 'x',
      deadlineMs: 60000, mode: 'task',
      agentRefs: { provider: {}, cfg: {}, cwd, mcpServers: [], toolCtx: {}, contextResolver: null, organism: null },
    });
    session.addLog('compacting context…');
    const entry = session.getStatus().log[0];
    assert.strictEqual(entry.kind, 'note');
    assert.strictEqual(entry.text, 'compacting context…');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  await checkAsync('FocusManager.getDetail round-trips to the right session and returns null for an unknown id', () => {
    const cwd = mkTmp('voidcode-focus-manager-');
    const manager = new FocusManager({ provider: {}, cfg: {}, cwd, mcpServers: [] });
    manager.setToolCtx({});
    const session = new FocusSession({
      id: 'f-manager-test', manager, description: 'manager test', prompt: 'x',
      deadlineMs: 60000, mode: 'task',
      agentRefs: manager.agentRefs,
    });
    manager.sessions.set(session.id, session);

    const detail = manager.getDetail(session.id);
    assert(detail, 'expected a detail payload for a known session id');
    assert.strictEqual(detail.id, session.id);
    assert.strictEqual(manager.getDetail('nonexistent-id'), null);

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall focus activity tests passed');
  process.exit(failures ? 1 : 0);
}

main();
