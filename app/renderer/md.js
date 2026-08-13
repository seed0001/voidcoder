// Tiny markdown → HTML renderer (no deps). Covers what an agent emits:
// headers, fences, inline code, bold/italic, lists, blockquotes, links, hr.
/* exported renderMarkdown */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(s) {
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, (_, t) => `<code>${t}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return out;
}

function renderMarkdown(text) {
  const lines = String(text).split('\n');
  const html = [];
  let inFence = false, fenceBuf = [], listType = null, para = [];

  const closePara = () => {
    if (para.length) { html.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  const closeList = () => {
    if (listType) { html.push(`</${listType}>`); listType = null; }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inFence) {
        html.push(`<pre><code>${escapeHtml(fenceBuf.join('\n'))}</code></pre>`);
        fenceBuf = [];
        inFence = false;
      } else {
        closePara(); closeList();
        inFence = true;
      }
      continue;
    }
    if (inFence) { fenceBuf.push(line); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closePara(); closeList(); html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { closePara(); closeList(); html.push('<hr/>'); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      closePara();
      const want = ul ? 'ul' : 'ol';
      if (listType !== want) { closeList(); html.push(`<${want}>`); listType = want; }
      html.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }

    const bq = line.match(/^\s*>\s?(.*)$/);
    if (bq) { closePara(); closeList(); html.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }

    if (!line.trim()) { closePara(); closeList(); continue; }
    para.push(line.trim());
  }
  if (inFence && fenceBuf.length) html.push(`<pre><code>${escapeHtml(fenceBuf.join('\n'))}</code></pre>`);
  closePara(); closeList();
  return html.join('\n');
}
