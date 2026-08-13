// Terminal rendering: ANSI colors, markdown, diffs, spinners, prompts.
// No dependencies — raw escape codes.

const ESC = '\x1b[';
const codes = {
  reset: 0, bold: 1, dim: 2, italic: 3, underline: 4, inverse: 7,
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  gray: 90, brightRed: 91, brightGreen: 92, brightYellow: 93, brightBlue: 94,
  brightMagenta: 95, brightCyan: 96, brightWhite: 97,
  bgRed: 41, bgGreen: 42,
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function style(text, ...names) {
  if (!useColor) return String(text);
  const open = names.map((n) => `${ESC}${codes[n]}m`).join('');
  return `${open}${text}${ESC}0m`;
}

const c = {};
for (const name of Object.keys(codes)) c[name] = (t) => style(t, name);
c.accent = (t) => style(t, 'brightMagenta');
c.ok = (t) => style(t, 'brightGreen');
c.err = (t) => style(t, 'brightRed');
c.warn = (t) => style(t, 'brightYellow');
c.info = (t) => style(t, 'brightCyan');
c.muted = (t) => style(t, 'gray');

// ---------------------------------------------------------------- markdown

// Stream-safe inline styling. Applied line-by-line so it works while streaming.
function inlineMd(line) {
  return line
    .replace(/`([^`]+)`/g, (_, t) => style(t, 'brightYellow'))
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => style(t, 'bold'))
    .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, (_, t) => style(t, 'italic'));
}

function renderMdLine(line, state) {
  if (/^\s*```/.test(line)) {
    state.inFence = !state.inFence;
    return c.muted(line.trim());
  }
  if (state.inFence) return style(line, 'brightWhite');
  if (/^#{1,6}\s/.test(line)) return style(line.replace(/^#+\s*/, ''), 'bold', 'brightCyan');
  if (/^\s*[-*+]\s/.test(line)) {
    const m = line.match(/^(\s*)[-*+]\s(.*)$/);
    return `${m[1]}${c.accent('•')} ${inlineMd(m[2])}`;
  }
  if (/^\s*>\s?/.test(line)) return c.muted('│ ') + inlineMd(line.replace(/^\s*>\s?/, ''));
  return inlineMd(line);
}

// Streaming markdown writer: feed chunks, it emits styled output as lines complete.
class MdStream {
  constructor(write = (s) => process.stdout.write(s)) {
    this.buf = '';
    this.state = { inFence: false };
    this.write = write;
  }
  push(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      this.write(renderMdLine(line, this.state) + '\n');
    }
    // stream the partial line raw so output feels live, then rewrite it styled on completion
    // (simple approach: emit partial only when it has no pending markdown tokens)
  }
  flush() {
    if (this.buf) {
      this.write(renderMdLine(this.buf, this.state) + '\n');
      this.buf = '';
    }
  }
}

function renderMarkdown(text) {
  const state = { inFence: false };
  return text.split('\n').map((l) => renderMdLine(l, state)).join('\n');
}

// ---------------------------------------------------------------- diff

// Line-based LCS diff, colored like a unified diff.
function diffLines(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  // LCS table (cap sizes to keep it fast)
  if (a.length * b.length > 4_000_000) {
    return [c.muted(`(diff too large: ${a.length} -> ${b.length} lines)`)];
  }
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ t: ' ', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', line: a[i] }); i++; }
    else { out.push({ t: '+', line: b[j] }); j++; }
  }
  while (i < m) out.push({ t: '-', line: a[i++] });
  while (j < n) out.push({ t: '+', line: b[j++] });

  // keep only changed hunks with 2 lines of context
  const keep = new Set();
  out.forEach((e, idx) => {
    if (e.t !== ' ') for (let k = idx - 2; k <= idx + 2; k++) keep.add(k);
  });
  const lines = [];
  let skipping = false;
  out.forEach((e, idx) => {
    if (!keep.has(idx)) {
      if (!skipping) { lines.push(c.muted('  ⋮')); skipping = true; }
      return;
    }
    skipping = false;
    if (e.t === '+') lines.push(c.ok(`+ ${e.line}`));
    else if (e.t === '-') lines.push(c.err(`- ${e.line}`));
    else lines.push(c.muted(`  ${e.line}`));
  });
  return lines;
}

// ---------------------------------------------------------------- spinner

class Spinner {
  constructor(label = 'thinking') {
    this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.label = label;
    this.i = 0;
    this.timer = null;
  }
  start(label) {
    if (label) this.label = label;
    if (!process.stdout.isTTY) return;
    this.stop();
    this.timer = setInterval(() => {
      process.stdout.write(`\r${c.accent(this.frames[this.i = (this.i + 1) % this.frames.length])} ${c.muted(this.label)}   `);
    }, 80);
  }
  update(label) { this.label = label; }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      process.stdout.write('\r' + ' '.repeat(Math.min(this.label.length + 6, 120)) + '\r');
    }
  }
}

// ---------------------------------------------------------------- misc

function truncateMiddle(s, max = 80) {
  s = String(s).replace(/\s+/g, ' ');
  return s.length <= max ? s : s.slice(0, max / 2) + '…' + s.slice(-max / 2 + 1);
}

function toolHeader(name, detail) {
  return `${c.accent('●')} ${c.bold(name)}${detail ? c.muted(`(${truncateMiddle(detail, 90)})`) : ''}`;
}

function toolResultPreview(text, maxLines = 4) {
  const lines = String(text).split('\n');
  const shown = lines.slice(0, maxLines).map((l) => c.muted(`  │ ${l.slice(0, 160)}`));
  if (lines.length > maxLines) shown.push(c.muted(`  │ … +${lines.length - maxLines} lines`));
  return shown.join('\n');
}

function hr() {
  const w = Math.min(process.stdout.columns || 80, 100);
  return c.muted('─'.repeat(w));
}

module.exports = { c, style, renderMarkdown, MdStream, diffLines, Spinner, truncateMiddle, toolHeader, toolResultPreview, hr };
