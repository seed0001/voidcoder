// Regression suite for automatic recovery from a model "collapse" — a model
// degenerating into repetitive garbage output (observed in practice with a
// DeepSeek model via OpenRouter producing hundreds of words of looping,
// shuffled French phrases instead of a real answer) instead of erroring
// outright. Before this, the harness had no way to notice this happened —
// the garbage was just returned as the answer, and the broken model stayed
// selected, silently burning further credits on the next turn too.
//
//   1. guardrails.detectRepetitionCollapse recognizes a real collapse via
//      vocabulary starvation or exact-phrase looping, language-agnostically
//      (the actual incident was French; detectForeignScript wouldn't catch
//      a same-script language collapse at all), while NOT flagging normal
//      prose or realistic repetitive-but-varied agent output (changelogs,
//      checklists) as a false positive.
//   2. modelCatalog.suggestFailoverModel picks a same-provider, similarly
//      priced replacement, excluding the failed model (and anything else
//      already known-bad this turn), preferring the same cost tier.
//   3. Agent._loop actually uses both: on a collapsed completion it switches
//      models and retries the round automatically, the collapsed text is
//      never returned as the turn's answer, and the swap sticks as the
//      session's active model afterward (main turns only — a subagent's
//      collapse must not silently change the user's own main model).
//   4. FocusSession.run() (background/research agents, a separate loop
//      implementation from Agent._loop) gets the same recovery — arguably
//      more important there, since a background session runs unattended for
//      its whole time budget with nobody watching it loop on garbage. The
//      swap must show up in the session's own reported model, and must NOT
//      mutate agentRefs.provider (the shared main-agent provider object).

const fs = require('fs');
const os = require('os');
const path = require('path');
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

const guardrails = require('../src/guardrails');
const { suggestFailoverModel } = require('../src/modelCatalog');
const { Agent } = require('../src/agent');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------- fixtures

const REAL_COLLAPSE_SAMPLE = "La tête de la voiture ventrale du ciel la voiture est ventrale. L'ingénierie technique de la voiture la voiture est ventrale et le ciel est couvert par la voiture. La voiture est ventrale. L'étranger se couvre de doutes. La voiture céleste. L'étranger doit. La voiture. Le ciel. L'étranger. La voiture. L'étranger ne doit pas. La voiture céleste. La voiture doit. L'étranger doit respecter les règles du ciel. La voiture. L'étranger doit respecter les règles du ciel. La voiture céleste. La voiture doit respecter les règles du ciel. La voiture. L'étranger. La voiture céleste. La voiture doit. L'étranger doit respecter les règles du ciel. La voiture céleste. La voiture. L'étranger. La voiture céleste. La voiture doit. L'étranger doit respecter les règles du ciel. La voiture. L'étranger. La voiture céleste. La voiture doit. L'étranger doit respecter les règles du ciel. La voiture. L'étranger. La voiture céleste. La voiture doit. L'étranger doit respecter les règles du ciel. La voiture doit. L'étranger doit respecter les règles du ciel. La voiture. L'étranger. La voiture céleste.";

const NORMAL_PROSE = "Here's what I found after reviewing the authentication module. The login flow validates credentials against the database, then issues a JWT signed with the server's private key. Session expiry is set to 24 hours, which matches what's documented in the README. I noticed the refresh token endpoint doesn't rate-limit requests, though, which could let an attacker hammer it. I'd recommend adding a sliding window limiter there before this ships. The rest of the middleware chain looks solid — CORS is scoped correctly and the CSRF check runs before any state-changing route.";

function realisticVariedChangelog() {
  const files = ['auth.js', 'userController.js', 'paymentGateway.js', 'sessionManager.js', 'routes/api.js', 'middleware/cors.js', 'db/migrations/001.js', 'utils/logger.js', 'tests/auth.test.js', 'config/env.js'];
  const bugs = ['a null pointer dereference', 'an off-by-one error in the loop bound', 'a missing await on the async call', 'an unescaped SQL string concatenation', 'a race condition on the shared cache', 'a stale closure capturing the old state', 'an incorrect status code on failure', 'a memory leak from an unremoved listener'];
  return files.map((f, i) => `- Fixed ${bugs[i % bugs.length]} in ${f} by adding a guard clause and a regression test covering the edge case.`).join('\n');
}

function makeCatalog() {
  return [
    { id: 'openrouter/deepseek/deepseek-v4-flash', provider: 'openrouter', modelName: 'deepseek/deepseek-v4-flash', costTier: 'economy', pricing: { prompt: 0.0000002, completion: 0.0000008 } },
    { id: 'openrouter/qwen/qwen-2.5-72b', provider: 'openrouter', modelName: 'qwen/qwen-2.5-72b', costTier: 'economy', pricing: { prompt: 0.00000025, completion: 0.0000009 } },
    { id: 'openrouter/anthropic/claude-sonnet-4.5', provider: 'openrouter', modelName: 'anthropic/claude-sonnet-4.5', costTier: 'premium', pricing: { prompt: 0.000003, completion: 0.000015 } },
    { id: 'ollama/llama3.1', provider: 'ollama', modelName: 'llama3.1', costTier: 'free', pricing: { prompt: 0, completion: 0 } },
  ];
}

async function main() {

  // ================================================================
  // Unit: guardrails.detectRepetitionCollapse
  // ================================================================

  check('detects the real collapse sample (vocabulary starvation) that triggered this feature', () => {
    const result = guardrails.detectRepetitionCollapse(REAL_COLLAPSE_SAMPLE);
    assert(result, 'expected a collapse to be detected');
    assert.strictEqual(result.kind, 'vocabulary');
    assert(result.uniqueWords < 40, `expected a small unique-word count, got ${result.uniqueWords}`);
  });

  check('detects an exact-phrase loop even with a technically nonzero vocabulary', () => {
    const looped = 'Please try again. Please try again. '.repeat(30);
    const result = guardrails.detectRepetitionCollapse(looped);
    assert(result, 'expected a collapse to be detected');
  });

  check('does not flag normal, varied prose', () => {
    assert.strictEqual(guardrails.detectRepetitionCollapse(NORMAL_PROSE), null);
  });

  check('does not flag a realistic, varied, but structurally repetitive changelog', () => {
    const list = realisticVariedChangelog();
    assert.strictEqual(guardrails.detectRepetitionCollapse(list), null, 'a real varied changelog must not be treated as a model collapse');
  });

  check('does not judge short replies at all (too little signal either way)', () => {
    assert.strictEqual(guardrails.detectRepetitionCollapse('Done! I fixed the bug in auth.js.'), null);
  });

  check('is language-agnostic — the same collapse shape in English is caught too, unlike detectForeignScript', () => {
    const englishCollapse = 'The car must. The stranger must respect the rules of the sky. The car. The stranger. The celestial car. The car must. '.repeat(12);
    assert(guardrails.detectRepetitionCollapse(englishCollapse), 'expected an English-language collapse to be detected');
    assert.strictEqual(guardrails.detectForeignScript(englishCollapse), null, 'sanity check: detectForeignScript correctly has no opinion on same-script collapses');
  });

  // ================================================================
  // Unit: modelCatalog.suggestFailoverModel
  // ================================================================

  await checkAsync('suggests a same-provider, same-cost-tier alternative, excluding the failed model', async () => {
    const cfg = { providers: { openrouter: {} } };
    const alt = await suggestFailoverModel(cfg, '.', 'openrouter/deepseek/deepseek-v4-flash', { models: makeCatalog() });
    assert(alt, 'expected an alternate model');
    assert.strictEqual(alt.provider, 'openrouter');
    assert.strictEqual(alt.id, 'openrouter/qwen/qwen-2.5-72b');
    assert.notStrictEqual(alt.id, 'openrouter/deepseek/deepseek-v4-flash');
  });

  await checkAsync('never crosses providers — a collapsed openrouter model is not replaced by a local ollama model', async () => {
    const cfg = { providers: { openrouter: {}, ollama: {} } };
    const alt = await suggestFailoverModel(cfg, '.', 'openrouter/deepseek/deepseek-v4-flash', { models: makeCatalog() });
    assert.strictEqual(alt.provider, 'openrouter', 'must stay on a provider whose key is already known to work');
  });

  await checkAsync('respects an exclude list — already-tried-and-failed models in this turn are skipped', async () => {
    const cfg = { providers: { openrouter: {} } };
    const alt = await suggestFailoverModel(cfg, '.', 'openrouter/deepseek/deepseek-v4-flash', {
      models: makeCatalog(),
      excludeIds: ['openrouter/qwen/qwen-2.5-72b'],
    });
    assert(alt, 'expected a further fallback');
    assert.strictEqual(alt.id, 'openrouter/anthropic/claude-sonnet-4.5', 'should fall back to the closest-priced remaining model outside the same tier');
  });

  await checkAsync('returns null when no candidate is left on the same provider', async () => {
    const cfg = { providers: { openrouter: {} } };
    const alt = await suggestFailoverModel(cfg, '.', 'openrouter/deepseek/deepseek-v4-flash', {
      models: makeCatalog(),
      excludeIds: ['openrouter/qwen/qwen-2.5-72b', 'openrouter/anthropic/claude-sonnet-4.5'],
    });
    assert.strictEqual(alt, null);
  });

  // ================================================================
  // e2e: Agent._loop actually detects and recovers from a collapse
  // ================================================================

  function scriptStreamChat(steps) {
    const calls = [];
    let i = 0;
    const fn = async (prov, messages) => {
      calls.push({ provider: `${prov.name}/${prov.model}`, messages: messages.map((m) => ({ role: m.role, content: m.content })) });
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      const resolved = typeof step === 'function' ? (step(calls.length) || {}) : step;
      return {
        content: resolved.content ?? '',
        toolCalls: resolved.toolCalls ?? [],
        finishReason: 'stop',
        usage: resolved.usage || null,
      };
    };
    return { fn, calls };
  }

  function makeSession() {
    return {
      messages: [], usage: { input: 0, output: 0, turns: 0, cost: 0, activeTimeMs: 0 },
      contextTraces: [], title: '', scratchpad: '', fileBackups: [], saved: false,
      save() { this.saved = true; },
      recordFileChange() {},
    };
  }

  await checkAsync('a collapsed completion triggers an automatic model switch and retry — the garbage is never returned as the answer', async () => {
    const cwd = mkTmp('voidcode-collapse-agent-');
    const script = scriptStreamChat([
      { content: REAL_COLLAPSE_SAMPLE }, // round 1 on the bad model: collapse
      { content: 'The auth module looks fine; no issues found.' }, // round 2 on the failover model
    ]);
    const session = makeSession();
    const cfg = {
      provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', agentMode: 'legacy',
      maxToolRounds: 10, compactAt: 0.75, contextTokens: 128000,
      providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1' } },
      guardrails: {},
    };
    const provider = { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'deepseek/deepseek-v4-flash', contextTokens: 128000 };
    const permissions = { check: async () => true };
    const suggestFailoverModelFn = async () => ({ provider: 'openrouter', modelName: 'qwen/qwen-2.5-72b' });

    const agent = new Agent({ cfg, provider, session, permissions, events: {}, cwd, streamChatFn: script.fn, suggestFailoverModelFn });
    const result = await agent.send('review the auth module');

    assert.strictEqual(result, 'The auth module looks fine; no issues found.');
    assert(!result.includes('voiture'), 'the collapsed garbage must never be returned as the final answer');
    assert.strictEqual(script.calls.length, 2, 'expected exactly 2 model calls: the collapse, then the retry on the new model');
    assert.strictEqual(script.calls[0].provider, 'openrouter/deepseek/deepseek-v4-flash');
    assert.strictEqual(script.calls[1].provider, 'openrouter/qwen/qwen-2.5-72b', 'the retry must actually go to the failover model');

    // The swap must stick as the session's active model going forward.
    assert.strictEqual(agent.provider.model, 'qwen/qwen-2.5-72b');

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  await checkAsync('a subagent collapse switches that subagent\'s model but does not touch the main session\'s model', async () => {
    const cwd = mkTmp('voidcode-collapse-subagent-');
    const script = scriptStreamChat([
      { content: REAL_COLLAPSE_SAMPLE },
      { content: 'Subagent report: done.' },
    ]);
    const session = makeSession();
    const cfg = {
      provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', agentMode: 'legacy',
      maxToolRounds: 10, compactAt: 0.75, contextTokens: 128000,
      providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1' } },
      guardrails: {},
    };
    const provider = { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'deepseek/deepseek-v4-flash', contextTokens: 128000 };
    const permissions = { check: async () => true };
    const suggestFailoverModelFn = async () => ({ provider: 'openrouter', modelName: 'qwen/qwen-2.5-72b' });

    const agent = new Agent({ cfg, provider, session, permissions, events: {}, cwd, streamChatFn: script.fn, suggestFailoverModelFn });
    const report = await agent.runSubagent({ description: 'investigate', prompt: 'investigate the issue' });

    assert.strictEqual(report, 'Subagent report: done.');
    assert.strictEqual(script.calls[1].provider, 'openrouter/qwen/qwen-2.5-72b', 'the subagent retry must still use the failover model');
    // The MAIN agent's own provider must be completely untouched.
    assert.strictEqual(agent.provider.model, 'deepseek/deepseek-v4-flash', 'a subagent\'s collapse must not silently change the user\'s main model');

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  await checkAsync('when no alternate model is available, the loop does not spin forever — it returns the collapsed text rather than hanging', async () => {
    const cwd = mkTmp('voidcode-collapse-noalt-');
    const script = scriptStreamChat([{ content: REAL_COLLAPSE_SAMPLE }]);
    const session = makeSession();
    const cfg = {
      provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', agentMode: 'legacy',
      maxToolRounds: 10, compactAt: 0.75, contextTokens: 128000,
      providers: { openrouter: { baseUrl: 'https://openrouter.ai/api/v1' } },
      guardrails: {},
    };
    const provider = { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: 'deepseek/deepseek-v4-flash', contextTokens: 128000 };
    const permissions = { check: async () => true };
    const suggestFailoverModelFn = async () => null; // nothing else available

    const agent = new Agent({ cfg, provider, session, permissions, events: {}, cwd, streamChatFn: script.fn, suggestFailoverModelFn });
    const result = await agent.send('review the auth module');

    assert.strictEqual(result, REAL_COLLAPSE_SAMPLE, 'with no alternate available, the round must still terminate (not hang) and surface what the model actually said');
    assert.strictEqual(script.calls.length, 1, 'with nothing to switch to, the loop must not retry at all — just one call, then give up and return what it got');

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ================================================================
  // e2e: FocusSession.run() — a separate loop implementation, own wiring.
  // ================================================================

  const http = require('http');
  const { FocusSession } = require('../src/focus');

  function startFocusMockServer(steps) {
    let mainRequestCount = 0;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        if (payload.stream === false) {
          // Scratchpad generation — plain JSON, doesn't count toward round numbering.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'Goal: investigate.' } }] }));
          return;
        }
        mainRequestCount++;
        const step = steps[Math.min(mainRequestCount - 1, steps.length - 1)];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (step.content !== undefined) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: step.content }, finish_reason: 'stop' }] })}\n\n`);
        }
        if (step.toolCall) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: step.toolCall.id, type: 'function', function: { name: step.toolCall.name, arguments: JSON.stringify(step.toolCall.args) } } ] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requestCount: () => mainRequestCount }));
    });
  }

  await checkAsync('FocusSession: a collapsed round switches models and retries, without touching the shared main-agent provider', async () => {
    const cwd = mkTmp('voidcode-collapse-focus-');
    const { server, port } = await startFocusMockServer([
      { content: REAL_COLLAPSE_SAMPLE },
      { toolCall: { id: 'c1', name: 'focus_complete', args: { report: 'Investigation complete: no issues found.' } } },
    ]);

    const mockManager = { emit: () => {} };
    const sharedProvider = { name: 'openrouter', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'deepseek/deepseek-v4-flash', contextTokens: 128000 };
    const agentRefs = {
      provider: sharedProvider,
      cfg: { contextTokens: 128000, compactAt: 0.75, guardrails: {}, providers: { openrouter: { baseUrl: `http://127.0.0.1:${port}/v1` } } },
      cwd,
      mcpServers: [],
      toolCtx: { onFileChange: () => {}, onContextTrace: () => {} },
      contextResolver: null,
      organism: null,
      suggestFailoverModelFn: async () => ({ provider: 'openrouter', modelName: 'qwen/qwen-2.5-72b' }),
    };
    const session = new FocusSession({
      id: 'f-collapse-test', manager: mockManager, description: 'investigate the issue',
      prompt: 'Investigate the reported issue and report back.', deadlineMs: 5 * 60 * 1000, mode: 'task', agentRefs,
    });

    await session.run();
    server.close();

    assert.strictEqual(session.status, 'done', `expected done, got ${session.status}`);
    assert.strictEqual(session.finalReport, 'Investigation complete: no issues found.');
    assert.strictEqual(session.modelOverride, 'openrouter/qwen/qwen-2.5-72b', 'the session should now report the failover model as its active model');
    assert.strictEqual(sharedProvider.model, 'deepseek/deepseek-v4-flash', 'the shared agentRefs.provider must be completely untouched by a focus session\'s own collapse');

    const detail = session.getDetail();
    assert(detail.log.some((l) => l.kind === 'note' && /model collapse/.test(l.text)), 'expected the collapse to be logged as visible activity');

    fs.rmSync(cwd, { recursive: true, force: true });
  });

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall model-collapse recovery tests passed');
  process.exit(failures ? 1 : 0);
}

main();
