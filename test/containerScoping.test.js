// Regression suite for the container-scoping plumbing (see problem #4 in the
// approved container-feature plan): without this, opening a container
// wouldn't actually change what the agent sees — every automatic context
// injection searched the whole project database unscoped. This proves the
// fix end-to-end against a real Agent, real contextDb, and two real topics
// in the same database (not just that ContextResolver.resolve() accepts a
// topicId param in isolation — that part already had coverage; what didn't
// was Agent actually threading it through).

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let failures = 0;
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${err.stack || err.message}`); }
}

const { Agent } = require('../src/agent');
const { SqlJsDriver, ContextRepository, ContextResolver } = require('../src/contextDb');
const contextToolsModule = require('../src/tools/contextTools');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeSession() {
  return {
    messages: [], usage: { input: 0, output: 0, turns: 0, cost: 0, activeTimeMs: 0 },
    contextTraces: [], title: '', scratchpad: '', fileBackups: [], saved: false,
    save() { this.saved = true; },
    recordFileChange() {},
  };
}

async function main() {

  // ================================================================
  // e2e: Agent.activeTopicId actually scopes automatic context injection
  // ================================================================

  await checkAsync('a container-scoped Agent.send() only injects that container\'s topic — not the whole database', async () => {
    const cwd = mkTmp('voidcode-scoping-');
    const driver = new SqlJsDriver(path.join(cwd, '.voidcode', 'context.sqlite'));
    const repository = new ContextRepository(driver);
    await repository.initialize();
    const resolver = new ContextResolver(repository, { budgetTokens: 6000, maxRecords: 40 });

    const topicA = await repository.createTopic({ title: 'Container A' });
    const topicB = await repository.createTopic({ title: 'Container B' });
    await repository.upsert({ recordId: 'a1', version: '1', kind: 'knowledge', topicId: topicA.topicId, title: 'Budget spreadsheet', summary: 'Q3 budget numbers', content: { text: 'budget' } });
    await repository.upsert({ recordId: 'b1', version: '1', kind: 'knowledge', topicId: topicB.topicId, title: 'Recipe notes', summary: 'Pasta recipe', content: { text: 'recipe' } });

    const cfg = {
      provider: 'mock', model: 'mock-model', agentMode: 'legacy',
      maxToolRounds: 5, compactAt: 0.75, contextTokens: 128000,
      providers: { mock: {} }, guardrails: {},
      contextService: { repository, resolver, enabled: true },
    };
    const provider = { name: 'mock', baseUrl: 'http://x', apiKey: '', model: 'mock-model', contextTokens: 128000 };
    const permissions = { check: async () => true };
    const streamChatFn = async () => ({ content: 'ok', toolCalls: [], usage: null });

    const agent = new Agent({ cfg, provider, session: makeSession(), permissions, events: {}, cwd, streamChatFn });

    // Empty task text — search()'s term-matching clause only activates for
    // non-empty text, so this returns every active record subject only to
    // the topic filter, letting the test isolate scoping from relevance
    // matching (search() ANDs every query word together, which isn't what
    // this test is exercising).
    const unscoped = await agent.resolveContext('');
    const unscopedTitles = unscoped.records.map((r) => r.title).sort();
    assert.deepStrictEqual(unscopedTitles, ['Budget spreadsheet', 'Recipe notes']);

    // Open container A.
    agent.setActiveTopic(topicA.topicId);
    const scopedA = await agent.resolveContext('');
    assert.deepStrictEqual(scopedA.records.map((r) => r.title), ['Budget spreadsheet']);

    // Switch to container B.
    agent.setActiveTopic(topicB.topicId);
    const scopedB = await agent.resolveContext('');
    assert.deepStrictEqual(scopedB.records.map((r) => r.title), ['Recipe notes']);

    // Close the container.
    agent.setActiveTopic(null);
    const unscopedAgain = await agent.resolveContext('');
    assert.strictEqual(unscopedAgain.records.length, 2);

    repository.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  await checkAsync('setActiveTopic updates toolCtx in place, so the context_query TOOL (not just automatic injection) respects the active container by default', async () => {
    const cwd = mkTmp('voidcode-scoping-tool-');
    const driver = new SqlJsDriver(path.join(cwd, '.voidcode', 'context.sqlite'));
    const repository = new ContextRepository(driver);
    await repository.initialize();
    const resolver = new ContextResolver(repository, { budgetTokens: 6000, maxRecords: 40 });
    const topicA = await repository.createTopic({ title: 'A' });
    const topicB = await repository.createTopic({ title: 'B' });
    await repository.upsert({ recordId: 'a1', version: '1', kind: 'knowledge', topicId: topicA.topicId, title: 'Only in A', summary: 'x', content: {} });
    await repository.upsert({ recordId: 'b1', version: '1', kind: 'knowledge', topicId: topicB.topicId, title: 'Only in B', summary: 'x', content: {} });

    const cfg = {
      provider: 'mock', model: 'mock-model', agentMode: 'legacy',
      maxToolRounds: 5, compactAt: 0.75, contextTokens: 128000,
      providers: { mock: {} }, guardrails: {},
      contextService: { repository, resolver, enabled: true },
    };
    const provider = { name: 'mock', baseUrl: 'http://x', apiKey: '', model: 'mock-model', contextTokens: 128000 };
    const permissions = { check: async () => true };
    const agent = new Agent({ cfg, provider, session: makeSession(), permissions, events: {}, cwd, streamChatFn: async () => ({ content: 'ok', toolCalls: [], usage: null }) });

    const executors = contextToolsModule.makeExecutors(agent.toolCtx);

    // Before opening any container: no default scope, sees everything matching.
    const before = JSON.parse(await executors.context_query({ query: 'Only' }));
    assert.strictEqual(before.records.length, 2);

    // Open container A — the tool call omits topic_id, so it must default
    // to the now-active topic via toolCtx.activeTopicId (mutated in place
    // by setActiveTopic, not a stale copy from construction time).
    agent.setActiveTopic(topicA.topicId);
    const afterA = JSON.parse(await executors.context_query({ query: 'Only' }));
    assert.deepStrictEqual(afterA.records.map((r) => r.title), ['Only in A']);

    // An explicit topic_id from the model still overrides the default.
    const explicit = JSON.parse(await executors.context_query({ query: 'Only', topic_id: topicB.topicId }));
    assert.deepStrictEqual(explicit.records.map((r) => r.title), ['Only in B']);

    repository.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  await checkAsync('a subagent spawned while a container is active inherits the scope too', async () => {
    const cwd = mkTmp('voidcode-scoping-sub-');
    const driver = new SqlJsDriver(path.join(cwd, '.voidcode', 'context.sqlite'));
    const repository = new ContextRepository(driver);
    await repository.initialize();
    const resolver = new ContextResolver(repository, { budgetTokens: 6000, maxRecords: 40 });
    const topicA = await repository.createTopic({ title: 'A' });
    const topicB = await repository.createTopic({ title: 'B' });
    await repository.upsert({ recordId: 'a1', version: '1', kind: 'knowledge', topicId: topicA.topicId, title: 'A-fact', summary: 's', content: {} });
    await repository.upsert({ recordId: 'b1', version: '1', kind: 'knowledge', topicId: topicB.topicId, title: 'B-fact', summary: 's', content: {} });

    const cfg = {
      provider: 'mock', model: 'mock-model', agentMode: 'legacy',
      maxToolRounds: 5, compactAt: 0.75, contextTokens: 128000,
      providers: { mock: {} }, guardrails: {},
      contextService: { repository, resolver, enabled: true },
    };
    const provider = { name: 'mock', baseUrl: 'http://x', apiKey: '', model: 'mock-model', contextTokens: 128000 };
    const permissions = { check: async () => true };
    const streamChatFn = async () => ({ content: 'subagent report', toolCalls: [], usage: null });
    const agent = new Agent({ cfg, provider, session: makeSession(), permissions, events: {}, cwd, streamChatFn });

    agent.setActiveTopic(topicA.topicId);
    // A single term (not "look into A-fact or B-fact") — search() ANDs
    // every query word together, so a multi-word prompt matching neither
    // record's title/summary would trivially return zero regardless of
    // scoping and prove nothing.
    const report = await agent.runSubagent({ description: 'investigate', prompt: 'fact' });
    assert.strictEqual(report, 'subagent report');
    // Confirm scoping held during the subagent call by checking the last
    // recorded context trace landed on topic A's single record.
    const lastTrace = agent.session.contextTraces[agent.session.contextTraces.length - 1];
    assert.strictEqual(lastTrace.recordsInjected.length, 1, 'only topic A\'s one record should have been injected, not B\'s');
    assert.strictEqual(lastTrace.recordsInjected[0].recordId, 'a1');

    repository.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall container scoping tests passed');
  process.exit(failures ? 1 : 0);
}

main();
