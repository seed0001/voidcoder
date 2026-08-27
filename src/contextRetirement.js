// Chunked context retirement — replaces "flatten the whole conversation into
// one lossy prose blob" compaction with: take the OLDEST safe chunk only,
// extract what's durable (roadmap progress + facts worth keeping) out of it,
// leave a short pointer in its place, and never touch the most recent
// exchanges. Pure/testable functions here; src/agent.js owns the I/O
// (calling the small model, writing project memory, persisting the session).
//
// Why not just fix the old "keep a verbatim tail" bug and stop there: that
// bug (tail computed by walking backward over PLAIN TEXT messages only, so it
// comes up empty the instant the last message is a tool result — which it
// almost always is mid-turn) is subsumed here by classifying the message list
// into atomic UNITS first (a tool_calls message plus all of its matching
// tool-result messages counts as one unit) and always protecting the most
// recent N units, whatever their shape. On top of that, retirement is
// incremental (one bounded chunk per call, oldest first) instead of
// monolithic, and what's extracted from a retired chunk is structured
// (roadmap updates + durable facts) instead of a single free-form paragraph
// the model has to re-derive its plan from.

const PROTECT_UNITS = 3; // never retire the most recent N units
const CHUNK_UNITS = 6;   // retire at most this many oldest units per call
const MAX_MSG_CHARS = 2000;
const MAX_TRANSCRIPT_CHARS = 300000;

function clipText(s, n) {
  const one = String(s == null ? '' : s);
  return one.length <= n ? one : one.slice(0, n) + '…';
}

// Group a message list into atomic units: a tool_calls-bearing assistant
// message plus every tool-result message that answers one of its calls is
// ONE unit (never split across a retirement boundary); everything else is
// its own single-message unit. Units cover the whole array, in order.
function classifyUnits(messages) {
  const units = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const ids = new Set(m.tool_calls.map((c) => c.id));
      let j = i + 1;
      while (j < messages.length && messages[j] && messages[j].role === 'tool' && ids.has(messages[j].tool_call_id)) j++;
      units.push({ start: i, end: j });
      i = j;
    } else {
      units.push({ start: i, end: i + 1 });
      i++;
    }
  }
  return units;
}

// Decide the next chunk to retire: the oldest CHUNK_UNITS units, stopping
// short of the protected tail. Returns null when nothing can be safely
// retired (short conversation, or everything is within the protected tail).
function planRetirement(messages) {
  const units = classifyUnits(messages);
  const retirable = units.length - PROTECT_UNITS;
  if (retirable < 1) return null;
  const chunkUnits = units.slice(0, Math.min(CHUNK_UNITS, retirable));
  return {
    start: chunkUnits[0].start,
    end: chunkUnits[chunkUnits.length - 1].end,
  };
}

function transcriptFor(messages, { start, end }) {
  return messages.slice(start, end).map((m) => {
    const role = m.role;
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    const tools = m.tool_calls ? ` [called: ${m.tool_calls.map((t) => t.function.name).join(', ')}]` : '';
    return `${role}${tools}: ${clipText(content, MAX_MSG_CHARS)}`;
  }).join('\n').slice(0, MAX_TRANSCRIPT_CHARS);
}

// Render the current roadmap for the extraction prompt, indexed so the reply
// can reference items by number instead of having to reproduce their text
// (fuzzy text matching against a small/weak model's paraphrase is unreliable;
// index references are not).
function renderIndexedRoadmap(todos) {
  if (!Array.isArray(todos) || !todos.length) return '(no roadmap yet)';
  return todos.map((t, i) => `${i}: ${t.phase || 'Tasks'} :: ${t.content} [${t.status}]`).join('\n');
}

function buildRetirementPrompt({ todos, chunkTranscript }) {
  const system = `You are the memory-maintenance process for a coding agent. A chunk of its conversation is about to be evicted from the active context window to stay under budget. Read it and extract ONLY what is durably worth keeping — do not narrate the chunk back.

Reply in EXACTLY this format (omit nothing, use literal "none" where empty):

ROADMAP:
complete: <comma-separated indices from the roadmap below that this chunk shows are now done, or none>
in_progress: <comma-separated indices this chunk shows are now actively being worked, or none>
new: <phase> :: <content>
new: <phase> :: <content>
(one "new:" line per newly-discovered step this chunk reveals; write "new: none" if there are none)

MEMORY:
- <a durable fact worth persisting across the whole project: an architecture decision, a file's final state, a constraint discovered, a bug found — one per line>
(write "- none" if nothing here rises to that bar; do not restate the roadmap here)

POINTER: <one or two dense sentences: what this chunk accomplished, in case someone needs to know what happened here even though the detail is gone>`;

  const user = `Current roadmap (index: phase :: content [status]):\n${renderIndexedRoadmap(todos)}\n\nChunk being retired:\n${chunkTranscript}`;
  return { system, user };
}

function parseIndices(line) {
  return String(line || '')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0);
}

// Lenient parse — a small/local model will not always follow the format
// exactly. Anything that doesn't parse falls back to treating the whole
// reply as the pointer summary rather than losing it outright.
function parseRetirementReply(text) {
  const s = String(text || '');
  const result = { completeIdx: [], inProgressIdx: [], newItems: [], memoryFacts: [], pointer: '' };

  const completeM = s.match(/complete:\s*([^\n]*)/i);
  const inProgressM = s.match(/in_progress:\s*([^\n]*)/i);
  if (completeM) result.completeIdx = parseIndices(completeM[1]);
  if (inProgressM) result.inProgressIdx = parseIndices(inProgressM[1]);

  const newRe = /^new:\s*(.+)$/gim;
  let m;
  while ((m = newRe.exec(s))) {
    const line = m[1].trim();
    if (!line || /^none$/i.test(line)) continue;
    const parts = line.split('::');
    if (parts.length >= 2) {
      result.newItems.push({ phase: parts[0].trim() || 'Tasks', content: parts.slice(1).join('::').trim() });
    } else {
      result.newItems.push({ phase: 'Tasks', content: line });
    }
  }

  const memoryM = s.match(/MEMORY:\s*([\s\S]*?)(?:\n\s*POINTER:|$)/i);
  if (memoryM) {
    result.memoryFacts = memoryM[1]
      .split('\n')
      .map((l) => l.replace(/^\s*-\s*/, '').trim())
      .filter((l) => l && !/^none$/i.test(l));
  }

  const pointerM = s.match(/POINTER:\s*([\s\S]*)$/i);
  result.pointer = pointerM ? pointerM[1].trim() : '';

  // Nothing recognizable at all — treat the raw reply as the pointer so the
  // retirement still leaves SOMETHING behind instead of a blank line.
  if (!completeM && !inProgressM && !newRe.test(s) && !memoryM && !pointerM) {
    result.pointer = clipText(s.trim(), 600);
  }
  return result;
}

// Pure merge: never mutates `existing`. Status only ever moves forward
// (pending -> in_progress -> completed), so a stale/contradictory extraction
// can't regress an item that later chunks already advanced.
const STATUS_RANK = { pending: 0, in_progress: 1, completed: 2 };

function mergeRoadmap(existing, { completeIdx, inProgressIdx, newItems }) {
  const todos = (existing || []).map((t) => ({ ...t }));
  const advance = (idx, status) => {
    if (idx < 0 || idx >= todos.length) return;
    if (STATUS_RANK[status] > STATUS_RANK[todos[idx].status || 'pending']) todos[idx].status = status;
  };
  for (const idx of inProgressIdx || []) advance(idx, 'in_progress');
  for (const idx of completeIdx || []) advance(idx, 'completed');
  for (const item of newItems || []) {
    if (item.content) todos.push({ phase: item.phase || 'Tasks', content: item.content, status: 'pending' });
  }
  return todos;
}

// Render the roadmap for the system prompt — grouped by phase, with the
// active step marked so the model doesn't have to hunt for it.
function renderRoadmap(todos) {
  if (!Array.isArray(todos) || !todos.length) {
    return '(no roadmap yet — use todowrite to start one for any multi-step task)';
  }
  const activeIdx = todos.findIndex((t) => t.status === 'in_progress');
  const currentIdx = activeIdx >= 0 ? activeIdx : todos.findIndex((t) => t.status === 'pending');
  const phases = [];
  const byPhase = new Map();
  todos.forEach((t, i) => {
    const phase = t.phase || 'Tasks';
    if (!byPhase.has(phase)) { byPhase.set(phase, []); phases.push(phase); }
    byPhase.get(phase).push({ ...t, i });
  });
  const lines = [];
  for (const phase of phases) {
    lines.push(`## ${phase}`);
    for (const t of byPhase.get(phase)) {
      const box = t.status === 'completed' ? '[x]' : '[ ]';
      const marker = t.i === currentIdx ? '  ← current step' : '';
      lines.push(`- ${box} ${t.content}${marker}`);
    }
  }
  const remaining = todos.filter((t) => t.status !== 'completed').length;
  lines.push(`(${remaining} of ${todos.length} step(s) remaining)`);
  return lines.join('\n');
}

module.exports = {
  PROTECT_UNITS,
  CHUNK_UNITS,
  classifyUnits,
  planRetirement,
  transcriptFor,
  renderIndexedRoadmap,
  buildRetirementPrompt,
  parseRetirementReply,
  mergeRoadmap,
  renderRoadmap,
};
