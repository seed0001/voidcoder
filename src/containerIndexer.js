// Deterministic tiered file-indexing pipeline for containers (see the
// approved container-feature plan). Walks a container's container_refs,
// classifies each referenced file by extension against a WHITELIST (never a
// blacklist — anything not explicitly recognized falls to metadata-only
// rather than being read as text and mangled), extracts content only via a
// path that's safe for that tier, and writes results into the container's
// own context db as records + cross-reference relationships.
//
// Runs inside a FocusManager.spawnCustom() session (src/focus.js) for
// progress visibility in the existing Focus drill-down UI — but unlike a
// normal FocusSession, nothing here is model-driven tool-calling. The walk,
// hashing, and tiering are all plain deterministic code; the model is only
// invoked for the specific sub-steps that need it (text summarization,
// image description, cross-reference identification).
//
// `agent` is the live, already-running main Agent instance — reused for its
// runWorker() (organism cost routing, vision-model assertion, tool registry
// already wired up). Known limitation: runWorker's worker-side toolset is
// built from `agent.toolCtx`, which reflects whatever project/container is
// CURRENTLY open in the app, not necessarily the container being indexed —
// harmless in practice since the summarization/vision/transcription prompts
// below are direct "process this given content" tasks that don't invite
// further tool use, but worth knowing if that ever changes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.csv', '.tsv', '.json', '.yml', '.yaml',
  '.xml', '.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.php', '.sh', '.ps1', '.sql', '.ini', '.cfg', '.conf', '.toml', '.log',
]);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.flac']);
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const AUDIO_MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };

// Matches fsTools.js's MAX_READ — keeps a single file's indexed text bounded
// the same way the interactive `read` tool already bounds itself.
const MAX_TEXT_CHARS = 250000;

function classifyTier(ext) {
  if (TEXT_EXTS.has(ext)) return 'text';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'unsupported';
}

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

async function summarizeText(agent, filePath, text) {
  const prompt = `Read this file and produce, for a searchable project index: 1) a one-line title, 2) a 2-3 sentence summary, 3) up to 8 short comma-separated tags for key topics/entities/fields mentioned. Be concise and factual — never invent anything not present in the content.\n\nFile: ${filePath}\n\nContent:\n${text}`;
  return agent.runWorker(prompt, { streamTools: false });
}

async function analyzeImageFile(agent, filePath, ext) {
  const buffer = fs.readFileSync(filePath);
  const mimeType = IMAGE_MIME[ext] || 'image/png';
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
  return agent.runWorker(
    'Describe this image for a searchable project index: what it shows, any visible text, and key details someone might search for.',
    { images: [{ mimeType, bytes: buffer.length, dataUrl }], streamTools: false }
  );
}

async function transcribeAudioFile(filePath, ext) {
  const voiceIO = require('./voiceIO');
  const buffer = fs.readFileSync(filePath);
  const mimeType = AUDIO_MIME[ext] || 'audio/mpeg';
  return voiceIO.transcribe(buffer, mimeType);
}

// Cross-reference pass: one model call per indexing run (not per file pair)
// over title-only summaries of every record in the topic, asked to identify
// genuine relationships. Bounded and cheap by design — see problem #2 in
// the approved plan (indexing cost control).
async function crossReferencePass({ agent, repository, topicId, session }) {
  const records = await repository.list({ topicId, limit: 200 });
  if (records.length < 2) return;
  const brief = records.map((r) => `${r.record_id}: ${r.title}`).join('\n');
  const prompt = `Here is a list of indexed files in one project (id: title):\n${brief}\n\nIdentify genuine cross-references between these files based on their titles alone (e.g. a spreadsheet and the report that discusses it, a design doc and the code implementing it). Respond with ONLY a JSON array of objects: {"from": "<record_id>", "to": "<record_id>", "type": "references"|"mentions"|"related_to", "note": "<short reason>"}. If there are no clear cross-references, respond with exactly [].`;
  const raw = await agent.runWorker(prompt, { streamTools: false });
  let triples;
  try {
    const match = String(raw).match(/\[[\s\S]*\]/);
    triples = JSON.parse(match ? match[0] : raw);
  } catch {
    session.addLog('cross-reference pass: model response was not valid JSON, skipping');
    return;
  }
  if (!Array.isArray(triples) || !triples.length) return;
  let added = 0;
  for (const t of triples.slice(0, 50)) {
    if (!t?.from || !t?.to || t.from === t.to) continue;
    try {
      await repository.addRelationship({ fromRecordId: t.from, toRecordId: t.to, relationshipType: t.type || 'related_to', metadata: { note: t.note || '' } });
      added++;
    } catch { /* one malformed triple must not abort the rest of the pass */ }
  }
  session.addLog(`cross-reference pass: added ${added} relationship(s)`);
}

// Indexes every ref in `topicId`'s container, or only `refIds` if given
// (used right after container:addRefs to process just the new files without
// re-scanning everything already indexed). Always explicit/user-triggered —
// see problem #2 in the approved plan; nothing here runs on a timer.
async function indexContainer({ agent, repository, topicId, session, refIds = null }) {
  const allRefs = await repository.listContainerRefs();
  const refs = refIds ? allRefs.filter((r) => refIds.includes(r.ref_id)) : allRefs;

  let indexedCount = 0, skipped = 0, failed = 0, missing = 0;

  for (const ref of refs) {
    if (session.abort?.signal?.aborted) break;

    let stat;
    try {
      stat = fs.statSync(ref.path);
    } catch {
      await repository.updateContainerRef(ref.ref_id, { status: 'missing' });
      session.addLog({ kind: 'note', text: `missing: ${ref.path}` });
      missing++;
      continue;
    }
    if (stat.isDirectory()) continue; // a folder ref is a container of individual file refs, added at addRefs time — never indexed itself

    const mtimeMs = Math.round(stat.mtimeMs);
    if (ref.status === 'indexed' && ref.mtime_ms === mtimeMs) {
      skipped++;
      continue; // unchanged since last index — zero cost, not even a hash
    }

    let buffer;
    try {
      buffer = fs.readFileSync(ref.path);
    } catch (err) {
      await repository.updateContainerRef(ref.ref_id, { status: 'error', last_error: err.message });
      session.addLog({ kind: 'note', text: `read failed: ${ref.path} — ${err.message}` });
      failed++;
      continue;
    }
    const hash = sha1(buffer);
    if (ref.status === 'indexed' && ref.content_hash === hash) {
      await repository.updateContainerRef(ref.ref_id, { mtime_ms: mtimeMs }); // touched but content unchanged — refresh mtime, skip reprocessing
      skipped++;
      continue;
    }

    const ext = path.extname(ref.path).toLowerCase();
    const tier = classifyTier(ext);
    const recordId = ref.record_id || crypto.randomUUID();
    const title = path.basename(ref.path);
    let summary = '';
    let content = { path: ref.path, ext, sizeBytes: stat.size, mtime: stat.mtime.toISOString() };

    try {
      if (tier === 'text') {
        const text = buffer.toString('utf8').slice(0, MAX_TEXT_CHARS);
        summary = await summarizeText(agent, ref.path, text);
        content = { ...content, text };
      } else if (tier === 'image') {
        summary = await analyzeImageFile(agent, ref.path, ext);
      } else if (tier === 'audio') {
        const transcript = await transcribeAudioFile(ref.path, ext);
        summary = String(transcript).slice(0, 500);
        content = { ...content, transcript };
      } else {
        summary = `Unsupported format (${ext || 'no extension'}) — indexed by filename/path only, not content.`;
      }

      await repository.upsert({
        recordId, version: '1', kind: 'knowledge', topicId,
        title, summary: String(summary).slice(0, 2000), content, source: ref.path, tags: [ext.replace('.', '') || 'no-ext'],
      });
      await repository.updateContainerRef(ref.ref_id, {
        content_hash: hash, mtime_ms: mtimeMs, record_id: recordId, tier,
        status: 'indexed', last_error: null, last_indexed_at: new Date().toISOString(),
      });
      session.addLog({ kind: 'tool', tool: `index:${tier}`, args: { path: ref.path }, ok: true, output: String(summary).slice(0, 300) });
      indexedCount++;
    } catch (err) {
      // Per-file isolation (problem #5 in the approved plan): a failure here
      // — most commonly assertVisionModel rejecting a non-vision-capable
      // model — marks just this ref as errored and the loop continues to
      // the next file, instead of aborting the whole indexing run.
      await repository.updateContainerRef(ref.ref_id, { status: 'error', last_error: err.message, tier });
      session.addLog({ kind: 'tool', tool: `index:${tier}`, args: { path: ref.path }, ok: false, output: err.message });
      failed++;
    }
  }

  if (indexedCount > 0) {
    try {
      await crossReferencePass({ agent, repository, topicId, session });
    } catch (err) {
      session.addLog(`cross-reference pass failed: ${err.message}`);
    }
  }

  const report = `Indexed ${indexedCount}, skipped ${skipped} unchanged, ${missing} missing, ${failed} failed.`;
  session.finish(report, 'done');
  return { indexed: indexedCount, skipped, missing, failed };
}

module.exports = { indexContainer, classifyTier, crossReferencePass, TEXT_EXTS, IMAGE_EXTS, AUDIO_EXTS };
