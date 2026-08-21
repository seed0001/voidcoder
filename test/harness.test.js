// End-to-end harness test. Spins up a mock OpenAI-compatible streaming server
// that scripts a multi-round tool session (write → edit → bash → read → done),
// runs `voidcode -p` against it in a temp project, and asserts real effects on
// disk. Also unit-tests glob translation and diffing. No API keys needed.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${err.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${err.message}`); }
}

// ---------------- unit: glob ----------------
const { globToRegex } = require('../src/tools/searchTools');
check('glob **/*.js matches nested', () => assert(globToRegex('**/*.js').test('src/a/b.js')));
check('glob *.js rejects nested', () => assert(!globToRegex('*.js').test('src/b.js')));
check('glob {a,b} alternation', () => assert(globToRegex('*.{js,ts}').test('x.ts')));

// ---------------- unit: resolveProvider ----------------
const { resolveProvider } = require('../src/config');
const { normalizeUserInput } = require('../src/agent');

check('multimodal input normalizes text and image data', () => {
  const input = normalizeUserInput({
    text: 'What is wrong?',
    images: [{ name: 'error.png', mimeType: 'image/png', bytes: 4, dataUrl: 'data:image/png;base64,AAAA' }],
  });
  assert.strictEqual(input.text, 'What is wrong?');
  assert.strictEqual(input.images[0].mimeType, 'image/png');
});
check('multimodal input rejects unsupported image types', () => assert.throws(() => normalizeUserInput({ text: 'x', images: [{ mimeType: 'text/plain', bytes: 1, dataUrl: 'data:text/plain;base64,AA==' }] }), /Unsupported image type/));
check('multimodal input rejects oversized images', () => assert.throws(() => normalizeUserInput({ text: 'x', images: [{ mimeType: 'image/png', bytes: 10 * 1024 * 1024 + 1, dataUrl: 'data:image/png;base64,AA==' }] }), /larger than 10 MB|between 1 byte/));
check('resolveProvider does not override provider when loading config with model starting with another provider name', () => {
  const cfg = {
    provider: 'openrouter',
    model: 'openai/gpt-4-turbo-preview',
    providers: {
      openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'or-key' },
      openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'oa-key' }
    }
  };
  const resolved = resolveProvider(cfg);
  assert.strictEqual(resolved.name, 'openrouter');
  assert.strictEqual(resolved.model, 'openai/gpt-4-turbo-preview');
  assert.strictEqual(resolved.apiKey, 'or-key');
});

check('resolveProvider overrides provider when overrideModel has provider prefix', () => {
  const cfg = {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.5',
    providers: {
      openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'or-key' },
      openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'oa-key' }
    }
  };
  const resolved = resolveProvider(cfg, 'openai/gpt-4-turbo-preview');
  assert.strictEqual(resolved.name, 'openai');
  assert.strictEqual(resolved.model, 'gpt-4-turbo-preview');
  assert.strictEqual(resolved.apiKey, 'oa-key');
});

check('resolveProvider includes contextTokens from provider configuration', () => {
  const cfg = {
    provider: 'ollama',
    model: 'llama3.2',
    providers: {
      ollama: { baseUrl: 'http://localhost:11434/v1', apiKey: '', contextTokens: 8192 }
    }
  };
  const resolved = resolveProvider(cfg);
  assert.strictEqual(resolved.name, 'ollama');
  assert.strictEqual(resolved.contextTokens, 8192);
});

check('resolveModelRef returns null for non-existent openrouter model ref to allow fallback', async () => {
  const catalogModule = require('../src/modelCatalog');
  const cfg = {
    providers: {
      openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' }
    }
  };
  const origDiscover = catalogModule.discoverModels;
  catalogModule.discoverModels = async () => [];
  
  const ref = await catalogModule.resolveModelRef(cfg, ROOT, 'openrouter/deepseek/deepseek-websearch');
  catalogModule.discoverModels = origDiscover;
  
  assert.strictEqual(ref, null);
});

// ---------------- unit: diff ----------------
const { diffLines } = require('../src/ui');
check('diff detects change', () => {
  const out = diffLines('a\nb\nc', 'a\nB\nc').join('\n');
  assert(out.includes('B') && out.includes('b'));
});

// ---------------- unit: relative paths resolve against the project cwd ----------------
// Regression: expand() used to resolve against process.cwd() (the launch/install
// directory), so relative tool paths escaped the selected project folder.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voidcode-cwd-'));
  const fsExec = require('../src/tools/fsTools').makeExecutors({ cwd: tmp });
  fsExec.write({ filePath: 'rel-note.txt', content: 'x' });
  check('write with relative path lands in ctx.cwd', () => assert(fs.existsSync(path.join(tmp, 'rel-note.txt'))));
  check('ls "." lists ctx.cwd, not process.cwd()', () => assert(fsExec.ls({ path: '.' }).startsWith(tmp)));
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------------- unit: buildSystemPrompt with persona and memory ----------------
{
  const { buildSystemPrompt } = require('../src/prompt');
  const config = require('../src/config');
  const oldCfg = config.load();
  const backupPersona = oldCfg.persona;
  const backupMemory = oldCfg.memory;
  try {
    config.saveGlobal({ persona: 'CUSTOM_TEST_PERSONA', memory: 'CUSTOM_TEST_MEMORY' });
    const promptText = buildSystemPrompt({ cwd: ROOT });
    assert(promptText.includes('CUSTOM_TEST_PERSONA'), 'should contain custom persona');
    assert(promptText.includes('CUSTOM_TEST_MEMORY'), 'should contain custom memory');
    console.log('  ok  buildSystemPrompt includes custom persona and memory');
  } catch (err) {
    failures++;
    console.error(`FAIL  buildSystemPrompt persona/memory: ${err.message}`);
  } finally {
    config.saveGlobal({ persona: backupPersona, memory: backupMemory });
  }
}

// ---------------- unit: desktop UI theme defaults ----------------
{
  const { DEFAULTS } = require('../src/config');
  check('DEFAULTS.ui.theme is void', () => {
    assert.strictEqual(DEFAULTS.ui.theme, 'void');
    assert.strictEqual(DEFAULTS.ui.pacer, true);
  });
}

// ---------------- e2e: agent loop against mock provider ----------------

function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

function streamToolCall(res, id, name, argsJson) {
  // split arguments across chunks to exercise accumulation
  const half = Math.ceil(argsJson.length / 2);
  sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: argsJson.slice(0, half) } }] } }] });
  sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(half) } }] } }] });
  sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

function streamText(res, text) {
  for (const word of text.split(' ')) sse(res, { choices: [{ index: 0, delta: { content: word + ' ' } }] });
  sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voidcode-test-'));
  const testFile = path.join(tmp, 'hello.txt').replace(/\\/g, '\\\\');

  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body);
      requests.push(payload);
      const toolMsgs = payload.messages.filter((m) => m.role === 'tool');
      const isWorker = payload.messages && String(payload.messages[1]?.content || '').startsWith('# Work request');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (isWorker) {
        // Action side: script the write→edit→bash→read→report tool session.
        const stage = toolMsgs.length;
        if (stage === 0) streamToolCall(res, 'c1', 'write', JSON.stringify({ filePath: testFile.replace(/\\\\/g, '\\'), content: 'hello world' }));
        else if (stage === 1) streamToolCall(res, 'c2', 'edit', JSON.stringify({ filePath: testFile.replace(/\\\\/g, '\\'), oldString: 'world', newString: 'voidcode' }));
        else if (stage === 2) streamToolCall(res, 'c3', 'bash', JSON.stringify({ command: process.platform === 'win32' ? "Write-Output 'bash-roundtrip-ok'" : "echo 'bash-roundtrip-ok'" }));
        else if (stage === 3) streamToolCall(res, 'c4', 'read', JSON.stringify({ filePath: testFile.replace(/\\\\/g, '\\') }));
        else {
          const readResult = toolMsgs[3].content;
          streamText(res, `FINAL:${readResult.includes('voidcode') ? 'READBACK-OK' : 'READBACK-MISSING'} BASH:${toolMsgs[2].content.includes('bash-roundtrip-ok') ? 'OK' : 'MISSING'}`);
        }
      } else if (toolMsgs.length === 0) {
        // Chat side, first turn: delegate a plain-text work block (no tool defs).
        streamText(res, `I'll get that done. \`\`\`json\n{"name": "work", "arguments": {"task": "run the scripted test"}}\n\`\`\``);
      } else {
        // Chat side, after the worker reported: relay the report back.
        const report = toolMsgs[toolMsgs.length - 1].content;
        streamText(res, `Done. ${report.includes('READBACK-OK') ? 'READBACK-OK' : 'READBACK-MISSING'} ${report.includes('BASH:OK') ? 'BASH:OK' : 'BASH:MISSING'}`);
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // temp project config pointing at the mock, everything auto-allowed
  fs.writeFileSync(path.join(tmp, '.voidcode.json'), JSON.stringify({
    provider: 'mock',
    model: 'mock-model',
    agentMode: 'split',
    providers: { mock: { baseUrl: `http://127.0.0.1:${port}/v1` } },
    permissions: { bash: 'allow', write: 'allow', edit: 'allow', webfetch: 'allow' },
  }));

  const { stdout, stderr, code } = await new Promise((resolve) => {
    execFile('node', [path.join(ROOT, 'bin', 'voidcode.js'), '-p', 'run the scripted test'], {
      cwd: tmp, timeout: 60000, env: { ...process.env, NO_COLOR: '1' },
    }, (err, out, serr) => resolve({ stdout: out, stderr: serr, code: err ? err.code : 0 }));
  });

  server.close();

  check('e2e: exit code 0', () => assert.strictEqual(code, 0, `stderr: ${stderr.slice(0, 500)}`));
  const workerReq = requests.find((payload) => String(payload.messages?.[1]?.content || '').startsWith('# Work request'));
  // chat delegation (1) + worker write/edit/bash/read/report (5) + chat final (1)
  check('e2e: split flow request count', () => assert.strictEqual(requests.length, 7, `got ${requests.length}`));
  check('e2e: chat side carries no tools', () => assert.strictEqual((requests[0].tools || []).length, 0));
  check('e2e: chat system prompt is the delegation prompt', () => assert(requests[0].messages[0].content.includes('Work delegation'), 'no Work delegation block'));
  check('e2e: worker advertised the full toolset', () => assert(workerReq && workerReq.tools.some((t) => t.function.name === 'bash') && workerReq.tools.some((t) => t.function.name === 'task'), 'worker did not advertise bash+task'));
  check('e2e: worker system prompt is the action prompt', () => assert(workerReq && workerReq.messages[0].content.includes('Work agent (action side)'), 'no action-agent block'));
  check('e2e: file written+edited on disk', () => {
    const real = path.join(tmp, 'hello.txt');
    assert.strictEqual(fs.readFileSync(real, 'utf8'), 'hello voidcode');
  });
  check('e2e: model saw edit-readback + bash output', () => assert(stdout.includes('FINAL:READBACK-OK') && stdout.includes('BASH:OK'), stdout.slice(-500)));
  check('e2e: session persisted with history', () => {
    const projRoot = path.join(os.homedir(), '.voidcode', 'projects');
    const dirs = fs.readdirSync(projRoot).filter((d) => fs.statSync(path.join(projRoot, d)).isDirectory());
    const slug = dirs.find((d) => {
      try { return fs.readdirSync(path.join(projRoot, d)).some((f) => f.endsWith('.json')); } catch { return false; }
    });
    assert(slug, 'no project session dir found');
    // find a session containing our unique prompt
    let found = false;
    for (const d of dirs) {
      for (const f of fs.readdirSync(path.join(projRoot, d)).filter((x) => x.endsWith('.json'))) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(projRoot, d, f), 'utf8'));
          if (JSON.stringify(data.messages || []).includes('run the scripted test')) found = true;
        } catch { }
      }
    }
    assert(found, 'session with test prompt not found');
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  // ---------------- unit: stalled-stream watchdog ----------------
  // Regression: a provider connection that went silent mid-stream used to hang
  // reader.read() forever, freezing the agent loop with no error.
  const { streamChat } = require('../src/providers');

// ---------------- multimodal provider request ----------------
{
  const imageServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      const user = payload.messages.find((m) => m.role === 'user');
      check('streamChat sends OpenAI multimodal image content', () => {
        assert(Array.isArray(user.content));
        assert.strictEqual(user.content[1].type, 'image_url');
        assert.strictEqual(user.content[1].image_url.url, 'data:image/png;base64,AAAA');
      });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((r) => imageServer.listen(0, '127.0.0.1', r));
  try {
    await streamChat({ name: 'mock', baseUrl: `http://127.0.0.1:${imageServer.address().port}/v1`, model: 'vision' }, [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }], null);
  } finally { imageServer.close(); }
}
  const stallServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
    // ...then never send another byte and never end the response
  });
  await new Promise((r) => stallServer.listen(0, '127.0.0.1', r));
  let stallErr = null;
  try {
    await streamChat(
      { name: 'mock', baseUrl: `http://127.0.0.1:${stallServer.address().port}/v1`, model: 'mock-model' },
      [{ role: 'user', content: 'x' }], null, { idleTimeoutMs: 400 });
  } catch (e) { stallErr = e; }
  await new Promise((resolve) => setTimeout(resolve, 50));
  stallServer.closeAllConnections?.();
  stallServer.close();
  check('stalled stream aborts with a descriptive error (not AbortError)', () =>
    assert(stallErr && stallErr.name !== 'AbortError' && /stalled/.test(String(stallErr.message)), String(stallErr)));

  // ---------------- unit: tool call thought_signature parsing ----------------
  const sigServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
    res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"write"},"thought_signature":"sig_abc"}]}}]}\n\n');
    res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"filePath\\": \\"test.txt\\"}"},"thought_signature":"_def"}]}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => sigServer.listen(0, '127.0.0.1', r));
  let parsedRes = null;
  try {
    parsedRes = await streamChat(
      { name: 'mock', baseUrl: `http://127.0.0.1:${sigServer.address().port}/v1`, model: 'mock-model' },
      [{ role: 'user', content: 'x' }],
      [{ type: 'function', function: { name: 'write', description: 'desc' } }]
    );
  } catch (e) { console.error(e); }
  await new Promise((resolve) => setTimeout(resolve, 50));
  sigServer.closeAllConnections?.();
  sigServer.close();
  check('streamChat parses and preserves custom tool call fields (like thought_signature)', () => {
    assert(parsedRes && parsedRes.toolCalls && parsedRes.toolCalls.length === 1);
    const tc = parsedRes.toolCalls[0];
    assert.strictEqual(tc.id, 'call_123');
    assert.strictEqual(tc.function.name, 'write');
    assert.strictEqual(tc.function.arguments, '{"filePath": "test.txt"}');
    assert.strictEqual(tc.thought_signature, 'sig_abc_def');
  });

  // ---------------- unit: agent loop Jinja template retry fallback ----------------
  let jinjaRequests = [];
  const jinjaServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body);
      jinjaRequests.push(payload);
      if (payload.tools && payload.tools.length > 0) {
        // Send HTTP 400 simulating Ollama's Jinja template compilation failure
        res.writeHead(400, { 'Content-Type': 'application/json', 'Connection': 'close' });
        res.end(JSON.stringify({
          error: {
            code: 400,
            message: "Unable to generate parser for this template. Automatic parser generation failed: Jinja Exception: No user query found in messages.",
            type: "invalid_request_error"
          }
        }));
      } else {
        // Success case (no tools passed)
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
        res.write('data: {"choices":[{"index":0,"delta":{"content":"success without tools"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });
  });
  await new Promise((r) => jinjaServer.listen(0, '127.0.0.1', r));
  
  const { Agent } = require('../src/agent');
  const testAgent = new Agent({
    cfg: {
      provider: 'ollama',
      model: 'qwythos',
      agentMode: 'legacy', // tool-loop mechanics test: monolithic inline tools
      providers: {
        ollama: { baseUrl: `http://127.0.0.1:${jinjaServer.address().port}/v1`, apiKey: '', contextTokens: 4096 }
      },
      maxToolRounds: 5,
      compactAt: 0.75,
      contextTokens: 4096
    },
    provider: { name: 'ollama', baseUrl: `http://127.0.0.1:${jinjaServer.address().port}/v1`, apiKey: '', model: 'qwythos', contextTokens: 4096 },
    session: { messages: [], usage: { input: 0, output: 0, turns: 0, activeTimeMs: 0 }, save: () => {} },
    permissions: { check: () => true },
    events: {}
  });

  let runErr = null;
  let runResult = '';
  try {
    runResult = await testAgent.send('run test query');
  } catch (e) {
    runErr = e;
  }
  
  await new Promise((resolve) => setTimeout(resolve, 50));
  jinjaServer.closeAllConnections?.();
  jinjaServer.close();
  
  check('agent loop self-heals/retries without tools when Ollama returns Jinja template error', () => {
    assert.strictEqual(runErr, null, runErr?.message);
    assert.strictEqual(runResult, 'success without tools');
    assert.strictEqual(jinjaRequests.length, 2);
    assert(jinjaRequests[0].tools && jinjaRequests[0].tools.length > 0);
    assert(!jinjaRequests[1].tools);
  });

  // ---------------- unit: needsCompaction factors in system prompt and tools ----------------
  check('needsCompaction factors in system prompt and tool tokens', () => {
    const agentForCompaction = new Agent({
      cfg: {
        provider: 'ollama',
        model: 'qwythos',
        agentMode: 'legacy',
        compactAt: 0.75,
        contextTokens: 4096
      },
      provider: { name: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwythos', contextTokens: 4096 },
      session: { messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' }
      ] },
      permissions: { check: () => true },
      events: {}
    });

    // Static overhead (system prompt) must never trigger compaction by itself.
    // A short conversation must not be destroyed just because the window is
    // small and the fixed prompt+tool overhead is large — this floor is what
    // kept compaction from firing before every send (the total-amnesia bug).
    assert(!agentForCompaction.needsCompaction(3060));

    // Even a moderately sized history below the 15% floor stays untouched.
    agentForCompaction.session.messages.push({ role: 'user', content: 'x'.repeat(2000) });
    assert(!agentForCompaction.needsCompaction(3060));

    // A genuinely large history combined with the system prompt triggers it.
    agentForCompaction.session.messages.push({ role: 'user', content: 'y'.repeat(20000) });
    assert(agentForCompaction.needsCompaction(3060));
  });

  // ---------------- unit: compact() never produces two consecutive user turns,
  // and never silently drops a tool_calls/tool-result pair ----------------
  // Regression for a real bug: pinning the session-opening user message as its
  // own leading turn, directly before the compacted-summary user message, put
  // two user-role messages back to back with no assistant reply between them.
  // A local model (via Ollama) reading that shape treated the original opening
  // question as a brand-new, unanswered prompt and answered it from scratch —
  // reading as "the agent reverted to the very beginning" after compaction.
  await checkAsync('compact() never emits two consecutive user messages and preserves the opening task', async () => {
    const summaryServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'Summary: wrote foo.js and bar.js so far.' } }] }));
      });
    });
    await new Promise((r) => summaryServer.listen(0, '127.0.0.1', r));
    const port = summaryServer.address().port;

    const agent = new Agent({
      cfg: { provider: 'mock', model: 'mock', agentMode: 'legacy', compactAt: 0.75, contextTokens: 128000 },
      provider: { name: 'mock', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', model: 'mock', contextTokens: 128000 },
      session: {
        messages: [
          { role: 'user', content: 'Build me an AR game called Echoes of the Past.' },
          { role: 'assistant', content: 'Sure — starting with the location manager.' },
          { role: 'user', content: 'sounds good' },
          { role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'write', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: '1', content: 'Wrote 40 lines to LocationManager.cs' },
          { role: 'assistant', content: 'Wrote LocationManager.cs, moving to the next file.' },
        ],
        save() {},
      },
      permissions: { check: () => true },
      events: {},
    });

    const changed = await agent.compact();
    assert(changed, 'compact() should have run');
    summaryServer.close();

    const msgs = agent.session.messages;
    for (let i = 1; i < msgs.length; i++) {
      assert(!(msgs[i - 1].role === 'user' && msgs[i].role === 'user'), `two consecutive user messages at index ${i - 1}/${i}: ${JSON.stringify(msgs.map(m => m.role))}`);
    }
    assert(msgs[0].role === 'user' && msgs[0].content.includes('Build me an AR game called Echoes of the Past.'), 'original task must survive, folded into the first message');
    assert(msgs[0].content.includes('Summary: wrote foo.js and bar.js'), 'compacted summary must be present');

    // The tool_calls/tool-result pair must not be split: it either both
    // survive verbatim in the tail, or neither does (fully summarized).
    const hasToolCall = msgs.some((m) => m.tool_calls);
    const hasToolResult = msgs.some((m) => m.role === 'tool');
    assert.strictEqual(hasToolCall, hasToolResult, `tool_calls/tool-result pair got split: ${JSON.stringify(msgs)}`);
  });

  // ---------------- unit: two-sided prompt blocks ----------------
  const { buildSystemPrompt } = require('../src/prompt');
  check('buildSystemPrompt chat side strips tools and adds delegation', () => {
    const chatPrompt = buildSystemPrompt({ cwd: os.tmpdir(), side: 'chat', contextTokens: 32768 });
    assert(chatPrompt.includes('Work delegation (you have NO tools)'), 'no delegation block');
    assert(!chatPrompt.includes('# Tool Calling Fallback'), 'chat must not get the tool fallback block');
    assert(!chatPrompt.includes('# Model management (main agent)'), 'chat must not get model management');
    const workPrompt = buildSystemPrompt({ cwd: os.tmpdir(), worker: true, contextTokens: 16384 });
    assert(workPrompt.includes('Work agent (action side)'), 'no action-agent block');
    assert(workPrompt.includes('# Tool Calling Fallback'), 'worker keeps the tool fallback block');
    assert(!workPrompt.includes('# Work delegation'), 'worker must not get the chat delegation block');
  });

  // ---------------- split-mode handoff integration ----------------
  const splitRequests = [];
  const splitServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body);
      splitRequests.push(payload);
      const isWorker = String(payload.messages?.[1]?.content || '').startsWith('# Work request');
      const toolsIn = payload.messages ? payload.messages.filter((m) => m.role === 'tool') : [];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (isWorker) {
        streamText(res, toolsIn.length === 0 ? 'worker report READBACK-OK BASH:OK' : 'worker report again');
      } else if (toolsIn.length === 0) {
        streamText(res, '```json\n{"name": "work", "arguments": {"task": "task X"}}\n```');
      } else {
        streamText(res, 'all done');
      }
    });
  });
  await new Promise((r) => splitServer.listen(0, '127.0.0.1', r));
  const splitPort = splitServer.address().port;
  const splitAgent = new Agent({
    cfg: {
      provider: 'mock', model: 'mock', agentMode: 'split', chatContextTokens: 32768,
      providers: { mock: { baseUrl: `http://127.0.0.1:${splitPort}/v1` } },
      maxToolRounds: 5, contextTokens: 200000,
    },
    provider: { name: 'mock', baseUrl: `http://127.0.0.1:${splitPort}/v1`, model: 'mock' },
    session: { messages: [], usage: { input: 0, output: 0, turns: 0, activeTimeMs: 0 }, save: () => {} },
    permissions: { check: () => true },
    events: {},
  });
  let splitResult = '';
  try { splitResult = await splitAgent.send('do a thing'); } catch (e) { splitResult = 'ERR:' + e.message; }
  await new Promise((r) => setTimeout(r, 50));
  splitServer.closeAllConnections?.();
  splitServer.close();
  check('split: chat delegates plain-text work to the worker and relays the report', () => {
    assert.strictEqual(String(splitResult).trim(), 'all done', JSON.stringify(splitResult));
    assert(splitRequests.some((p) => String(p.messages?.[1]?.content || '').startsWith('# Work request')), 'no worker request seen');
    const chatReqs = splitRequests.filter((p) => !String(p.messages?.[1]?.content || '').startsWith('# Work request'));
    assert(chatReqs.every((p) => (p.tools || []).length === 0), 'chat should carry no tools');
    const wrk = splitRequests.find((p) => String(p.messages?.[1]?.content || '').startsWith('# Work request'));
    assert(wrk && (wrk.tools || []).length > 0, 'worker should carry tools');
    assert(chatReqs.some((p) => (p.messages || []).filter((m) => m.role === 'tool').length > 0), 'worker report not folded back into chat');
  });

  // ---------------- split handoff: chat emits any known tool name ----------------
  const looseRequests = [];
  const looseServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body);
      looseRequests.push(payload);
      const isWorker = String(payload.messages?.[1]?.content || '').startsWith('# Work request');
      const toolsIn = payload.messages ? payload.messages.filter((m) => m.role === 'tool') : [];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (isWorker) {
        streamText(res, toolsIn.length === 0 ? 'worker ran bash OK' : 'worker report again');
      } else if (toolsIn.length === 0) {
        streamText(res, '```json\n{"name": "bash", "arguments": {"command": "echo hi"}}\n```');
      } else {
        streamText(res, 'done');
      }
    });
  });
  await new Promise((r) => looseServer.listen(0, '127.0.0.1', r));
  const loosePort = looseServer.address().port;
  const looseAgent = new Agent({
    cfg: {
      provider: 'mock', model: 'mock', agentMode: 'split', chatContextTokens: 32768,
      providers: { mock: { baseUrl: `http://127.0.0.1:${loosePort}/v1` } },
      maxToolRounds: 5, contextTokens: 200000,
    },
    provider: { name: 'mock', baseUrl: `http://127.0.0.1:${loosePort}/v1`, model: 'mock' },
    session: { messages: [], usage: { input: 0, output: 0, turns: 0, activeTimeMs: 0 }, save: () => {} },
    permissions: { check: () => true },
    events: {},
  });
  try { await looseAgent.send('do a thing'); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 50));
  looseServer.closeAllConnections?.();
  looseServer.close();
  check('split: chat emitting a bare tool name (bash) is routed to the worker, not dropped', () => {
    const workerReqs = looseRequests.filter((p) => String(p.messages?.[1]?.content || '').startsWith('# Work request'));
    assert(workerReqs.length > 0, 'no worker request seen for a bare bash block');
    const taskText = String(workerReqs[0].messages?.[1]?.content || '');
    assert(taskText.includes('bash'), 'worker task should name the routed tool');
  });

  // ---------------- split handoff: mangled work args (llama3.2 style) ----------------
  const messyRequests = [];
  const messyServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body);
      messyRequests.push(payload);
      const isWorker = String(payload.messages?.[1]?.content || '').startsWith('# Work request');
      const toolsIn = payload.messages ? payload.messages.filter((m) => m.role === 'tool') : [];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (isWorker) {
        streamText(res, toolsIn.length === 0 ? 'worker researched medical terms' : 'worker report again');
      } else if (toolsIn.length === 0) {
        streamText(res, 'Researching medical terminology now.\n```json\n{\n  "name": "work",\n  "arguments": {\n    "--task": "Search external knowledge sources for missing medical terms",\n    "-timeframe: --duration (max)": "60 minutes"\n  }\n}\n```');
      } else {
        streamText(res, 'done');
      }
    });
  });
  await new Promise((r) => messyServer.listen(0, '127.0.0.1', r));
  const messyPort = messyServer.address().port;
  const messyAgent = new Agent({
    cfg: {
      provider: 'mock', model: 'mock', agentMode: 'split', chatContextTokens: 32768,
      providers: { mock: { baseUrl: `http://127.0.0.1:${messyPort}/v1` } },
      maxToolRounds: 5, contextTokens: 200000,
    },
    provider: { name: 'mock', baseUrl: `http://127.0.0.1:${messyPort}/v1`, model: 'mock' },
    session: { messages: [], usage: { input: 0, output: 0, turns: 0, activeTimeMs: 0 }, save: () => {} },
    permissions: { check: () => true },
    events: {},
  });
  try { await messyAgent.send('do a thing'); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 50));
  messyServer.closeAllConnections?.();
  messyServer.close();
  check('split: mangled work args (--task CLI style) still carry the real task to the worker', () => {
    const workerReqs = messyRequests.filter((p) => String(p.messages?.[1]?.content || '').startsWith('# Work request'));
    assert(workerReqs.length > 0, 'no worker request seen for a mangled work block');
    const taskText = String(workerReqs[0].messages?.[1]?.content || '');
    assert(taskText.includes('medical'), 'task should carry the real instruction, got: ' + taskText);
    assert(!taskText.includes("Continue the conversation"), 'must not fall back to the generic task string');
  });

  // ---------------- unit: model-aware context policy ----------------
  await checkAsync('uses live remote model context when no explicit limit is configured', async () => {
    const { Agent } = require('../src/agent');
    const catalog = require('../src/modelCatalog');
    const original = catalog.discoverModels;
    catalog.discoverModels = async () => [{ provider: 'openrouter', modelName: 'remote/large', contextTokens: 128000 }];
    try {
      const cfg = { provider: 'openrouter', model: 'remote/large', contextTokens: 0, chatContextTokens: 0, workerContextTokens: 0, agentMode: 'legacy' };
      const provider = { name: 'openrouter', model: 'remote/large' };
      const agent = new Agent({ cfg, provider, session: { messages: [], save() {} }, permissions: {}, cwd: os.tmpdir() });
      await agent.hydrateModelContext(provider);
      agent.refreshProviders();
      assert.strictEqual(agent.chatLimit, 128000);
    } finally {
      catalog.discoverModels = original;
    }
  });

  check('preserves explicit local context limits', () => {
    const { Agent } = require('../src/agent');
    const cfg = { provider: 'ollama', model: 'local', contextTokens: 8192, chatContextTokens: 0, agentMode: 'legacy' };
    const agent = new Agent({ cfg, provider: { name: 'ollama', model: 'local', contextTokens: 8192 }, session: { messages: [], save() {} }, permissions: {}, cwd: os.tmpdir() });
    agent.refreshProviders();
    assert.strictEqual(agent.chatLimit, 8192);
  });

  // ---------------- unit: tool definition compression for small context models ----------------
  check('tool build compresses apiDefs when context limit is small', () => {
    const { build: buildTools } = require('../src/tools');
    
    // Test small context (limit <= 8192)
    const ctxSmall = {
      cfg: { contextTokens: 4096 },
      provider: { name: 'ollama', contextTokens: 4096 },
      focus: {}
    };
    const toolsSmall = buildTools(ctxSmall, { includeFocus: true, includeModel: true });
    
    // Assert write description is compressed/shortened
    const writeSmall = toolsSmall.apiDefs.find(d => d.function.name === 'write');
    assert(writeSmall);
    assert.strictEqual(writeSmall.function.description, 'Write content to a file, creating parent directories if needed.');
    
    // Assert focus tools are included, but their description is compressed/shortened
    const focusSmall = toolsSmall.apiDefs.find(d => d.function.name === 'focus');
    assert(focusSmall);
    assert.strictEqual(focusSmall.function.description, 'Spawn background focus agent.');
    
    // Test large context (limit > 8192)
    const ctxLarge = {
      cfg: { contextTokens: 200000 },
      provider: { name: 'openrouter', contextTokens: 200000 },
      focus: {}
    };
    const toolsLarge = buildTools(ctxLarge, { includeFocus: true });
    const writeLarge = toolsLarge.apiDefs.find(d => d.function.name === 'write');
    assert(writeLarge);
    assert.notStrictEqual(writeLarge.function.description, 'Write content to a file, creating parent directories if needed.');
    const focusLarge = toolsLarge.apiDefs.find(d => d.function.name === 'focus');
    assert(focusLarge);
  });

  // ---------------- unit: focus session compaction ----------------
  check('FocusSession supports needsCompaction', () => {
    const { FocusSession } = require('../src/focus');
    const mockManager = { emit: () => {} };
    const session = new FocusSession({
      id: 'f-test',
      manager: mockManager,
      description: 'test focus',
      prompt: 'hello',
      deadlineMs: 60000,
      agentRefs: {
        provider: { name: 'ollama', contextTokens: 4096 },
        cfg: { contextTokens: 4096, compactAt: 0.75 }
      }
    });

    session.messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' }
    ];

    // Under limit -> false
    assert(!session.needsCompaction({ name: 'ollama', contextTokens: 4096 }, 0));

    // Exceeding limit -> true
    assert(session.needsCompaction({ name: 'ollama', contextTokens: 4096 }, 3060));
  });

  // ---------------- unit: self-healing tool call JSON recovery ----------------
  check('extractToolCallsFromText recovers truncated tool calls', () => {
    const { extractToolCallsFromText } = require('../src/providers');
    const availableTools = ['write', 'focus', 'bash'];

    // 1) Truncated raw JSON object
    const rawJsonText = 'Some explanation...\n{\n  "name": "write",\n  "arguments": {\n    "filePath": "test.txt",\n    "content": "hello"';
    const calls1 = extractToolCallsFromText(rawJsonText, availableTools);
    assert(calls1.length === 1);
    assert.strictEqual(calls1[0].function.name, 'write');
    assert.deepEqual(JSON.parse(calls1[0].function.arguments), { filePath: 'test.txt', content: 'hello' });

    // 2) Truncated markdown code block
    const mdJsonText = 'Here is the plan:\n```json\n{\n  "name": "focus",\n  "arguments": {\n    "description": "deep dive",\n    "minutes": 20';
    const calls2 = extractToolCallsFromText(mdJsonText, availableTools);
    assert(calls2.length === 1);
    assert.strictEqual(calls2[0].function.name, 'focus');
    assert.deepEqual(JSON.parse(calls2[0].function.arguments), { description: 'deep dive', minutes: 20 });
  });

  // ---------------- unit: webfetch audit log ----------------
  const { makeExecutors } = require('../src/tools/webTools');

  const tempAuditDir = path.join(__dirname, 'temp_audit_test');
  if (!fs.existsSync(tempAuditDir)) fs.mkdirSync(tempAuditDir);
  const logFile = path.join(tempAuditDir, 'research_audit_log.md');
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile);

  const origFetchWeb = global.fetch;
  global.fetch = async (url) => {
    return {
      status: 200,
      headers: { get: () => 'text/html' },
      text: async () => '<html><body><h1>Type 2 Diabetes</h1><a href="https://other-domain.com/more-info">More Info</a></body></html>'
    };
  };

  const ctx = {
    cwd: tempAuditDir,
    focusSession: {
      id: 'f-test-audit',
      description: 'Diabetes study',
      createdAt: Date.now()
    }
  };

  const executorsWeb = makeExecutors(ctx);
  await executorsWeb.webfetch({ url: 'https://example.com/diabetes' });

  global.fetch = origFetchWeb;

  const content = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  if (fs.existsSync(tempAuditDir)) fs.rmdirSync(tempAuditDir);

  check('webfetch automatically logs to research_audit_log.md in focus sessions', () => {
    assert(content.includes('# Research Audit Log'));
    assert(content.includes('f-test-audit'));
    assert(content.includes('https://example.com/diabetes'));
    assert(content.includes('https://other-domain.com/more-info'));
  });

  // ---------------- unit: websearch parsing ----------------
  const origFetchSearch = global.fetch;
  let websearchResult = '';
  global.fetch = async (url) => {
    assert(url.includes('duckduckgo.com'));
    return {
      ok: true,
      status: 200,
      text: async () => `
        <html><body>
          <h2 class="result__title">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cdc.gov%2Fdiabetes%2Findex.html">Diabetes CDC</a>
          </h2>
          <a class="result__snippet" href="#">This is a snippet about diabetes from the CDC website.</a>
        </body></html>
      `
    };
  };

  const executorsSearch = makeExecutors({});
  try {
    websearchResult = await executorsSearch.websearch({ query: 'diabetes' });
  } catch (e) {
    console.error(e);
  }
  
  global.fetch = origFetchSearch;

  check('websearch fetches and parses DuckDuckGo HTML results correctly', () => {
    assert(websearchResult.includes('Diabetes CDC'));
    assert(websearchResult.includes('https://www.cdc.gov/diabetes/index.html'));
    assert(websearchResult.includes('This is a snippet about diabetes'));
  });

  // ---------------- unit: agent loop context size error retry fallback ----------------
  let contextRequests = [];
  const contextServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body);
      contextRequests.push(payload);
      const isCompacted = payload.messages && payload.messages.some(m => String(m.content).includes('compacted') || String(m.content).includes('Compacted'));
      if (payload.messages && payload.messages.length > 2 && !isCompacted) {
        // First request with long history: fail simulating Ollama context size limit reached
        res.writeHead(400, { 'Content-Type': 'application/json', 'Connection': 'close' });
        res.end(JSON.stringify({
          error: {
            code: 400,
            message: "request (5000 tokens) exceeds the available context size (4096 tokens), try increasing it",
            type: "exceed_context_size_error"
          }
        }));
      } else {
        // Success case (after compaction/shorter history)
        if (payload.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'close' });
          res.write('data: {"choices":[{"index":0,"delta":{"content":"success after compaction"}}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
          res.end(JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'short summary'
                }
              }
            ]
          }));
        }
      }
    });
  });
  await new Promise((r) => contextServer.listen(0, '127.0.0.1', r));
  
  const testAgentContext = new Agent({
    cfg: {
      provider: 'ollama',
      model: 'qwythos',
      agentMode: 'legacy',
      providers: {
        ollama: { baseUrl: `http://127.0.0.1:${contextServer.address().port}/v1`, apiKey: '', contextTokens: 8192 }
      },
      maxToolRounds: 5,
      compactAt: 0.75,
      contextTokens: 200000,
      contextDb: { enabled: false },
    },
    provider: { name: 'ollama', baseUrl: `http://127.0.0.1:${contextServer.address().port}/v1`, apiKey: '', model: 'qwythos', contextTokens: 200000 },
    session: { 
      messages: [
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'msg4' },
        { role: 'user', content: 'msg5' },
        { role: 'assistant', content: 'msg6' },
        { role: 'user', content: 'msg7' },
        { role: 'assistant', content: 'msg8' }
      ],
      usage: { input: 0, output: 0, turns: 0, activeTimeMs: 0 },
      save: () => {}
    },
    permissions: { check: () => true },
    events: {}
  });

  let contextErr = null;
  let contextResult = '';
  try {
    contextResult = await testAgentContext.send('run test query');
  } catch (e) {
    contextErr = e;
  }
  
  await new Promise((resolve) => setTimeout(resolve, 50));
  contextServer.closeAllConnections?.();
  contextServer.close();
  
  check('agent loop self-heals/retries and compacts when Ollama returns context size error', () => {
    assert.strictEqual(contextErr, null, contextErr?.message);
    assert.strictEqual(contextResult, 'success after compaction');
    assert.strictEqual(testAgentContext.provider.contextTokens, 4096); // learned limit
    assert(testAgentContext.session.messages.some(m => m.content.includes('compacted') || m.content.includes('Compacted')));
  });

  // ---------------- unit: session history sanitization ----------------
  check('Session.load sanitizes history by filtering empty assistant messages', () => {
    const fs = require('fs');
    const path = require('path');
    const { Session } = require('../src/sessions');

    const tempDir = path.join(__dirname, 'temp_session_test');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    const testSession = new Session(tempDir, 'test-poisoned-session');
    testSession.messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'how are you' },
      { role: 'assistant', content: ' ' },
      { role: 'assistant', content: 'fine', tool_calls: [] } // Has text -> keep
    ];
    testSession.save();

    const loaded = Session.load(tempDir, 'test-poisoned-session');

    // Clean up
    fs.unlinkSync(testSession.file);
    fs.rmdirSync(tempDir);

    assert.strictEqual(loaded.messages.length, 3);
    assert.strictEqual(loaded.messages[0].content, 'hello');
    assert.strictEqual(loaded.messages[1].content, 'how are you');
    assert.strictEqual(loaded.messages[2].content, 'fine');
  });

  // ---------------- unit: cognitive scratchpad prompt rendering ----------------
  check('buildSystemPrompt includes cognitive scratchpad when provided', () => {
    const { buildSystemPrompt } = require('../src/prompt');
    const systemPrompt = buildSystemPrompt({
      cwd: ROOT,
      scratchpad: '* Goal: Research plants\n* Findings: Found Rubiaceae family'
    });
    
    assert(systemPrompt.includes('# Cognitive Scratchpad (Current Status & Next Steps)'));
    assert(systemPrompt.includes('Research plants'));
    assert(systemPrompt.includes('Found Rubiaceae family'));
  });

  // ---------------- unit: guardrails turn interceptor + learning memory ----------------
  const guardrails = require('../src/guardrails');
  const gTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voidcode-guardrails-'));
  guardrails.setStorePath(path.join(gTmp, 'learnings.md'));
  const gCfg = { guardrails: { maxZeroHitStreak: 3, maxLearningsInjected: 3 } };

  try {
    check('toolOutcome classifies error/zero/benign/content', () => {
      assert.strictEqual(guardrails.toolOutcome(''), 'error');
      assert.strictEqual(guardrails.toolOutcome('ERROR: unknown tool "x"'), 'error');
      assert.strictEqual(guardrails.toolOutcome('DENIED: permission check failed'), 'error');
      assert.strictEqual(guardrails.toolOutcome('No search results found.'), 'zero');
      assert.strictEqual(guardrails.toolOutcome('No matches.'), 'zero');
      assert.strictEqual(guardrails.toolOutcome('(no new messages)'), 'benign');
      assert.strictEqual(guardrails.toolOutcome('here are results about subjects'), 'content');
    });

    check('zeroHitStreak counts trailing empty/error tool results only', () => {
      const msgs = [
        { role: 'user', content: 'x' },
        { role: 'tool', content: 'No search results found.' },
        { role: 'tool', content: 'No search results found.' },
        { role: 'tool', content: 'ERROR: fetch failed' },
      ];
      assert.strictEqual(guardrails.zeroHitStreak(msgs), 3);
      msgs.push({ role: 'tool', content: 'lorem ipsum content' });
      assert.strictEqual(guardrails.zeroHitStreak(msgs), 0);
      msgs.push({ role: 'tool', content: '(no new messages)' });
      assert.strictEqual(guardrails.zeroHitStreak(msgs), 0, 'benign no-result must not count as a hit');
    });

    check('detectForeignScript flags non-Latin scrapes', () => {
      assert.strictEqual(guardrails.detectForeignScript('hello world plain facts'), null);
      assert.strictEqual(guardrails.detectForeignScript('关于模型的信息 很多内容需要翻译'), 'CJK (Chinese/Japanese/Korean)');
    });

    check('recordLesson dedupes on trigger and persists to store', () => {
      const r1 = guardrails.recordLesson({ title: 'ambiguous model name', trigger: 'mini max h3', behavior: 'list candidate meanings and ask', category: 'all' });
      assert.strictEqual(r1.duplicated, false);
      const r2 = guardrails.recordLesson({ title: 'dup', trigger: 'Mini Max H3', behavior: 'same thing again', category: 'focus' });
      assert.strictEqual(r2.duplicated, true, 'same trigger normalized should dedupe');
      assert.strictEqual(guardrails.listLessons().length, 1);
    });

    check('intercept returns nothing when last message is not a tool result', () => {
      const out = guardrails.intercept({ messages: [{ role: 'user', content: 'hi' }], kind: 'focus', context: { cfg: gCfg } });
      assert.strictEqual(out.length, 0);
    });

    check('repeated tool signatures normalize argument order and count only consecutive completed calls', () => {
      const call = (id, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, function: { name: 'read', arguments: JSON.stringify(args) } }] });
      const msgs = [
        { role: 'user', content: 'inspect file' },
        call('r1', { filePath: 'src/agent.js', offset: 1, limit: 20 }),
        { role: 'tool', tool_call_id: 'r1', content: 'same file content' },
        call('r2', { limit: 20, filePath: 'src/agent.js', offset: 1 }),
        { role: 'tool', tool_call_id: 'r2', content: 'same file content' },
        call('r3', { filePath: 'src/agent.js', offset: 1, limit: 20 }),
        { role: 'tool', tool_call_id: 'r3', content: 'same file content' },
      ];
      const streak = guardrails.repeatedToolCallStreak(msgs);
      assert.strictEqual(streak.count, 3);
      assert.strictEqual(streak.name, 'read');
      assert.strictEqual(guardrails.repeatedToolCallStreak([...msgs, { role: 'assistant', content: 'I will change approach.' }]).count, 0);
    });

    check('repeated web searches are excluded but local file searches are detected', () => {
      const call = (id, name) => ({ role: 'assistant', content: null, tool_calls: [{ id, function: { name, arguments: '{"query":"same"}' } }] });
      const web = [
        call('w1', 'websearch'), { role: 'tool', tool_call_id: 'w1', content: 'results' },
        call('w2', 'search_news'), { role: 'tool', tool_call_id: 'w2', content: 'results' },
        call('w3', 'webfetch'), { role: 'tool', tool_call_id: 'w3', content: 'page' },
      ];
      assert.strictEqual(guardrails.repeatedToolCallStreak(web).count, 0, 'web calls are intentionally repeatable');
      const local = [
        call('g1', 'grep'), { role: 'tool', tool_call_id: 'g1', content: 'match' },
        call('g2', 'grep'), { role: 'tool', tool_call_id: 'g2', content: 'match' },
        call('g3', 'grep'), { role: 'tool', tool_call_id: 'g3', content: 'match' },
      ];
      assert.strictEqual(guardrails.repeatedToolCallStreak(local).count, 3);
    });

    check('intercept warns when repeated calls have no tool response at all', () => {
      const msgs = [{ role: 'user', content: 'find files' }];
      for (let i = 1; i <= 3; i++) msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `missing${i}`, function: { name: 'glob', arguments: '{"pattern":"src/**/*.js"}' } }] });
      const out = guardrails.intercept({ messages: msgs, kind: 'main', context: { cfg: gCfg } }).join('\\n');
      assert(out.includes('[System Rule - Repeated Tool Call]'));
    });

    check('intercept warns at three identical non-web calls and stops at four', () => {
      const call = (id) => ({ role: 'assistant', content: null, tool_calls: [{ id, function: { name: 'glob', arguments: '{"pattern":"src/**/*.js"}' } }] });
      const msgs = [{ role: 'user', content: 'find files' }];
      for (let i = 1; i <= 3; i++) { msgs.push(call(`g${i}`), { role: 'tool', tool_call_id: `g${i}`, content: 'same files' }); }
      const warning = guardrails.intercept({ messages: msgs, kind: 'main', context: { cfg: gCfg } }).join('\n');
      assert(warning.includes('[System Rule - Repeated Tool Call]'));
      msgs.push(call('g4'), { role: 'tool', tool_call_id: 'g4', content: 'same files' });
      const stop = guardrails.intercept({ messages: msgs, kind: 'main', context: { cfg: gCfg } }).join('\n');
      assert(stop.includes('[System Rule - Repeated Tool Call Stop]'));
    });

    check('intercept forces a stop after a 3x empty-search streak in focus mode', () => {
      const out = guardrails.intercept({
        messages: [
          { role: 'user', content: 'research x' },
          { role: 'tool', content: 'No search results found.' },
          { role: 'tool', content: 'No search results found.' },
          { role: 'tool', content: 'No search results found.' },
        ],
        kind: 'focus',
        context: { cfg: gCfg },
      });
      const joined = out.join('\n');
      assert(joined.includes('[System Rule - Dead End]'));
      assert(joined.includes('[System Rule - Goal Anchor]'));
    });

    check('intercept gives a reality check (not a dead end) for a single main-agent miss', () => {
      const out = guardrails.intercept({
        messages: [{ role: 'user', content: 'x' }, { role: 'tool', content: 'No search results found.' }],
        kind: 'main',
        context: { cfg: gCfg },
      });
      const joined = out.join('\n');
      assert(joined.includes('[System Rule - Reality Check]'));
      assert(joined.includes('[System Rule - Goal Anchor]'));
      assert(!joined.includes('Dead End'));
    });

    check('intercept enforces English when tool output is foreign-script', () => {
      const out = guardrails.intercept({
        messages: [{ role: 'user', content: 'x' }, { role: 'tool', content: '中文内容很多 这是抓取的网页 需要翻译' }],
        kind: 'focus',
        context: { cfg: gCfg },
      });
      assert(out.join('\n').includes('[System Rule - Language]'));
    });

    check('intercept injects a matching saved behavioral lesson', () => {
      const out = guardrails.intercept({
        messages: [
          { role: 'user', content: 'research mini max h3' },
          { role: 'tool', content: 'results returned about a mini max h3 device' },
        ],
        kind: 'main',
        context: { cfg: gCfg },
      });
      const joined = out.join('\n');
      assert(joined.includes('saved behavioral memory'), 'matched lesson should be injected into the next turn');
      assert(joined.includes('ambiguous model name'));
    });

    check('goal anchor names the real tool and its output, forbidding fabrication', () => {
      const out = guardrails.intercept({
        messages: [
          { role: 'user', content: 'research what companies build agents' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'search_news', arguments: '{"query":"agent frameworks"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: 'AutoGen article found; LangChain listed.' },
        ],
        kind: 'main',
        context: { cfg: gCfg },
      });
      const joined = out.join('\n');
      assert(joined.includes('"search_news"'), 'rule must name the tool that actually ran');
      assert(joined.includes('AutoGen article found'), 'rule must quote the real output');
      assert(!joined.includes('You just received the output of a tool call'), 'old dangling anchor is gone');
      assert(/NEVER invent/.test(joined), 'anti-fabrication guard present');
    });

    check('empty tool result gets an anti-fabrication anchor, not a fake success nudge', () => {
      const out = guardrails.intercept({
        messages: [
          { role: 'user', content: 'run the search' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', function: { name: 'websearch', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call_2', content: '(no output)' },
        ],
        kind: 'main',
        context: { cfg: gCfg },
      });
      const joined = out.join('\n');
      assert(joined.includes('[System Rule - Goal Anchor]'), 'anchor slot still present');
      assert(joined.includes('NO usable output'), 'must say the result was empty');
      assert(joined.includes('do NOT invent'), 'must forbid fabricating the result');
      assert(!joined.includes('returned real output'), 'must not claim success');
    });

    check('leadToolName catches a prose tool intro (focus\\nGenerate...)', () => {
      const names = new Set(['focus', 'bash', 'websearch', 'search_news']);
      assert.strictEqual(guardrails.leadToolName('focus\nGenerate novel, highly creative ideas across domains', names), 'focus');
      assert.strictEqual(guardrails.leadToolName('bash: git status', names), 'bash');
      assert.strictEqual(guardrails.leadToolName('websearch returned three results about agents', names), null, 'normal sentence must not match');
      assert.strictEqual(guardrails.leadToolName('Let me focus on that', names), null, 'mid-sentence tool word must not match');
    });
  } catch (err) {
    failures++;
    console.error(`FAIL  guardrails suite: ${err.message}`);
  } finally {
    guardrails.resetStorePath();
    fs.rmSync(gTmp, { recursive: true, force: true });
  }

  // ---------------- unit: log_lesson / list_lessons tools ----------------
  {
    const gTmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'voidcode-guardtools-'));
    guardrails.setStorePath(path.join(gTmp2, 'learnings.md'));
    try {
      const memTools = require('../src/tools/memoryTool').makeExecutors({ cfg: { guardrails: { maxLearnings: 5 } } });
      const out = memTools.log_lesson({ trigger: 'webfetch, timeout', behavior: 'use websearch instead of raw fetch' });
      check('log_lesson tool records a lesson', () => assert(out.includes('Lesson recorded')));
      const listed = memTools.list_lessons({});
      check('list_lessons tool lists saved lessons', () => assert(listed.includes('webfetch')));
      const again = memTools.log_lesson({ trigger: 'webfetch, timeout', behavior: 'duplicate' });
      check('log_lesson rejects duplicate triggers', () => assert(again.includes('duplicate')));
    } catch (err) {
      failures++;
      console.error(`FAIL  guardrails tool suite: ${err.message}`);
    } finally {
      guardrails.resetStorePath();
      fs.rmSync(gTmp2, { recursive: true, force: true });
    }
  }

  // ---------------- web portal (app/portal.js) ----------------
  {
    const portal = require(path.join(ROOT, 'app', 'portal'));
    const httpc = require('http');
    let base = null;
    const api = async (pathname, { method = 'GET', cookie, body } = {}) =>
      fetch(base + pathname, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    try {
      const res = await portal.start({
        port: 0,
        tunnel: 'off',
        adapter: {
          status: () => ({ cwd: '/tmp/test-proj', generating: false }),
          sendMessage: async (text) => ({ ok: true, finalText: `echo:${text}` }),
          focusList: () => [{ id: 'f1', status: 'running', description: 'test sweep' }],
          undo: () => 'undid',
          compact: () => Promise.resolve({ ok: true }),
        },
      });
      base = `http://127.0.0.1:${res.port}`;

      const unauth = await api('/api/status');
      check('portal returns 401 on API calls without cookie', () => assert.strictEqual(unauth.status, 401));

      const badLogin = await api('/api/login', { method: 'POST', body: { token: 'wrong-token' } });
      check('portal rejects a wrong access token', () => assert.strictEqual(badLogin.status, 401));

      const login = await api('/api/login', { method: 'POST', body: { token: res.token } });
      const setCookie = login.headers.get('set-cookie') || '';
      const cookie = setCookie.split(';')[0];
      check('portal login succeeds and sets an HttpOnly cookie', () => {
        assert.strictEqual(login.status, 200);
        assert(setCookie.toLowerCase().includes('httponly'), 'HttpOnly flag must be set');
      });

      const authed = await api('/api/status', { cookie });
      const statusJson = await authed.json();
      check('portal /api/status works with the session cookie', () => {
        assert.strictEqual(authed.status, 200);
        assert.strictEqual(statusJson.running, true);
        assert.ok('cwd' in statusJson, 'adapter status should be merged in');
      });

      const chat = await api('/api/chat', { method: 'POST', cookie, body: { text: 'hi' } });
      const chatJson = await chat.json();
      check('portal /api/chat routes through the engine adapter', () => {
        assert.strictEqual(chatJson.ok, true);
        assert.strictEqual(chatJson.finalText, 'echo:hi');
      });

      const focus = await api('/api/focus', { cookie });
      const focusJson = await focus.json();
      check('portal /api/focus returns the adapter focus list', () => {
        assert(Array.isArray(focusJson) && focusJson[0] && focusJson[0].id === 'f1');
      });

      await new Promise((resolve) => {
        const req = httpc.get(base + '/api/events', { headers: { Cookie: cookie } }, (resp) => {
          let got = '';
          check('portal SSE stream opens with content-type text/event-stream', () => {
            assert.strictEqual(resp.statusCode, 200);
            assert((resp.headers['content-type'] || '').includes('text/event-stream'));
          });
          resp.on('data', (c) => { got += c.toString(); if (got.length > 50) { req.destroy(); resolve(); } });
          resp.on('end', resolve);
        });
        req.on('error', () => resolve());
        setTimeout(() => { req.destroy(); resolve(); }, 3000);
      });

      const appJs = await api('/portal/app.js', { cookie });
      const appJsText = await appJs.text();
      check('portal serves the mobile UI statics with correct types', () => {
        assert.strictEqual(appJs.status, 200);
        assert(appJsText.includes('EventSource'), 'static JS should be served');
        assert((appJs.headers.get('content-type') || '').includes('text/javascript'));
      });
    } finally {
      portal.stop();
    }
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall tests passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
