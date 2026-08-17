// Universal Turn Interceptor + behavioral learning memory.
//
// Hooks into the agent loops and, right before every LLM call, evaluates the
// state of the conversation (last tool output) and appends temporary system
// rules. The rules are ephemeral — they are only spliced into the copy of the
// history that is sent to the provider, never persisted into the session.
//
// Two responsibilities:
//   1. Detection  — does the last tool output show an error, a 0-result
//                   search, a foreign-script scrape, or a very long blob?
//                   React with the matching grounded-reality rule.
//   2. Memory     — behavioral lessons (if trigger then behavior) saved by the
//                   agent at the moment it hits a wall, stored in
//                   ~/.voidcode/learnings.md, matched against the current
//                   turn, and re-injected so the same class of mistake is not
//                   made twice.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_LEARNINGS = path.join(os.homedir(), '.voidcode', 'learnings.md');

// Test override for the store path (setStorePath / resetStorePath).
let _storePath = null;

// ---- tool-outcome detection ------------------------------------------------

// Outputs that look like an empty result but are *normal* signals — they must
// not be treated as a search failure (these bump the streak down, not up).
const BENIGN_NO_RESULT = [
  '(no new messages)',
  '(no messages)',
  'No active focus sessions',
  'No focus session',
  'No waiting session',
];

// Exactly-matching empty-result strings from the search/file tools.
const ZERO_HIT_EXACT = [
  'No search results found.',
  'No matches.',
  'No files matched.',
  'No results found.',
];

const ZERO_HIT_RE = /\bno (search results|results|matches|matching files|files found)\b/i;

// Outcome of a tool result. One of: 'content' | 'zero' | 'error' | 'benign'.
function toolOutcome(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'error';
  if (/^(ERROR|DENIED|FAILED):/i.test(s)) return 'error';
  if (/^Error:/i.test(s) && /\b(HTTP|fetch|network|URI|Failed|cannot|not found|ENOENT)\b/i.test(s)) return 'error';
  if (BENIGN_NO_RESULT.includes(s)) return 'benign';
  if (ZERO_HIT_EXACT.includes(s)) return 'zero';
  if (ZERO_HIT_RE.test(s)) return 'zero';
  return 'content';
}

// Consecutive losing tool results at the tail of the message list. Walks
// backwards over trailing `role: 'tool'` messages and counts zero/error
// outcomes. Stops at the first message that is not a tool result.
function zeroHitStreak(messages) {
  let streak = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'tool') break;
    const outcome = toolOutcome(m.content);
    if (outcome === 'zero' || outcome === 'error') streak++;
    else break; // a contentful result resets the streak
  }
  return streak;
}

// ---- foreign-script detection ----------------------------------------------

const SCRIPTS = [
  { name: 'CJK (Chinese/Japanese/Korean)', re: /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/ },
  { name: 'Cyrillic', re: /[\u0400-\u04ff]/ },
  { name: 'Arabic script', re: /[\u0600-\u06ff]/ },
  { name: 'Devanagari', re: /[\u0900-\u097f]/ },
  { name: 'Thai', re: /[\u0e00-\u0e7f]/ },
  { name: 'Hebrew', re: /[\u0590-\u05ff]/ },
];

// Returns the script name when the text contains a meaningful amount of a
// non-Latin script, otherwise null.
function detectForeignScript(text) {
  const s = String(text || '');
  for (const sc of SCRIPTS) {
    const hits = (s.match(new RegExp(sc.re.source, 'g')) || []).length;
    if (hits >= 3) return sc.name;
  }
  return null;
}

// Detect a degenerate repetition collapse — some models occasionally fall
// into a tight loop over a tiny handful of words/phrases, shuffled and
// recombined rather than one fixed string repeating verbatim (sometimes
// drifting into a language unrelated to the conversation, as observed with
// certain OpenRouter models under specific quantizations). This is a
// sampling/provider fault, not real prose, and is language-agnostic by
// design — unlike detectForeignScript above, which only flags a SCRIPT
// change (Cyrillic/Arabic/etc.), not a same-script language collapse like
// French, and unlike naive exact-phrase matching, which misses a collapse
// that keeps reshuffling its small vocabulary into slightly different
// phrase orders (observed in practice — no single fixed n-gram repeats
// often enough on its own to catch it).
//
// Two complementary signals, either one is sufficient:
//   1. Vocabulary collapse — real prose in any language draws on a varied
//      vocabulary; a collapse loops a tiny word set. Measured as the
//      type-token ratio (unique words / total words) over a long enough
//      sample that a naturally short vocabulary (a short reply, a code
//      block) can't false-positive.
//   2. Exact-phrase looping — the same sentence/phrase repeating verbatim
//      many times, even when the surrounding vocabulary still looks
//      moderately varied.
//
// Returns a detail object when a collapse is detected, otherwise null.
// Deliberately conservative on both signals — real long-form answers can
// legitimately reuse words/short phrases; this requires the repetition to
// dominate the sample, not just appear in it.
function detectRepetitionCollapse(text, {
  minWords = 60,
  minVocabWords = 100,
  maxTypeTokenRatio = 0.20,
  gramSize = 3,
  minGramCount = 8,
  minGramRatio = 0.10,
} = {}) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length < minWords) return null;
  const lower = words.map((w) => w.toLowerCase());

  if (words.length >= minVocabWords) {
    const uniqueWords = new Set(lower).size;
    const ratio = uniqueWords / words.length;
    if (ratio <= maxTypeTokenRatio) {
      return { kind: 'vocabulary', ratio, uniqueWords, totalWords: words.length };
    }
  }

  const counts = new Map();
  const totalGrams = lower.length - gramSize + 1;
  for (let i = 0; i < totalGrams; i++) {
    const gram = lower.slice(i, i + gramSize).join(' ');
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  let maxGram = '', maxCount = 0;
  for (const [gram, count] of counts) {
    if (count > maxCount) { maxGram = gram; maxCount = count; }
  }
  const ratio = totalGrams > 0 ? maxCount / totalGrams : 0;
  if (maxCount >= minGramCount && ratio >= minGramRatio) {
    return { kind: 'phrase', gram: maxGram, count: maxCount, ratio, totalWords: words.length };
  }
  return null;
}

// ---- learning memory (if trigger then behavior) ----------------------------

function learningsPath() {
  return _storePath || DEFAULT_LEARNINGS;
}

function readLessons() {
  try {
    return fs.readFileSync(learningsPath(), 'utf8');
  } catch {
    return null;
  }
}

// Parse the human-readable markdown lessons file into entries.
// Format:
//   ## Lesson: <title>
//   - Trigger: <keyword, keyword — all must appear> or /regex/
//   - Category: all|main|subagent|focus
//   - Behavior: <one line instruction to follow when the trigger matches>
function parseLessons(text) {
  if (!text) return [];
  const blocks = String(text).split(/^## Lesson:/m);
  const out = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    const title = (block.match(/^\s*(.+)$/m) || [])[1] || '(untitled)';
    const trigger = (block.match(/^-\s*Trigger:\s*(.+)$/mi) || [])[1] || '';
    const category = ((block.match(/^-\s*Category:\s*(.+)$/mi) || [])[1] || 'all').trim().toLowerCase();
    const behavior = (block.match(/^-\s*Behavior:\s*(.+)$/mi) || [])[1] || '';
    if (!trigger || !behavior) continue;
    out.push({ title: title.trim(), trigger: trigger.trim(), category, behavior: behavior.trim() });
  }
  return out;
}

function listLessons() {
  return parseLessons(readLessons());
}

// Normalize a trigger for dedupe: trim, lowercase, strip regex delimiters.
function normTrigger(t) {
  const s = String(t || '').trim().toLowerCase();
  return s.replace(/^\/|\/$/g, '');
}

function writeLessonsText(text) {
  fs.mkdirSync(path.dirname(learningsPath()), { recursive: true });
  fs.writeFileSync(learningsPath(), text, 'utf8');
}

function capLessons(max) {
  const lessons = listLessons();
  if (!max || lessons.length <= max) return;
  const keep = lessons.slice(lessons.length - max); // keep the newest
  const header = readLessons().split(/^## Lesson:/m)[0]; // anything before the first lesson
  const body = keep.map(lessonToMd).join('\n');
  writeLessonsText((header || '') + body);
}

function lessonToMd(l) {
  return `## Lesson: ${l.title}\n- Trigger: ${l.trigger}\n- Category: ${l.category || 'all'}\n- Behavior: ${l.behavior}\n`;
}

// Record a lesson. Dedupes on normalized trigger — a lesson is only written
// once; repeats are ignored so the file does not grow with near-identical
// entries. Returns { ok, duplicated }.
function recordLesson({ title, trigger, behavior, category = 'all', maxLearnings }) {
  if (!trigger || !behavior) return { ok: false, error: 'trigger and behavior are required' };
  const lessons = listLessons();
  if (lessons.some((l) => normTrigger(l.trigger) === normTrigger(trigger))) {
    return { ok: true, duplicated: true };
  }
  const existing = readLessons() || '';
  const header = existing.split(/^## Lesson:/m)[0];
  const t = title || String(trigger).replace(/^\/|\/$/g, '').split(/,/)[0].trim().slice(0, 60) || 'lesson';
  const entry = lessonToMd({ title: t, trigger, category: category || 'all', behavior });
  const next = (header || '') + (header ? (header.endsWith('\n') ? '' : '\n') : '') + entry;
  writeLessonsText(next);
  if (maxLearnings) capLessons(maxLearnings);
  return { ok: true, duplicated: false };
}

// Does a lesson trigger fire against the current turn's haystack?
function triggerMatches(trigger, haystack) {
  const h = String(haystack || '');
  const t = String(trigger || '').trim();
  if (!t || !h) return false;
  if (t.startsWith('/') && t.endsWith('/')) {
    try {
      return new RegExp(t.slice(1, -1), 'i').test(h);
    } catch { return false; }
  }
  const keywords = t.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (!keywords.length) return false;
  const lower = h.toLowerCase();
  return keywords.every((k) => lower.includes(k));
}

function categoryApplies(category, kind) {
  if (!category || category === 'all') return true;
  return category === kind;
}

// ---- repeated tool-call detection -------------------------------------------

// Web search/fetch calls are intentionally repeatable while exploring sources.
// Keep this conservative: local file, shell, edit, memory, and control tools
// remain visible to the detector.
const REPEATABLE_TOOL_RE = /^(?:websearch|web_search|webfetch|web_fetch|search_(?:repos|packages|news)|rss_fetch)$/i;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stableValue(value[key]);
      return out;
    }, {});
  }
  return value;
}

function normalizeToolArguments(raw) {
  if (raw && typeof raw === 'object') return stableValue(raw);
  const text = String(raw || '').trim();
  if (!text) return {};
  try { return stableValue(JSON.parse(text)); } catch { return text; }
}

function toolCallSignature(call) {
  const name = call?.function?.name || call?.name || '';
  const rawArgs = call?.function?.arguments ?? call?.arguments ?? {};
  return JSON.stringify({ name, arguments: normalizeToolArguments(rawArgs) });
}

// Return the trailing run of identical non-web calls. This intentionally
// counts emitted calls even when their role:tool response is missing: that is
// one of the failure modes this guard is meant to catch. A plain assistant/user
// turn resets the run; tool-result messages do not.
function repeatedToolCallStreak(messages) {
  if (!Array.isArray(messages) || !messages.length) return { count: 0, signature: null, name: null, args: null };
  let lastSignature = null;
  let lastCall = null;
  let count = 0;
  for (const message of messages) {
    if (!message) continue;
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const name = call?.function?.name || call?.name || '';
        if (REPEATABLE_TOOL_RE.test(name)) continue;
        const signature = toolCallSignature(call);
        if (signature === lastSignature) count++;
        else { lastSignature = signature; lastCall = call; count = 1; }
      }
    } else if (message.role === 'assistant' || message.role === 'user') {
      lastSignature = null;
      lastCall = null;
      count = 0;
    }
  }
  return {
    count,
    signature: lastSignature,
    name: lastCall?.function?.name || lastCall?.name || null,
    args: lastCall ? normalizeToolArguments(lastCall?.function?.arguments ?? lastCall?.arguments ?? {}) : null,
  };
}

const REPEATED_TOOL_WARNING = `[System Rule - Repeated Tool Call] The same non-web tool call has completed repeatedly with identical arguments. This may mean the tool did not actually fire, its response is missing from the conversation, or the arguments are not making progress. Verify the latest tool result is present and usable before acting. Do NOT blindly issue the identical call again: change the arguments, choose another approach, or explain that you are blocked.`;

const REPEATED_TOOL_STOP = `[System Rule - Repeated Tool Call Stop] The identical non-web tool call has repeated beyond the safe limit. Stop issuing that call. Report whether the tool result was missing, unusable, or unchanged, and ask for clarification if necessary.`;

const REALITY_CHECK = `[System Rule - Reality Check] The previous tool returned no useful result. You are a real software agent running locally on the user's machine. Do NOT invent fictional company employees, departments, internal wikis, IRC/helpdesk chats, or "reach out to [Name]/colleagues/teammates" workflows that do not exist. Do NOT search local project files (glob/grep) or model registries (list_models) to fill a gap about the outside world. Refine the search query with different English wording once or twice, or say plainly what could not be determined.`;

const ENGLISH_LOCK = `[System Rule - Language] Some external content you just received is written in a non-English script. All of your thinking, tool call arguments, and reports MUST be in clear professional English. Treat foreign text as source material: summarize its meaning in your own English words. Do not echo it, and do not adopt its language.`;

const DISAMBIGUATION = `[System Rule - Disambiguation] This task subject appears ambiguous or unreachable through search. Do NOT lock onto a single random interpretation and do NOT change tool domain. List the distinct candidate meanings in English, run at most one targeted search per candidate, then either ask for clarification (focus_pause) or submit a final report that clearly states the ambiguity and what was found. Never fabricate findings to avoid an empty result.`;

const STOP_AND_REPORT = `[System Rule - Dead End] You have received several consecutive empty or failed tool results. STOP retrying re-worded variations of the same search. Either (a) call focus_pause to ask the main agent which interpretation to pursue, or (b) if the subject is clear but simply unavailable, call focus_complete with an honest best-effort report that notes exactly what could not be found. An accurate "not found" is a valid result.`;

// ---- goal anchor: name + real snippet, never a dangling "you received output" ----

function clip(s, n) {
  const one = String(s).replace(/\s+/g, ' ').trim();
  if (one.length <= n) return one;
  return one.slice(0, n) + '…';
}

// Walk backwards from the last tool message to find the name of the tool it
// belongs to (the assistant message carrying the matching tool_call_id). The
// model cannot be trusted to guess WHICH tool just ran — we tell it.
function lastToolName(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'tool') return null;
  const callId = last.tool_call_id;
  for (let i = messages.length - 2; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'assistant') {
      if (Array.isArray(m.tool_calls)) {
        const tc = m.tool_calls.find((c) => c && ((c.id || c.tool_call_id) === callId));
        return tc ? (tc.function?.name || tc.name || null) : null;
      }
      return null; // hit a plain assistant message — no pairing available
    }
    if (m.role === 'user') return null; // crossed a turn boundary
    // tool / system messages: keep scanning back
  }
  return null;
}

// Build the goal-anchor rule from the ACTUAL last tool result. The label stays
// "[System Rule - Goal Anchor]" (tests and tone rely on it), but the body names
// the tool and quotes its output so the model never has to invent one. When the
// result is empty/error/zero it carries an explicit anti-fabrication warning.
function goalAnchorRule(name, outcome, content) {
  const who = name ? `"${name}"` : 'the tool you called';
  const s = String(content || '');
  const usable = outcome === 'content' && s.trim() && s.trim() !== '(no output)';
  if (usable) {
    return `[System Rule - Goal Anchor] The tool ${who} just finished and returned real output: "${clip(s, 300)}". Analyze THAT output strictly against the task you were given, decide the most professional next action, and keep working. NEVER invent, assume, or describe tool output that is not actually shown in the conversation above — if you cannot see a result, you did not receive one; say so plainly and adjust. Do not just restate the output; use it.`;
  }
  return `[System Rule - Goal Anchor] The tool ${who} returned NO usable output${s.trim() ? ` (it produced: "${clip(s, 160)}")` : ' — the result was empty'}. Do NOT pretend it succeeded and do NOT invent what it would have returned: no tool ran successfully behind the scenes. Either retry with corrected arguments, switch tool or approach, or state plainly that you could not get the information.`;
}

// Detect an assistant message that LEADS with a known tool name (plain prose)
// — the classic failed text-fallback tool call that the JSON extractor missed
// (e.g. a response beginning "focus\\nGenerate novel ideas..."). Returns the
// tool name or null. Conservative: a normal sentence like "websearch returned
// three results" must NOT match.
function leadToolName(content, toolNames) {
  const s = String(content || '').trim();
  if (!s || !toolNames || !toolNames.size) return null;
  const firstLine = s.split(/\r?\n/, 1)[0].trim();
  if (!firstLine) return null;
  if (s !== firstLine) {
    // standalone tool-name line at the top ("focus" then a newline + prose)
    const bare = firstLine.replace(/[.,:;"')\]]+$/, '');
    if (toolNames.has(bare)) return bare;
  }
  const m = firstLine.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*[:{]/);
  if (m && toolNames.has(m[1])) return m[1];
  return null;
}

// Build the ephemeral system rules for the upcoming LLM call.
//
//   messages  — the message history that will be sent (last message decides).
//   kind      — 'main' | 'subagent' | 'focus'.
//   context   — { cfg, cwd } (cwd currently unused; kept for future rules).
function intercept({ messages, kind = 'main', context = {} }) {
  const cfg = context.cfg || {};
  const g = cfg.guardrails || {};
  if (g.enabled === false) return [];

  const additions = [];
  const last = messages && messages[messages.length - 1];
  const repeated = repeatedToolCallStreak(messages);
  const repeatWarningAt = g.repeatedToolCallWarningAt || 3;
  const repeatStopAt = g.repeatedToolCallStopAt || 4;
  if (!last || last.role !== 'tool') {
    if (repeated.count >= repeatStopAt) additions.push(REPEATED_TOOL_STOP);
    else if (repeated.count >= repeatWarningAt) additions.push(REPEATED_TOOL_WARNING);
    if (additions.length) additions.push(NEVER_NARRATE);
    return dedupe(additions);
  }

  const content = String(last.content || '');
  const outcome = toolOutcome(content);
  const streak = zeroHitStreak(messages);
  const maxStreak = g.maxZeroHitStreak || 3;
  const maxChunk = g.anchorLength || 4000;

  // 1) Goal anchor — anchored to the REAL last tool result (name + snippet) so
  // the model knows exactly which tool ran and what it returned. Empty/error/
  // zero results get an anti-fabrication warning instead of a fake "you just
  // received output" nudge (which caused the model to invent tool output).
  additions.push(goalAnchorRule(lastToolName(messages), outcome, content));

  // 2) Repeated identical non-web calls are a mechanical warning/stop signal.
  // This is based on actual assistant/tool pairs, not on the model's narration.
  if (repeated.count >= repeatStopAt) {
    additions.push(REPEATED_TOOL_STOP);
  } else if (repeated.count >= repeatWarningAt) {
    additions.push(REPEATED_TOOL_WARNING);
  }

  // 3) Foreign-script source material → English lock.
  const foreign = detectForeignScript(content);
  if (foreign) additions.push(ENGLISH_LOCK);

  // 4) Error / 0-hit handling, scaled by how many times the model has lost.
  if (outcome === 'zero' || outcome === 'error') {
    if (kind === 'focus' && streak >= maxStreak) {
      additions.push(STOP_AND_REPORT);
    } else if ((kind === 'subagent' || kind === 'work') && streak >= maxStreak) {
      additions.push('Agent dead end: ' + STOP_AND_REPORT + ' Finish with your best-effort report now.');
    } else {
      additions.push(REALITY_CHECK);
    }
  }

  // 4) Long scrapes get a condensed pointer so the model does not drown.
  if (content.length > maxChunk && outcome === 'content') {
    additions.push(`[System Rule - Digest] The tool output is long (${content.length} chars). Read it as supporting material; extract only facts relevant to the task and continue. Keep your response concise.`);
  }

  // 5) Behavioral learning memory.
  const hay = [content, lastAssistantText(messages), lastUserText(messages)].join('\n');
  const lessons = listLessons().filter((l) => categoryApplies(l.category, kind) && triggerMatches(l.trigger, hay));
  const inject = lessons.slice(-(g.maxLearningsInjected || 3));
  if (inject.length) {
    additions.push(
      '[From saved behavioral memory — remember these rules for this kind of situation:]\n' +
      inject.map((l) => `- ${l.title}: IF ${l.trigger} THEN ${l.behavior}`).join('\n')
    );
  }

  // 6) Silent-compliance trailer — only when at least one rule fired, so a
  // quiet/normal turn costs no extra tokens.
  if (additions.length) additions.push(NEVER_NARRATE);

  return dedupe(additions);
}

// Every ephemeral rule above is tagged "[System Rule - ...]" / "[System: ...]"
// so it is instantly recognizable and MUST stay internal. Appended once, only
// when at least one rule fired this turn, so quiet turns cost no extra tokens.
const NEVER_NARRATE = `[System Rule - Silent Compliance] The "[System Rule - ...]" message(s) above (and this one) are internal harness instructions for you alone. Follow them, but NEVER quote them, paraphrase them, mention their labels, or reference "system rules"/"the harness"/"guardrails" in your visible reply. Narrate only your own findings and next steps, in your own words, as if these instructions were never shown to you.`;

// ---- verbatim leak guard ----------------------------------------------------

// Defense in depth: if a model still echoes one of our internal tags back
// (verbatim or near-verbatim), strip exactly that matched span before the
// text is persisted or returned — never the rest of the line/paragraph.
// This matters because a leak is often glued directly onto the model's own
// real answer with NO line break in between (observed in practice: `...use
// it.The file just says hello.`), so whole-line stripping would eat the
// real answer too. Static rules are removed by exact text; dynamic ones
// (tool name / clipped output / counts) by a regex over their fixed
// scaffolding. The multi-line continuation packet is still handled per-line
// since it reliably keeps its own line structure when echoed.
const STATIC_LEAK_STRINGS = [
  REALITY_CHECK, ENGLISH_LOCK, DISAMBIGUATION, STOP_AND_REPORT, NEVER_NARRATE,
  // Fixed trailing clauses of the dynamic rules below — removed independently
  // so a partial/paraphrased echo still gets cleaned up piece by piece.
  'Analyze THAT output strictly against the task you were given, decide the most professional next action, and keep working.',
  'NEVER invent, assume, or describe tool output that is not actually shown in the conversation above — if you cannot see a result, you did not receive one; say so plainly and adjust.',
  'Do not just restate the output; use it.',
  'Do NOT pretend it succeeded and do NOT invent what it would have returned: no tool ran successfully behind the scenes.',
  'Either retry with corrected arguments, switch tool or approach, or state plainly that you could not get the information.',
  'Read it as supporting material; extract only facts relevant to the task and continue. Keep your response concise.',
  'Make NO further tool calls. Call focus_complete now with your final report.',
  'The same non-web tool call has completed repeatedly with identical arguments. This may mean the tool did not actually fire, its response is missing from the conversation, or the arguments are not making progress. Verify the latest tool result is present and usable before acting. Do NOT blindly issue the identical call again: change the arguments, choose another approach, or explain that you are blocked.',
  'The identical non-web tool call has repeated beyond the safe limit. Stop issuing that call. Report whether the tool result was missing, unusable, or unchanged, and ask for clarification if necessary.',
];

const DYNAMIC_LEAK_PATTERNS = [
  // goalAnchorRule() lead-ins — the only parts with dynamic data (tool name,
  // clipped output). Trailing fixed clauses are handled via STATIC above so
  // a partial/paraphrased echo of either half is still caught.
  /\[System Rule - Goal Anchor\] The tool "?[^"\n]*"? just finished and returned real output: "[\s\S]*?"\.?\s*/g,
  /\[System Rule - Goal Anchor\] The tool "?[^"\n]*"? returned NO usable output(?: \(it produced: "[\s\S]*?"\)| — the result was empty)?\.?\s*/g,
  // Digest rule — dynamic char count.
  /\[System Rule - Digest\] The tool output is long \(\d+ chars\)\.\s*/g,
  // Focus tool-call cap — dynamic counts.
  /\[System Rule - Tool Cap\] You have made \d+ tool calls \(session allows \d+\)\.\s*/g,
  /\[System Rule - Repeated Tool Call\][\s\S]*?explain that you are blocked\.\s*/g,
  /\[System Rule - Repeated Tool Call Stop\][\s\S]*?if necessary\.\s*/g,
  // Learning-memory injection block header + bullet lines.
  /\[From saved behavioral memory[^\]]*\](?:\n- [^\n]*)*/g,
  // Prose tool-intro recovery nudge.
  /\[tool call not recognized\][^\n]*/g,
];

const LEAK_LINE_PREFIXES = ['[System Rule', '[System:', '[Continuation Packet', '[From saved behavioral memory', '[tool call not recognized]'];
const PACKET_FIELD_RE = /^(Active task:|Current plan step:|Previous intended action:|Tool called:|Tool result:|Completed work|Expected next step:|Remaining steps:|Stop conditions:|-\s)/;

function stripLeakedSystemTags(text) {
  if (!text) return text;
  let out = String(text);

  // Dynamic (tag + variable data) first, then static fixed clauses — order
  // doesn't matter much since they target non-overlapping fixed vs. dynamic
  // spans, but doing the tagged lead-ins first keeps the static pass simple.
  for (const re of DYNAMIC_LEAK_PATTERNS) out = out.replace(re, '');
  for (const s of STATIC_LEAK_STRINGS) out = out.split(s).join('');

  // Multi-line continuation packet block: only when it keeps its own line
  // structure (the common case for a long structured block).
  const lines = out.split('\n');
  const kept = [];
  let skippingPacketBlock = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (skippingPacketBlock) {
      if (PACKET_FIELD_RE.test(trimmed)) continue;
      skippingPacketBlock = false;
    }
    if (LEAK_LINE_PREFIXES.some((p) => trimmed.startsWith(p))) {
      if (trimmed.startsWith('[Continuation Packet')) skippingPacketBlock = true;
      continue;
    }
    kept.push(line);
  }
  out = kept.join('\n');

  return out.replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '').trim();
}


function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && typeof messages[i].content === 'string') return messages[i].content.slice(0, 800);
    if (messages[i].role === 'assistant' && messages[i].tool_calls) return ''; // reached the tool round
  }
  return '';
}

function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && !m.tool_calls && typeof m.content === 'string' && m.content.trim()) {
      return m.content.slice(0, 500);
    }
    if (m.role === 'assistant' && m.tool_calls) return '';
  }
  return '';
}

function dedupe(arr) {
  const seen = new Set();
  return arr.filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

// ---- store override (tests) ------------------------------------------------

function setStorePath(p) {
  _storePath = p;
}

function resetStorePath() {
  _storePath = null;
}

module.exports = {
  intercept,
  toolOutcome,
  zeroHitStreak,
  detectForeignScript,
  detectRepetitionCollapse,
  recordLesson,
  listLessons,
  setStorePath,
  resetStorePath,
  lastToolName,
  repeatedToolCallStreak,
  toolCallSignature,
  leadToolName,
  goalAnchorRule,
  stripLeakedSystemTags,
  DEFAULT_LEARNINGS,
};