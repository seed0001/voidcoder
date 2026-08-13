const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ContextRepository, ContextResolver, SqlJsDriver, SCHEMA_SQL } = require('../src/contextDb');
const { Session } = require('../src/sessions');
const { Agent } = require('../src/agent');
const { Permissions } = require('../src/permissions');

class FakeDriver {
  constructor(records = [], relationships = []) { this.records = records; this.relationships = relationships; this.execCalls = 0; this.searchCalls = 0; }
  async exec(sql) { assert(sql.includes('context_records')); this.execCalls++; }
  async search() { this.searchCalls++; return { records: this.records, relationships: this.relationships }; }
}

async function main() {
  const mandatory = { record_id: 'r-mandatory', version: '2', kind: 'rule', title: 'Mandatory context', summary: '', content_json: JSON.stringify({ text: 'must be present' }), priority: 100, mandatory: 1, source: 'external', status: 'active' };
  const optional = { record_id: 'r-optional', version: '1', kind: 'knowledge', title: 'Optional context', summary: '', content_json: JSON.stringify({ text: 'extra' }), priority: 1, mandatory: 0, source: 'external', status: 'active' };
  const rel = { relationship_id: 'rel-1', from_record_id: 'r-mandatory', from_version: '2', to_record_id: 'r-optional', to_version: '1', relationship_type: 'related', metadata_json: '{}' };
  const driver = new FakeDriver([mandatory, optional], [rel]);
  const repo = new ContextRepository(driver, { cacheTtlMs: 60000 });
  await repo.initialize();
  assert.strictEqual(driver.execCalls, 1, 'schema initialization should execute');
  const first = await repo.search({ text: 'task' });
  const second = await repo.search({ text: 'task' });
  assert.strictEqual(driver.searchCalls, 1, 'unchanged lookup should use cache');
  assert.strictEqual(second.cached, true);
  assert.strictEqual(first.relationships.length, 1);

  const resolver = new ContextResolver(repo, { budgetTokens: 1 });
  const pkg = await resolver.resolve({ task: 'task', agentKind: 'main' });
  assert.strictEqual(pkg.status, 'incomplete_mandatory');
  assert.strictEqual(pkg.mandatoryContextComplete, false);
  assert(pkg.trace.recordsRetrieved.some(r => r.recordId === 'r-mandatory'));
  assert(pkg.trace.recordsOmitted.some(r => r.reason === 'mandatory_context_overflow'));
  assert.strictEqual(pkg.trace.recordsInjected.length, 0);

  const malformed = new ContextResolver(new ContextRepository(new FakeDriver([{ record_id: 'bad', version: '7', kind: 'knowledge', content_json: '{bad', mandatory: 0 }])), { budgetTokens: 100 });
  const malformedPkg = await malformed.resolve({ task: 'bad' });
  assert.strictEqual(malformedPkg.records.length, 0);
  assert(malformedPkg.trace.errors.some(e => e.code === 'malformed_record'));

  const unavailable = new ContextResolver(new ContextRepository({ exec: async () => { throw new Error('offline'); }, search: async () => { throw new Error('offline'); } }));
  const unavailablePkg = await unavailable.resolve({ task: 'offline' });
  assert.strictEqual(unavailablePkg.status, 'unavailable');
  assert(unavailablePkg.trace.errors.length > 0);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voidcode-context-'));
  const session = new Session(tmp, 'trace-test');
  session.contextTraces.push(pkg.trace);
  session.save();
  const loaded = Session.load(tmp, 'trace-test');
  assert.strictEqual(loaded.contextTraces[0].traceId, pkg.trace.traceId);
  fs.rmSync(tmp, { recursive: true, force: true });

  const liveDbPath = path.join(tmp, 'live-context.sqlite');
  const liveDriver = new SqlJsDriver(liveDbPath);
  const liveRepo = new ContextRepository(liveDriver);
  await liveRepo.initialize();
  await liveRepo.upsert({ recordId: 'live-procedure', version: '3', kind: 'procedure', title: 'Live procedure', content: { steps: ['inspect', 'verify'] }, mandatory: true, priority: 10, source: 'real-sqlite-test' });
  await liveRepo.upsert({ recordId: 'live-validation', version: '1', kind: 'validation', title: 'Live validation', content: { required: true }, mandatory: false, source: 'real-sqlite-test' });
  await liveRepo.addRelationship({ fromRecordId: 'live-procedure', fromVersion: '3', toRecordId: 'live-validation', toVersion: '1', relationshipType: 'requires' });
  const liveStatus = await liveRepo.status();
  assert.strictEqual(liveStatus.records, 2);
  assert.strictEqual(liveStatus.relationships, 1);
  const liveQuery = await liveRepo.search({ text: 'Live procedure' });
  assert.strictEqual(liveQuery.records[0].record_id, 'live-procedure');
  assert.strictEqual(liveQuery.relationships.length, 1);
  liveRepo.close();

  let captured = null;
  const agentCfg = {
    provider: 'test', model: 'test', agentMode: 'legacy', contextTokens: 8192,
    contextDb: { enabled: true, path: 'live-context.sqlite' },
    guardrails: { enabled: false }, maxToolRounds: 3, permissions: { bash: 'deny', write: 'deny', edit: 'deny', webfetch: 'deny' },
  };
  const provider = { name: 'test', model: 'test', contextTokens: 8192 };
  const fakeSession = { id: 'agent-context', messages: [], contextTraces: [], usage: { input: 0, output: 0, turns: 0, cost: 0, activeTimeMs: 0 }, save() {}, recordFileChange() {} };
  const agent = new Agent({ cfg: agentCfg, provider, session: fakeSession, permissions: new Permissions(agentCfg, async () => 'n'), cwd: tmp });
  const streamChatFn = async (_p, messages) => { captured = messages; return { content: 'completed', toolCalls: [], usage: {} }; };
  agent.streamChatFn = streamChatFn;
  await agent.send('find the live procedure');
  assert(captured.some(m => m.role === 'system' && String(m.content).includes('Database-Derived Execution Context')));
  assert(captured.some(m => m.role === 'system' && String(m.content).includes('live-procedure')));
  assert.strictEqual(fakeSession.contextTraces.length, 1);
  assert.strictEqual(fakeSession.contextTraces[0].recordsInjected[0].recordId, 'live-procedure');
  assert.strictEqual(fakeSession.contextTraces[0].recordsInjected[0].version, '3');

  console.log('context database infrastructure tests passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
