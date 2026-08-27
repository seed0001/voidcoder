// Regression test for the reported failure mode: a long, tool-heavy turn
// (the agent analyzing/planning across many files) crosses the mid-turn
// budget guard inside Agent._loop() and used to get its ENTIRE history —
// including the plan/analysis it had just built — flattened into one lossy
// summary, because the old tail-selection logic came up empty whenever the
// last message was a tool result (the normal state mid-turn). That forced
// the agent to keep re-deriving its own plan, burning rounds/tokens across a
// single turn.
//
// This proves the fix: the most recent tool round survives verbatim across
// mid-turn retirement, and the durable plan (the roadmap + a pinned original
// task, both outside session.messages) is never destroyed regardless of how
// many times retirement fires during one turn.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { Agent } = require('../src/agent');

let failures = 0;
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${err.stack || err.message}`); }
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
    todos: [],
    originalTask: '',
    fileBackups: [],
    save() {},
    recordFileChange() {},
  };
}

async function main() {
  const summaryServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: 'ROADMAP:\ncomplete: none\nin_progress: none\nnew: none\n\nMEMORY:\n- none\n\nPOINTER: Read several auth module files during planning.' } }],
      }));
    });
  });
  await new Promise((r) => summaryServer.listen(0, '127.0.0.1', r));
  const summaryPort = summaryServer.address().port;

  const bigPlan = 'PLAN: ' + Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: inspect module_${i}.js.`).join(' ');
  const TOTAL_FILES = 12;
  let round = 0;
  const scriptFn = async () => {
    const r = round++;
    if (r <= TOTAL_FILES) {
      return { content: '', toolCalls: [toolCall(`c${r}`, 'read', { path: `module_${r}.js` })], finishReason: 'tool_calls', usage: null };
    }
    return { content: 'Done analyzing.', toolCalls: [], finishReason: 'stop', usage: null };
  };

  const bigFileContent = 'x'.repeat(1500);
  const fakeTools = {
    apiDefs: [{ type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
    executors: { read: async (args) => `// contents of ${args.path}\n${bigFileContent}` },
  };

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'voidcode-midturn-'));
  const session = makeSession();
  session.messages.push({ role: 'assistant', content: bigPlan });

  const cfg = {
    provider: 'mock', model: 'mock-model', agentMode: 'legacy',
    maxToolRounds: 30, compactAt: 0.75, contextTokens: 3000,
  };
  const provider = { name: 'mock', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: 'mock-model', contextTokens: 3000 };
  const permissions = { check: async () => true };

  const agent = new Agent({ cfg, provider, session, permissions, events: {}, cwd, streamChatFn: scriptFn });
  agent.smallProvider = () => ({ name: 'mock', baseUrl: `http://127.0.0.1:${summaryPort}/v1`, apiKey: '', model: 'summarizer', contextTokens: 3000 });
  agent.tools = fakeTools;

  let compactCalls = 0;
  const origCompact = agent.compact.bind(agent);
  agent.compact = async (...args) => { compactCalls++; return origCompact(...args); };

  const result = await agent.send('Please analyze the auth module and propose a refactor plan.');
  summaryServer.close();

  await checkAsync('mid-turn retirement fires during a long tool-heavy turn (reproduces the original trigger condition)', async () => {
    assert(compactCalls > 0, 'expected retirement to fire at least once during this long turn');
  });

  await checkAsync('the most recent tool round always survives retirement verbatim, even when the message list ends on a tool result', async () => {
    const roles = session.messages.map((m) => m.role);
    assert(roles.includes('tool'), `expected at least one surviving tool-result message, got roles: ${JSON.stringify(roles)}`);
    assert(session.messages.some((m) => Array.isArray(m.tool_calls) && m.tool_calls.length), 'expected a surviving assistant tool_calls message');
  });

  await checkAsync('the original task is never lost, even after many rounds of retirement in one turn', async () => {
    assert.strictEqual(session.originalTask, 'Please analyze the auth module and propose a refactor plan.');
  });

  await checkAsync('no two consecutive user messages after repeated mid-turn retirement', async () => {
    const msgs = session.messages;
    for (let i = 1; i < msgs.length; i++) {
      assert(!(msgs[i - 1].role === 'user' && msgs[i].role === 'user'), `two consecutive user messages at ${i - 1}/${i}`);
    }
  });

  fs.rmSync(cwd, { recursive: true, force: true });

  if (failures) {
    console.error(`\n${failures} midTurnCompaction test(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll midTurnCompaction tests passed.');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
