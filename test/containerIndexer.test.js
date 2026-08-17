// Regression suite for the container feature's data layer and indexing
// pipeline (see the approved container-feature plan): container_refs
// CRUD/schema in src/contextDb.js, and the tiered indexing pipeline in
// src/containerIndexer.js. This is the "reference files anywhere on disk,
// index them without moving them" feature — containers are never copies,
// so these tests operate on real files in a temp dir and real absolute
// paths throughout, the same way the feature does in production.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let failures = 0;
async function checkAsync(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (err) { failures++; console.error(`FAIL  ${name}: ${err.stack || err.message}`); }
}

const { SqlJsDriver, ContextRepository } = require('../src/contextDb');
const { FocusManager } = require('../src/focus');
const { indexContainer, classifyTier } = require('../src/containerIndexer');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function makeRepo(dir) {
  const driver = new SqlJsDriver(path.join(dir, 'ctx.sqlite'));
  const repo = new ContextRepository(driver);
  await repo.initialize();
  return repo;
}

function waitForDone(manager, id) {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      const s = manager.get(id);
      if (s.status !== 'working') { clearInterval(t); resolve(s); }
    }, 15);
  });
}

async function main() {

  // ================================================================
  // Unit: classifyTier
  // ================================================================

  await checkAsync('classifyTier whitelists known text/code, image, and audio extensions and falls back to unsupported for anything else', async () => {
    assert.strictEqual(classifyTier('.md'), 'text');
    assert.strictEqual(classifyTier('.js'), 'text');
    assert.strictEqual(classifyTier('.png'), 'image');
    assert.strictEqual(classifyTier('.mp3'), 'audio');
    assert.strictEqual(classifyTier('.pdf'), 'unsupported');
    assert.strictEqual(classifyTier('.docx'), 'unsupported');
    assert.strictEqual(classifyTier('.mp4'), 'unsupported');
    assert.strictEqual(classifyTier(''), 'unsupported');
  });

  // ================================================================
  // Unit: container_refs CRUD (src/contextDb.js)
  // ================================================================

  await checkAsync('container_refs: add dedupes by path, update patches fields, remove cascades to the linked record', async () => {
    const tmp = mkTmp('voidcode-crefs-');
    const repo = await makeRepo(tmp);
    const topic = await repo.createTopic({ title: 'T' });

    const ref = await repo.addContainerRef({ path: 'C:/x/note.txt', isDir: false });
    assert.strictEqual(ref.status, 'pending');
    const dup = await repo.addContainerRef({ path: 'C:/x/note.txt', isDir: false });
    assert.strictEqual(dup.ref_id, ref.ref_id, 'adding the same path twice must not create a second row');

    const record = await repo.upsert({ recordId: 'r1', version: '1', kind: 'knowledge', topicId: topic.topicId, title: 'note', content: {}, source: ref.path });
    await repo.updateContainerRef(ref.ref_id, { status: 'indexed', record_id: record.record_id, content_hash: 'h', mtime_ms: 1 });
    const updated = await repo.getContainerRef(ref.ref_id);
    assert.strictEqual(updated.status, 'indexed');
    assert.strictEqual(updated.content_hash, 'h');

    await repo.removeContainerRef(ref.ref_id);
    assert.strictEqual(await repo.getContainerRef(ref.ref_id), null);
    assert.strictEqual(await repo.get('r1'), null, 'removing a ref must cascade-delete its context_records row');

    repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await checkAsync('listContainerRefs filters by status when asked, returns everything otherwise', async () => {
    const tmp = mkTmp('voidcode-crefs-status-');
    const repo = await makeRepo(tmp);
    const a = await repo.addContainerRef({ path: 'C:/a.txt' });
    await repo.addContainerRef({ path: 'C:/b.txt' });
    await repo.updateContainerRef(a.ref_id, { status: 'indexed' });

    assert.strictEqual((await repo.listContainerRefs()).length, 2);
    assert.strictEqual((await repo.listContainerRefs({ status: 'indexed' })).length, 1);
    assert.strictEqual((await repo.listContainerRefs({ status: 'pending' })).length, 1);

    repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ================================================================
  // e2e: indexContainer — the full tiered pipeline
  // ================================================================

  await checkAsync('indexContainer classifies text/image/unsupported correctly, detects a missing file, and writes context_records for each processed file', async () => {
    const tmp = mkTmp('voidcode-idx-e2e-');
    fs.writeFileSync(path.join(tmp, 'notes.md'), '# Notes\nThis project concerns quarterly budgeting.');
    fs.writeFileSync(path.join(tmp, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // fake PNG magic bytes
    fs.writeFileSync(path.join(tmp, 'report.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46])); // fake PDF magic bytes

    const repo = await makeRepo(tmp);
    const topic = await repo.createTopic({ title: 'C' });
    const refText = await repo.addContainerRef({ path: path.join(tmp, 'notes.md') });
    const refImage = await repo.addContainerRef({ path: path.join(tmp, 'photo.png') });
    const refPdf = await repo.addContainerRef({ path: path.join(tmp, 'report.pdf') });
    const refMissing = await repo.addContainerRef({ path: path.join(tmp, 'gone.txt') });

    const calls = [];
    const fakeAgent = {
      runWorker: async (prompt, opts) => {
        calls.push({ hasImages: !!(opts && opts.images && opts.images.length) });
        return opts?.images?.length ? 'MOCK IMAGE DESCRIPTION' : 'MOCK TEXT SUMMARY';
      },
    };

    const manager = new FocusManager({ provider: {}, cfg: {}, cwd: tmp, mcpServers: [] });
    manager.setToolCtx({});
    const { id } = manager.spawnCustom({
      description: 'index: C', role: 'indexer',
      runFn: (session) => indexContainer({ agent: fakeAgent, repository: repo, topicId: topic.topicId, session }),
    });
    const session = await waitForDone(manager, id);

    assert.strictEqual(session.status, 'done');

    const textRef = await repo.getContainerRef(refText.ref_id);
    assert.strictEqual(textRef.status, 'indexed');
    assert.strictEqual(textRef.tier, 'text');

    const imgRef = await repo.getContainerRef(refImage.ref_id);
    assert.strictEqual(imgRef.status, 'indexed');
    assert.strictEqual(imgRef.tier, 'image');

    const pdfRef = await repo.getContainerRef(refPdf.ref_id);
    assert.strictEqual(pdfRef.status, 'indexed');
    assert.strictEqual(pdfRef.tier, 'unsupported', 'PDF must fall to the unsupported tier, never be read as text');

    const missingRef = await repo.getContainerRef(refMissing.ref_id);
    assert.strictEqual(missingRef.status, 'missing');

    const pdfRecord = await repo.get(pdfRef.record_id);
    const pdfContent = JSON.parse(pdfRecord.content_json);
    assert(!('text' in pdfContent), 'the PDF must never have had its binary bytes decoded as text content');
    assert(pdfRecord.summary.includes('Unsupported format'));

    assert(calls.some((c) => c.hasImages === true), 'the image tier must call runWorker with an images payload');
    assert(calls.some((c) => c.hasImages === false), 'the text tier must call runWorker without images');

    repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await checkAsync('indexContainer is incremental — a second run with no file changes skips everything and makes no model calls', async () => {
    const tmp = mkTmp('voidcode-idx-incr-');
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello world');
    const repo = await makeRepo(tmp);
    const topic = await repo.createTopic({ title: 'C' });
    await repo.addContainerRef({ path: path.join(tmp, 'a.txt') });

    let modelCalls = 0;
    const fakeAgent = { runWorker: async () => { modelCalls++; return 'summary'; } };
    const manager = new FocusManager({ provider: {}, cfg: {}, cwd: tmp, mcpServers: [] });
    manager.setToolCtx({});

    const first = manager.spawnCustom({ description: 'idx1', role: 'indexer', runFn: (s) => indexContainer({ agent: fakeAgent, repository: repo, topicId: topic.topicId, session: s }) });
    await waitForDone(manager, first.id);
    assert.strictEqual(modelCalls, 1, 'first run should index the one file');

    const second = manager.spawnCustom({ description: 'idx2', role: 'indexer', runFn: (s) => indexContainer({ agent: fakeAgent, repository: repo, topicId: topic.topicId, session: s }) });
    const s2 = await waitForDone(manager, second.id);
    assert.strictEqual(modelCalls, 1, 'second run must not call the model again — the file is unchanged');
    assert(/skipped 1 unchanged/.test(s2.finalReport), s2.finalReport);

    repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await checkAsync('indexContainer re-indexes a file after its content actually changes', async () => {
    const tmp = mkTmp('voidcode-idx-change-');
    const file = path.join(tmp, 'a.txt');
    fs.writeFileSync(file, 'version 1');
    const repo = await makeRepo(tmp);
    const topic = await repo.createTopic({ title: 'C' });
    const ref = await repo.addContainerRef({ path: file });

    let modelCalls = 0;
    const fakeAgent = { runWorker: async () => { modelCalls++; return `summary ${modelCalls}`; } };
    const manager = new FocusManager({ provider: {}, cfg: {}, cwd: tmp, mcpServers: [] });
    manager.setToolCtx({});

    const first = manager.spawnCustom({ description: 'idx1', role: 'indexer', runFn: (s) => indexContainer({ agent: fakeAgent, repository: repo, topicId: topic.topicId, session: s }) });
    await waitForDone(manager, first.id);

    // Ensure a different mtime tick, then genuinely change the content.
    await new Promise((r) => setTimeout(r, 10));
    fs.writeFileSync(file, 'version 2 — completely different content');

    const second = manager.spawnCustom({ description: 'idx2', role: 'indexer', runFn: (s) => indexContainer({ agent: fakeAgent, repository: repo, topicId: topic.topicId, session: s }) });
    await waitForDone(manager, second.id);
    assert.strictEqual(modelCalls, 2, 'changed content must trigger re-indexing');

    const record = await repo.get((await repo.getContainerRef(ref.ref_id)).record_id);
    assert.strictEqual(record.summary, 'summary 2');

    repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await checkAsync('a per-file failure (e.g. vision rejected) is isolated — the run continues and marks only that ref as error', async () => {
    const tmp = mkTmp('voidcode-idx-err-');
    fs.writeFileSync(path.join(tmp, 'good.txt'), 'fine content');
    fs.writeFileSync(path.join(tmp, 'bad.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const repo = await makeRepo(tmp);
    const topic = await repo.createTopic({ title: 'C' });
    const goodRef = await repo.addContainerRef({ path: path.join(tmp, 'good.txt') });
    const badRef = await repo.addContainerRef({ path: path.join(tmp, 'bad.png') });

    const fakeAgent = {
      runWorker: async (prompt, opts) => {
        if (opts?.images?.length) throw new Error('Image analysis currently requires an OpenRouter vision model.');
        return 'ok summary';
      },
    };
    const manager = new FocusManager({ provider: {}, cfg: {}, cwd: tmp, mcpServers: [] });
    manager.setToolCtx({});
    const { id } = manager.spawnCustom({ description: 'idx', role: 'indexer', runFn: (s) => indexContainer({ agent: fakeAgent, repository: repo, topicId: topic.topicId, session: s }) });
    const session = await waitForDone(manager, id);

    assert.strictEqual(session.status, 'done', 'the whole run must not abort just because one file failed');
    assert.strictEqual((await repo.getContainerRef(goodRef.ref_id)).status, 'indexed');
    const bad = await repo.getContainerRef(badRef.ref_id);
    assert.strictEqual(bad.status, 'error');
    assert(bad.last_error.includes('vision model'));

    repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await checkAsync('a folder-derived batch of refs indexes independently — one ref per file, not one opaque folder ref', async () => {
    const tmp = mkTmp('voidcode-idx-folder-');
    const sub = path.join(tmp, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'one.txt'), 'one');
    fs.writeFileSync(path.join(sub, 'two.txt'), 'two');
    const repo = await makeRepo(tmp);
    const topic = await repo.createTopic({ title: 'C' });
    // Simulates what app/main.js's container:addRefs does when a folder is
    // selected: expand to individual file refs before indexing.
    await repo.addContainerRef({ path: path.join(sub, 'one.txt') });
    await repo.addContainerRef({ path: path.join(sub, 'two.txt') });

    const fakeAgent = { runWorker: async () => 'summary' };
    const manager = new FocusManager({ provider: {}, cfg: {}, cwd: tmp, mcpServers: [] });
    manager.setToolCtx({});
    const { id } = manager.spawnCustom({ description: 'idx', role: 'indexer', runFn: (s) => indexContainer({ agent: fakeAgent, repository: repo, topicId: topic.topicId, session: s }) });
    const session = await waitForDone(manager, id);

    assert(/Indexed 2/.test(session.finalReport), session.finalReport);
    const records = await repo.list({ topicId: topic.topicId });
    assert.strictEqual(records.length, 2);

    repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall container indexer tests passed');
  process.exit(failures ? 1 : 0);
}

main();
