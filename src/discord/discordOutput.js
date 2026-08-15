// Turns Agent's `events` callback bag (see src/index.js for the CLI's own
// rendering of the same events) into Discord traffic: throttled message
// edits for streamed text (Discord rate-limits edits — don't edit per token),
// and short follow-up messages for tool/file/todo/focus activity.

const EDIT_INTERVAL_MS = 1600;
const CHUNK_LIMIT = 1900; // stay under Discord's 2000-char message cap

// Fence-aware splitter: never leaves an open ``` fence dangling in a chunk —
// closes it at the chunk boundary and reopens (same language tag) at the
// start of the next chunk, so a long code block still renders correctly
// across multiple messages.
function chunkMessage(text, limit = CHUNK_LIMIT) {
  if (!text) return [];
  if (text.length <= limit) return [text];

  const fenceRe = /^```(\S*)/;
  const lines = text.split('\n');
  const chunks = [];
  let current = [];
  let currentLen = 0;
  let inFence = false;
  let fenceLang = '';

  const flush = () => {
    if (!current.length) return;
    let chunkText = current.join('\n');
    if (inFence) chunkText += '\n```';
    chunks.push(chunkText);
    current = [];
    currentLen = 0;
    if (inFence) {
      const reopen = '```' + fenceLang;
      current.push(reopen);
      currentLen = reopen.length + 1;
    }
  };

  for (const rawLine of lines) {
    let line = rawLine;
    // Hard-split a single line longer than the whole limit (rare — e.g. a
    // giant minified blob). Best-effort: closes/reopens fences at the outer
    // loop boundary only, not mid-hard-split.
    while (line.length > limit) {
      flush();
      chunks.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    const addLen = line.length + 1;
    if (currentLen + addLen > limit) flush();
    current.push(line);
    currentLen += addLen;
    const m = fenceRe.exec(line.trim());
    if (m) inFence ? (inFence = false, fenceLang = '') : (inFence = true, fenceLang = m[1] || '');
  }
  flush();
  return chunks.filter((c) => c.length > 0);
}

function toolLine(name, args) {
  const detail = args?.command || args?.filePath || args?.pattern || args?.url || args?.path || args?.description || '';
  return `\`▸ ${name}\`${detail ? ` — \`${String(detail).slice(0, 150)}\`` : ''}`;
}

// Returns { events, finalize } — pass `events` into `new Agent({..., events})`
// (or reassign `agent.events = events` before each send()), then `await
// finalize()` once `agent.send()` resolves to flush any buffered text.
function makeEventsForMessage(channel) {
  let buffer = '';
  let liveMsg = null;
  let lastEditAt = 0;
  let editTimer = null;
  let flushing = Promise.resolve();

  const scheduleFlush = () => {
    if (editTimer) return;
    const wait = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - lastEditAt));
    editTimer = setTimeout(async () => {
      editTimer = null;
      await doFlush();
    }, wait);
  };

  async function doFlush() {
    flushing = flushing.then(async () => {
      if (!buffer.trim()) return;
      lastEditAt = Date.now();
      const chunks = chunkMessage(buffer);
      // Edit the live message with the last chunk in progress; once a chunk
      // is "closed out" by overflow into a new one, send it as its own
      // message and start a fresh live message for what follows.
      for (let i = 0; i < chunks.length - 1; i++) {
        if (liveMsg) { try { await liveMsg.edit(chunks[i]); } catch { /* best effort */ } liveMsg = null; }
        else { try { await channel.send(chunks[i]); } catch { /* best effort */ } }
      }
      const last = chunks[chunks.length - 1];
      try {
        if (liveMsg) await liveMsg.edit(last);
        else liveMsg = await channel.send(last);
      } catch { /* best effort — next flush will retry with fuller buffer */ }
    });
    return flushing;
  }

  const send = async (text) => {
    try { await channel.send(text); } catch { /* best effort */ }
  };

  const events = {
    onDelta: (t) => { buffer += t; scheduleFlush(); },
    onReasoningDelta: () => { /* not surfaced to Discord — keeps channels focused on the final answer */ },
    onToolStart: (name, args) => { send(toolLine(name, args)); },
    onToolEnd: (name, args, ok, output) => {
      if (!ok) send(`  ✗ \`${name}\` failed: ${String(output).slice(0, 200)}`);
    },
    onFileChange: (file, before, after) => {
      const rel = file;
      send(before === null ? `  + created \`${rel}\` (${after.length} chars)` : `  ✎ edited \`${rel}\``);
    },
    onTodos: (todos) => {
      const lines = todos.map((t) => `${t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '▸' : '○'} ${t.content}`);
      send(lines.join('\n'));
    },
    onSubagentStart: (desc) => send(`◆ subagent: ${desc}`),
    onSubagentEnd: (desc, result) => send(`  ${String(result).slice(0, 300)}`),
    onFocusStart: (session) => send(`⧉ focus (${session.id}): ${session.description}`),
    onFocusQuestion: (session, question) => send(`❓ focus ${session.id} asks: ${question}`),
    onFocusDone: (session, status, report) => send(`${status === 'done' ? '✅' : status === 'timeout' ? '⏱' : '✗'} focus ${session.id} ${status}: ${String(report || '(no report)').slice(0, 300)}`),
    onStatus: () => { /* no typing-indicator-style surface needed beyond the initial typing() call */ },
    onContextTrace: () => { /* CLI-only diagnostic */ },
  };

  const finalize = async () => {
    if (editTimer) { clearTimeout(editTimer); editTimer = null; }
    await doFlush();
    buffer = '';
    liveMsg = null;
  };

  return { events, finalize };
}

module.exports = { chunkMessage, makeEventsForMessage };
