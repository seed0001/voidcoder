// Line diff (LCS) rendered as HTML. Context collapsed to ±2 lines per hunk.
/* exported renderDiffHtml */

function diffOps(oldText, newText) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  if (a.length * b.length > 4_000_000) return null;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push({ t: ' ', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: '-', line: a[i] }); i++; }
    else { ops.push({ t: '+', line: b[j] }); j++; }
  }
  while (i < m) ops.push({ t: '-', line: a[i++] });
  while (j < n) ops.push({ t: '+', line: b[j++] });
  return ops;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderDiffHtml(oldText, newText) {
  if (oldText === null || oldText === undefined) {
    const lines = String(newText ?? '').split('\n').slice(0, 200);
    return `<div class="diff">${lines.map((l) => `<span class="d-add">+ ${esc(l)}</span>`).join('')}</div>`;
  }
  const ops = diffOps(oldText, newText);
  if (!ops) return '<div class="diff"><span class="d-skip">diff too large</span></div>';
  const keep = new Set();
  ops.forEach((op, idx) => {
    if (op.t !== ' ') for (let k = idx - 2; k <= idx + 2; k++) keep.add(k);
  });
  const rows = [];
  let skipping = false;
  ops.forEach((op, idx) => {
    if (!keep.has(idx)) {
      if (!skipping) { rows.push('<span class="d-skip">⋮</span>'); skipping = true; }
      return;
    }
    skipping = false;
    if (op.t === '+') rows.push(`<span class="d-add">+ ${esc(op.line)}</span>`);
    else if (op.t === '-') rows.push(`<span class="d-del">- ${esc(op.line)}</span>`);
    else rows.push(`<span class="d-ctx">  ${esc(op.line)}</span>`);
  });
  return `<div class="diff">${rows.join('')}</div>`;
}
