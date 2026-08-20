// VoidCode Desktop renderer — chat, sessions, review panel, settings, voice.
/* global renderMarkdown, renderDiffHtml, VoiceIO */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let snap = null;              // latest state snapshot from main
let currentView = 'desktop';  // 'desktop' | 'assistant'
let generating = false;
let speakEnabled = true;
const THEMES = ['void', 'ember', 'mono', 'violet'];
let uiTheme = 'void';
let pacerOn = true;
const sendQueue = [];
let flushingQueue = false;

// streaming state
let streamEl = null;          // current assistant markdown block
let streamText = '';
let reasoningEl = null;       // current reasoning/thinking block
let reasoningText = '';
let renderPending = false;

// TTS sentence streaming state
let ttsBuf = '';
let backtickCount = 0;
let inCodeBlock = false;
let spokeThisTurn = false;
let pendingImages = [];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const MODEL_PRESETS = [
  'openrouter/anthropic/claude-sonnet-4.5',
  'openrouter/anthropic/claude-opus-4.1',
  'openrouter/openai/gpt-5',
  'openrouter/google/gemini-2.5-flash',
  'openrouter/deepseek/deepseek-chat-v3.1',
  'ollama/llama3.1',
  'llamacpp/default',
];

// ============================================================ voice

const voice = new VoiceIO({
  onUtterance: (text) => {
    sendText(text);
  },
  onState: (s) => setOrb(s),
  onBargeIn: () => { if (generating) window.vc.stop(); },
  onError: (msg) => note(msg),
});

function setOrb(state) {
  const orb = $('#orb');
  orb.className = state;
  orb.title = state;
  $('#mic-btn').classList.toggle('rec', state === 'recording' && !voice.handsFree);
  status(state === 'recording' ? 'listening to you…'
    : state === 'transcribing' ? 'transcribing…'
    : state === 'speaking' ? 'speaking — talk to interrupt'
    : state === 'listening' ? 'hands-free: open mic'
    : '');
}

// feed streamed text to the TTS queue, sentence by sentence, skipping code fences
function ttsFeed(chunk) {
  if (!speakEnabled) return;
  let textToSpeak = '';
  for (let i = 0; i < chunk.length; i++) {
    const char = chunk[i];
    if (char === '`') {
      backtickCount++;
    } else {
      if (backtickCount >= 3) {
        inCodeBlock = !inCodeBlock;
      }
      backtickCount = 0;
      if (!inCodeBlock) {
        textToSpeak += char;
      }
    }
  }

  if (textToSpeak) {
    ttsBuf += textToSpeak;
  }

  // pull out complete sentences (≥20 chars so it doesn't sound choppy)
  let m;
  while ((m = ttsBuf.match(/^[\s\S]{20,}?[.!?…](?=\s|$)/))) {
    voice.enqueue(m[0]);
    spokeThisTurn = true;
    ttsBuf = ttsBuf.slice(m[0].length);
  }
  if (ttsBuf.length > 600) { // long stretch without sentence end — speak it anyway
    voice.enqueue(ttsBuf);
    spokeThisTurn = true;
    ttsBuf = '';
  }
}

function ttsFlush() {
  if (speakEnabled && ttsBuf.trim()) { voice.enqueue(ttsBuf); spokeThisTurn = true; }
  ttsBuf = '';
  backtickCount = 0;
  inCodeBlock = false;
}

// ============================================================ chat rendering

function chatEl() { return $('#chat'); }

function nearBottom() {
  const c = chatEl();
  return c.scrollHeight - c.scrollTop - c.clientHeight < 140;
}
function scrollChat(force) {
  const c = chatEl();
  if (force || nearBottom()) c.scrollTop = c.scrollHeight;
}

function addUserMsg(input) {
  const payload = typeof input === 'string' ? { text: input, images: [] } : (input || { text: '', images: [] });
  const el = document.createElement('div');
  el.className = 'msg-user';
  if (payload.text) {
    const text = document.createElement('div');
    text.textContent = payload.text;
    el.appendChild(text);
  }
  for (const image of payload.images || []) {
    const img = document.createElement('img');
    img.className = 'user-image';
    img.src = image.dataUrl;
    img.alt = image.name || 'Attached screenshot';
    el.appendChild(img);
  }
  chatEl().appendChild(el);
  scrollChat(true);
}

function note(text) {
  const el = document.createElement('div');
  el.className = 'sys-note';
  el.textContent = text;
  chatEl().appendChild(el);
  scrollChat();
}

function finalizeReasoning() {
  if (reasoningEl && !reasoningText.trim()) reasoningEl.remove();
  else if (reasoningEl) reasoningEl.classList.add('collapsed');
  reasoningEl = null;
  reasoningText = '';
}

function finalizeStream() {
  finalizeReasoning();
  if (streamEl && !streamText.trim()) streamEl.remove();
  streamEl = null;
  streamText = '';
}

function ensureStreamEl() {
  if (!streamEl) {
    streamEl = document.createElement('div');
    streamEl.className = 'msg-assistant';
    chatEl().appendChild(streamEl);
  }
  return streamEl;
}

function ensureReasoningEl() {
  if (!reasoningEl) {
    const el = document.createElement('div');
    el.className = 'msg-reasoning';
    el.addEventListener('click', () => el.classList.toggle('collapsed'));
    chatEl().appendChild(el);
    reasoningEl = el;
  }
  return reasoningEl;
}

let reasoningRenderPending = false;
function renderReasoningStream() {
  if (reasoningRenderPending) return;
  reasoningRenderPending = true;
  requestAnimationFrame(() => {
    reasoningRenderPending = false;
    if (reasoningEl) {
      reasoningEl.textContent = reasoningText;
      scrollChat();
    }
  });
}

function renderStream() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    if (streamEl) {
      streamEl.innerHTML = renderMarkdown(streamText);
      scrollChat();
    }
  });
}

function toolDetail(name, args) {
  return args.command || args.filePath || args.pattern || args.url || args.path || args.description || args.prompt?.slice(0, 80) || '';
}

const toolCards = new Map(); // most recent card per tool name (for fileChange attach)

function addToolCard(name, args) {
  finalizeStream();
  const card = document.createElement('div');
  card.className = 'tool-card collapsed';
  card.innerHTML = `
    <div class="tc-head">
      <span class="tc-dot"></span>
      <span class="tc-name"></span>
      <span class="tc-detail"></span>
    </div>
    <div class="tc-body"></div>`;
  card.querySelector('.tc-name').textContent = name;
  card.querySelector('.tc-detail').textContent = toolDetail(name, args);
  card.querySelector('.tc-head').addEventListener('click', () => card.classList.toggle('collapsed'));
  chatEl().appendChild(card);
  toolCards.set(name + JSON.stringify(args).slice(0, 60), card);
  card._key = name + JSON.stringify(args).slice(0, 60);
  scrollChat();
  return card;
}

// ============================================================ engine events

window.vc.onTurnStart(() => {
  generating = true;
  $('#stop-btn').classList.remove('hidden');
  $('#send-btn').classList.add('hidden');
  if (!voice.speaking && !voice.handsFree) setOrb('thinking');
  else $('#orb').className = 'thinking';
  setPacer(true);
});

window.vc.onTurnEnd(() => {
  generating = false;
  $('#stop-btn').classList.add('hidden');
  $('#send-btn').classList.remove('hidden');
  ttsFlush();
  refreshReview();
  if (!voice.speaking) setOrb(voice.handsFree ? 'listening' : 'idle');
  setPacer(false);
  flushSendQueue();
  refreshActivityWidget();
});

window.vc.onReasoningDelta((t) => {
  ensureReasoningEl();
  reasoningText += t;
  renderReasoningStream();
});

window.vc.onDelta((t) => {
  finalizeReasoning();
  ensureStreamEl();
  streamText += t;
  renderStream();
  ttsFeed(t);
});

window.vc.onToolStart(({ name, args }) => {
  addToolCard(name, args);
});

window.vc.onToolEnd(({ name, args, ok, output }) => {
  const key = name + JSON.stringify(args).slice(0, 60);
  const card = toolCards.get(key);
  if (!card) return;
  card.classList.add(ok ? 'done' : 'fail');
  const body = card.querySelector('.tc-body');
  if (!body.dataset.hasDiff) body.textContent = output;
  if (!ok) card.classList.remove('collapsed');
});

window.vc.onFileChange(({ file, before, after }) => {
  // find the newest write/edit card and put the diff in it
  const cards = [...chatEl().querySelectorAll('.tool-card')];
  const card = cards.reverse().find((el) => {
    const n = el.querySelector('.tc-name').textContent;
    return (n === 'edit' || n === 'write') && !el.querySelector('.tc-body').dataset.hasDiff;
  });
  if (card) {
    const body = card.querySelector('.tc-body');
    body.innerHTML = renderDiffHtml(before, after);
    body.dataset.hasDiff = '1';
    card.classList.remove('collapsed');
  }
  scrollChat();
});

window.vc.onTodos((todos) => {
  const pane = $('#pane-todos');
  pane.innerHTML = '';
  for (const t of todos) {
    const el = document.createElement('div');
    el.className = 'todo-item ' + (t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : 'pending');
    const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○';
    el.innerHTML = `<span class="t-mark">${mark}</span><span></span>`;
    el.querySelector('span:last-child').textContent = t.content;
    pane.appendChild(el);
  }
});

window.vc.onSubagentStart((desc) => {
  finalizeStream();
  const el = document.createElement('div');
  el.className = 'sub-card';
  el.textContent = `◆ subagent: ${desc}`;
  chatEl().appendChild(el);
  scrollChat();
});

window.vc.onSubagentEnd(({ desc, result }) => {
  const el = document.createElement('div');
  el.className = 'sub-card';
  el.textContent = `◆ subagent done: ${String(result).slice(0, 200)}`;
  chatEl().appendChild(el);
  scrollChat();
});

window.vc.onStatus((s) => status(s));

window.vc.onPermAsk(({ id, toolName, detail }) => {
  finalizeStream();
  const card = document.createElement('div');
  card.className = 'perm-card';
  card.innerHTML = `
    <div class="p-title"></div>
    <div class="p-detail"></div>
    <button class="p-allow">Allow</button>
    <button class="p-always">Always this session</button>
    <button class="p-deny">Deny</button>`;
  card.querySelector('.p-title').textContent =
    toolName === 'bash' ? 'Wants to run a command' :
    toolName === 'delete' ? 'Wants to delete' :
    `Wants to use ${toolName}`;
  card.querySelector('.p-detail').textContent = detail;
  const resolve = (answer, label) => {
    window.vc.answerPerm(id, answer);
    card.querySelectorAll('button').forEach((b) => b.remove());
    const r = document.createElement('span');
    r.className = 'p-resolved';
    r.textContent = label;
    card.appendChild(r);
  };
  card.querySelector('.p-allow').onclick = () => resolve('y', '✓ allowed');
  card.querySelector('.p-always').onclick = () => resolve('a', '✓ allowed for this session');
  card.querySelector('.p-deny').onclick = () => resolve('n', '✗ denied');
  chatEl().appendChild(card);
  scrollChat(true);
});

// ============================================================ sending

function queuePreview(item) {
  const t = String(item.text || '').trim();
  if (t) return t.length > 80 ? t.slice(0, 77) + '…' : t;
  const n = (item.images || []).length;
  return n ? `${n} image${n === 1 ? '' : 's'}` : '(empty)';
}

function renderSendQueue() {
  const box = $('#send-queue');
  if (!box) return;
  box.innerHTML = '';
  box.classList.toggle('hidden', sendQueue.length === 0);
  if (!sendQueue.length) return;
  const head = document.createElement('div');
  head.className = 'sq-head';
  head.textContent = sendQueue.length === 1
    ? 'Waiting to send — I’ll take this when I’m done'
    : `${sendQueue.length} messages waiting — I’ll take these when I’m done`;
  box.appendChild(head);
  sendQueue.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'sq-item';
    const label = document.createElement('span');
    label.className = 'sq-text';
    label.textContent = queuePreview(item);
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'sq-drop';
    drop.title = 'Discard this queued message';
    drop.textContent = '×';
    drop.addEventListener('click', () => {
      sendQueue.splice(i, 1);
      renderSendQueue();
    });
    row.appendChild(label);
    row.appendChild(drop);
    box.appendChild(row);
  });
}

function enqueueSend(text, images) {
  sendQueue.push({ text: String(text || '').trim(), images: Array.isArray(images) ? images.slice() : [] });
  renderSendQueue();
}

async function flushSendQueue() {
  if (flushingQueue || generating || !sendQueue.length) return;
  flushingQueue = true;
  try {
    while (sendQueue.length && !generating) {
      const next = sendQueue.shift();
      renderSendQueue();
      await sendText(next.text, next.images);
    }
  } finally {
    flushingQueue = false;
    renderSendQueue();
  }
}

async function sendText(text, images = pendingImages) {
  text = String(text || '').trim();
  images = Array.isArray(images) ? images : [];
  if (!text && !images.length) return;
  // Mid-turn speech/type must wait — never drop, never re-queue a flush.
  if (generating) {
    enqueueSend(text, images);
    if (images === pendingImages) {
      pendingImages = [];
      renderImagePreviews();
    }
    return;
  }
  voice.stopSpeaking();
  spokeThisTurn = false;
  ttsBuf = ''; backtickCount = 0; inCodeBlock = false;
  const payload = { text, images };
  addUserMsg(payload);
  if (images === pendingImages) {
    pendingImages = [];
    renderImagePreviews();
  }
  finalizeStream();
  const res = await window.vc.send(payload);
  finalizeStream();
  if (res?.error) note(`error: ${res.error}`);
  if (res?.interrupted) note('⏹ stopped — canceled by user');
  if (res?.snapshot) {
    snap = res.snapshot;
    renderSessions();
    statusIdle();
  }
}

function renderImagePreviews() {
  const box = $('#image-previews');
  if (!box) return;
  box.innerHTML = '';
  box.classList.toggle('hidden', pendingImages.length === 0);
  for (const [index, image] of pendingImages.entries()) {
    const item = document.createElement('div');
    item.className = 'image-preview';
    const img = document.createElement('img');
    img.src = image.dataUrl;
    img.alt = image.name || 'Selected image';
    const label = document.createElement('span');
    label.textContent = image.name || 'image';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'image-remove';
    remove.title = 'Remove image';
    remove.setAttribute('aria-label', `Remove ${image.name || 'image'}`);
    remove.textContent = '×';
    remove.onclick = () => { pendingImages.splice(index, 1); renderImagePreviews(); };
    item.append(img, label, remove);
    box.appendChild(item);
  }
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    if (!IMAGE_TYPES.has(file.type.toLowerCase())) return reject(new Error('Use PNG, JPEG, WebP, or GIF images.'));
    if (file.size > MAX_IMAGE_BYTES) return reject(new Error(`${file.name} is larger than 10 MB.`));
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name || 'screenshot', mimeType: file.type.toLowerCase(), bytes: file.size, dataUrl: reader.result });
    reader.onerror = () => reject(new Error(`Could not read ${file.name || 'the image'}.`));
    reader.readAsDataURL(file);
  });
}

async function addImageFiles(files) {
  const available = Math.max(0, 4 - pendingImages.length);
  if (!available) { note('You can attach up to 4 images per message.'); return; }
  for (const file of [...files].slice(0, available)) {
    try { pendingImages.push(await fileToImage(file)); }
    catch (err) { note(err.message); }
  }
  renderImagePreviews();
}

function status(text) { $('#composer-status').textContent = text || defaultStatus(); }
function defaultStatus() {
  if (!snap) return '';
  const t = snap.contextTokens ? ` · ~${Math.round(snap.contextTokens / 1000)}k ctx` : '';
  return `${snap.cwd}${t}`;
}
function statusIdle() { $('#composer-status').textContent = defaultStatus(); }

// ============================================================ snapshot rendering

function renderSessions() {
  const list = $('#session-list');
  list.innerHTML = '';
  for (const s of snap.sessions) {
    const el = document.createElement('div');
    el.className = 'session-item' + (snap.session && s.id === snap.session.id ? ' active' : '');
    el.innerHTML = `<div class="s-title"></div><div class="s-meta"></div><button class="s-del" title="Delete session">×</button>`;
    el.querySelector('.s-title').textContent = s.title || '(new)';
    el.querySelector('.s-meta').textContent = `${s.messages} messages`;
    el.addEventListener('click', async (e) => {
      if (e.target.closest('.s-del')) return; // don't load when clicking delete
      snap = await window.vc.loadSession(s.id);
      renderAll();
    });
    el.querySelector('.s-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete session "${s.title || '(untitled)'}"?\nThis cannot be undone.`)) return;
      snap = await window.vc.deleteSession(s.id);
      renderAll();
    });
    list.appendChild(el);
  }
}

function renderHistory() {
  chatEl().innerHTML = '';
  toolCards.clear();
  for (const m of snap.messages) {
    if (m.role === 'user') {
      if (Array.isArray(m.content)) {
        addUserMsg({
          text: m.content.find((p) => p.type === 'text')?.text || '',
          images: m.content.filter((p) => p.type === 'image_url').map((p) => ({ dataUrl: p.image_url?.url, name: 'Attached screenshot' })),
        });
      } else addUserMsg(m.content);
    } else {
      const el = document.createElement('div');
      el.className = 'msg-assistant';
      el.innerHTML = renderMarkdown(m.content);
      chatEl().appendChild(el);
    }
  }
  scrollChat(true);
}

async function refreshReview() {
  const files = await window.vc.sessionChanges();
  const pane = $('#pane-review');
  pane.innerHTML = '';
  if (!files.length) {
    pane.innerHTML = '<div class="rp-empty">No file changes yet</div>';
    return;
  }
  for (const f of files) {
    const el = document.createElement('div');
    el.className = 'rev-file';
    el.innerHTML = `<div class="rf-head"></div><div class="rf-body"></div>`;
    const name = f.file.startsWith(snap.cwd) ? f.file.slice(snap.cwd.length + 1) : f.file;
    el.querySelector('.rf-head').textContent = name;
    el.querySelector('.rf-body').innerHTML = renderDiffHtml(f.before, f.after);
    el.querySelector('.rf-head').addEventListener('click', () => el.classList.toggle('collapsed'));
    pane.appendChild(el);
  }
}

// ============================================================ schedule pane

async function renderSchedule() {
  const pane = $('#pane-schedule');
  const tasks = await window.vc.getSchedule();
  if (!tasks.length) {
    pane.innerHTML = `<button id="sched-add-btn">＋ Add scheduled task</button><div class="rp-empty">No scheduled tasks</div>`;
    const btn = pane.querySelector('#sched-add-btn');
    if (btn) btn.addEventListener('click', openSchedModal);
    return;
  }
  let html = `<button id="sched-add-btn">＋ Add scheduled task</button>`;
  for (const t of tasks) {
    const when = t.cron || `every ${t.interval} min`;
    const lastRun = t.lastRun ? `Last: ${new Date(t.lastRun).toLocaleString()}` : 'Never run';
    const nextRun = t.nextRun && t.enabled ? `Next: ${new Date(t.nextRun).toLocaleString()}` : 'Paused';
    const status = t.enabled ? '' : 'disabled';
    const resultPreview = t.lastResult ? t.lastResult.slice(0, 120) : '';
    html += `<div class="sched-card" data-id="${t.id}">
      <div class="sc-title"><span class="sc-dot ${status}"></span>${t.title}</div>
      <div class="sc-meta">${when} · ${nextRun}</div>
      <div class="sc-last">${lastRun}</div>
      ${resultPreview ? `<div class="sc-prompt" title="${t.lastResult.replace(/"/g, '&quot;')}">${resultPreview}</div>` : `<div class="sc-prompt">${t.prompt.slice(0, 100)}</div>`}
      <div class="sc-actions">
        <button class="sc-toggle-${t.enabled ? 'off' : 'on'}" data-action="toggle">${t.enabled ? 'Pause' : 'Resume'}</button>
        <button class="sc-del" data-action="delete">Delete</button>
      </div>
    </div>`;
  }
  pane.innerHTML = html;

  pane.querySelector('#sched-add-btn').addEventListener('click', openSchedModal);

  pane.querySelectorAll('.sc-actions button').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const card = e.target.closest('.sched-card');
      const id = card.dataset.id;
      if (e.target.dataset.action === 'toggle') {
        const enabled = e.target.textContent === 'Resume';
        await window.vc.toggleSchedule(id, enabled);
        renderSchedule();
      } else if (e.target.dataset.action === 'delete') {
        if (!confirm('Delete this scheduled task?')) return;
        await window.vc.removeScheduleTask(id);
        renderSchedule();
      }
    });
  });
}

function openSchedModal() {
  $('#sched-title').value = '';
  $('#sched-prompt').value = '';
  $('#sched-cron').value = '';
  $('#sched-interval').value = '';
  $('#sched-type').value = 'cron';
  $('#sched-cron-wrap').classList.remove('hidden');
  $('#sched-interval-wrap').classList.add('hidden');
  $('#sched-saved').textContent = '';
  $('#sched-backdrop').classList.remove('hidden');
  $('#sched-title').focus();
}

async function saveSchedTask() {
  const title = $('#sched-title').value.trim();
  const prompt = $('#sched-prompt').value.trim();
  const type = $('#sched-type').value;
  const cron = type === 'cron' ? $('#sched-cron').value.trim() : '';
  const interval = type === 'interval' ? parseInt($('#sched-interval').value, 10) : 0;
  const autonomyLevel = $('#sched-autonomy').value;

  if (!title || !prompt) { $('#sched-saved').textContent = 'Title and prompt required'; return; }
  if (type === 'cron' && !cron) { $('#sched-saved').textContent = 'Cron expression required'; return; }
  if (type === 'interval' && (!interval || interval < 1)) { $('#sched-saved').textContent = 'Valid interval required'; return; }

  try {
    await window.vc.addScheduleTask({ title, prompt, cron, interval, autonomyLevel });
    $('#sched-saved').textContent = '✓ added';
    $('#sched-backdrop').classList.add('hidden');
    renderSchedule();
  } catch (err) {
    $('#sched-saved').textContent = `Error: ${err.message}`;
  }
}

// ============================================================ bug report modal

function openBugReportModal() {
  $('#br-category').value = 'bug';
  $('#br-title').value = '';
  $('#br-description').value = '';
  $('#bugreport-saved').textContent = '';
  const result = $('#bugreport-result');
  result.classList.add('hidden');
  result.className = 'set-note hidden';
  result.innerHTML = '';
  $('#bugreport-send').disabled = false;
  $('#bugreport-backdrop').classList.remove('hidden');
  $('#br-description').focus();
}

function showBugReportResult(ok, html) {
  const result = $('#bugreport-result');
  result.className = `set-note ${ok ? 'ok' : 'err'}`;
  result.innerHTML = html;
}

async function submitBugReportForm() {
  const category = $('#br-category').value;
  const title = $('#br-title').value.trim();
  const description = $('#br-description').value.trim();
  if (!description) { $('#bugreport-saved').textContent = 'Description required'; return; }

  $('#bugreport-send').disabled = true;
  $('#bugreport-saved').textContent = 'Submitting…';
  try {
    const res = await window.vc.submitBugReport({ title, description, category });
    if (res.ok) {
      $('#bugreport-saved').textContent = '';
      showBugReportResult(true, `Filed as <a href="#" id="br-issue-link">issue #${res.number}</a>.`);
      $('#br-issue-link').addEventListener('click', (e) => {
        e.preventDefault();
        window.vc.openBugReportUrl(res.url);
      });
    } else if (res.manualUrl) {
      $('#bugreport-saved').textContent = '';
      showBugReportResult(false, `Couldn't file it automatically — <a href="#" id="br-manual-link">click to file it manually</a> in your browser, or add a GitHub token in Settings to submit directly.`);
      $('#br-manual-link').addEventListener('click', (e) => {
        e.preventDefault();
        window.vc.openBugReportUrl(res.manualUrl);
      });
    } else {
      $('#bugreport-saved').textContent = '';
      showBugReportResult(false, `Failed: ${res.error}`);
    }
  } catch (err) {
    showBugReportResult(false, `Failed: ${err.message}`);
  } finally {
    $('#bugreport-send').disabled = false;
  }
}

// ============================================================ settings modal

function applyTheme(name) {
  uiTheme = THEMES.includes(name) ? name : 'void';
  document.documentElement.setAttribute('data-theme', uiTheme);
  $$('.theme-swatch').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === uiTheme);
    btn.setAttribute('aria-checked', btn.dataset.theme === uiTheme ? 'true' : 'false');
  });
  window.Wallpaper?.retint();
}

function setPacer(thinking) {
  const el = $('#pacer');
  if (!el) return;
  const show = !!(thinking && pacerOn);
  el.classList.toggle('hidden', !show);
  el.classList.toggle('visible', show);
  el.setAttribute('aria-hidden', show ? 'false' : 'true');
}

function applyUi(st) {
  const ui = (st && st.ui) || {};
  applyTheme(ui.theme || 'void');
  pacerOn = ui.pacer !== false;
  if ($('#st-pacer')) $('#st-pacer').checked = pacerOn;
  if (!generating) setPacer(false);
  if (window.Wallpaper && window.Wallpaper.getPack() !== (ui.wallpaper || 'none')) {
    window.Wallpaper.setPack(ui.wallpaper || 'none');
    window.Wallpaper.setActive(currentView === 'desktop');
  }
}

function openSettings() {
  const st = snap.settings;
  applyUi(st);
  $('#settings-path').textContent = `Saved to your user config · keys are stored locally and never shown back`;
  $('#st-model').value = `${st.provider}/${st.model}`;
  $('#st-stt-url').value = st.voice.stt.baseUrl;
  $('#st-tts-backend').value = st.voice.tts.backend;
  $('#st-tts-edge').value = st.voice.tts.edgeVoice;
  $('#st-fish-voice').value = st.voice.tts.fishVoiceId || '';
  $('#st-autospeak').checked = st.voice.autoSpeak;
  $('#st-perm-bash').value = st.permissions.bash;
  $('#st-perm-write').value = st.permissions.write;
  $('#st-perm-webfetch').value = st.permissions.webfetch;
  $('#st-perm-mcp').value = st.permissions.mcp || 'ask';
  $('#st-persona').value = st.persona || '';
  $('#st-memory').value = st.memory || '';
  const wp = st.webPortal || {};
  $('#st-wportal-enabled').checked = !!wp.enabled;
  $('#st-wportal-tunnel').value = wp.tunnel || 'off';
  $('#st-wportal-port').value = wp.port || 8777;
  $('#st-wportal-cfpath').value = wp.cloudflaredPath || '';
  refreshPortalStatus();
  const up = st.updates || {};
  $('#st-updates-autocheck').checked = !!up.autoCheck;
  $('#updates-status').textContent = `Running v${up.currentVersion || '?'}`;
  for (const id of ['st-key-openrouter', 'st-key-openai', 'st-token-github', 'st-token-railway', 'st-token-tavily', 'st-stt-key', 'st-key-fish']) $('#' + id).value = '';
  $('#st-key-openrouter').placeholder = st.providers.openrouter?.hasKey ? '•••••••• (set — blank keeps it)' : 'sk-or-…';
  $('#st-key-openai').placeholder = st.providers.openai?.hasKey ? '•••••••• (set — blank keeps it)' : 'sk-…';
  $('#st-stt-key').placeholder = st.voice.stt.hasKey ? '•••••••• (set — blank keeps it)' : 'gsk_… (free at console.groq.com)';
  $('#st-key-fish').placeholder = st.voice.tts.fishHasKey ? '•••••••• (set — blank keeps it)' : '(optional premium voices)';
  $('#st-token-github').placeholder = st.integrations?.githubHasToken ? '•••••••• (set — blank keeps it)' : 'ghp_… (leave blank to keep)';
  $('#st-token-railway').placeholder = st.integrations?.railwayHasToken ? '•••••••• (set — blank keeps it)' : '(leave blank to keep)';
  $('#st-token-tavily').placeholder = st.integrations?.tavilyHasToken ? '•••••••• (set — blank keeps it)' : 'tvly-… (leave blank to keep)';
  $('#modal-backdrop').classList.remove('hidden');
}

async function saveSettings() {
  const patch = {
    permissions: {
      bash: $('#st-perm-bash').value,
      write: $('#st-perm-write').value,
      edit: $('#st-perm-write').value,
      webfetch: $('#st-perm-webfetch').value,
      mcp: $('#st-perm-mcp').value,
    },
    voice: {
      autoSpeak: $('#st-autospeak').checked,
      stt: { baseUrl: $('#st-stt-url').value.trim() },
      tts: {
        backend: $('#st-tts-backend').value,
        edge: { voice: $('#st-tts-edge').value.trim() },
        fish: { voiceId: $('#st-fish-voice').value.trim() },
      },
    },
    persona: $('#st-persona').value.trim(),
    memory: $('#st-memory').value.trim(),
    ui: {
      theme: uiTheme,
      pacer: $('#st-pacer') ? $('#st-pacer').checked : pacerOn,
    },
    webPortal: {
      enabled: $('#st-wportal-enabled').checked,
      tunnel: $('#st-wportal-tunnel').value,
      port: parseInt($('#st-wportal-port').value, 10) || 8777,
      cloudflaredPath: $('#st-wportal-cfpath').value.trim(),
    },
    updates: {
      autoCheck: $('#st-updates-autocheck').checked,
    },
    providers: {},
    integrations: {},
  };
  const or = $('#st-key-openrouter').value.trim();
  const oa = $('#st-key-openai').value.trim();
  const gq = $('#st-stt-key').value.trim();
  const fk = $('#st-key-fish').value.trim();
  const gh = $('#st-token-github').value.trim();
  const rw = $('#st-token-railway').value.trim();
  const tv = $('#st-token-tavily').value.trim();
  if (or) patch.providers.openrouter = { apiKey: or };
  if (oa) patch.providers.openai = { apiKey: oa };
  if (gq) patch.voice.stt.apiKey = gq;
  if (fk) patch.voice.tts.fish = { ...(patch.voice.tts.fish || {}), apiKey: fk };
  if (gh) patch.integrations.githubToken = gh;
  if (rw) patch.integrations.railwayToken = rw;
  if (tv) patch.integrations.tavilyApiKey = tv;

  snap = await window.vc.saveSettings(patch);

  const modelStr = $('#st-model').value.trim();
  if (modelStr && modelStr !== `${snap.settings.provider}/${snap.settings.model}`) {
    try { snap = await window.vc.setModel(modelStr); } catch { }
  }
  $('#settings-saved').textContent = '✓ saved';
  setTimeout(() => { $('#settings-saved').textContent = ''; }, 1800);
  updateModelName();
  speakEnabled = snap.settings.voice.autoSpeak;
  $('#speak-btn').classList.toggle('on', speakEnabled);
  applyUi(snap.settings);
  statusIdle();
}

// ============================================================ web portal

let portalRunning = false;

function copyText(text) {
  navigator.clipboard?.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  });
}

async function refreshPortalStatus() {
  let st;
  try { st = await window.vc.portalStatus(); } catch { return; }
  portalRunning = !!st.running;
  const el = $('#wportal-status');
  const btn = $('#wportal-toggle');
  const copy = $('#wportal-copy');
  if (!st.running) {
    el.textContent = 'stopped';
    el.className = 'wportal-status';
    btn.textContent = 'Start portal';
    copy.classList.add('hidden');
    return;
  }
  el.className = 'wportal-status running';
  const lines = [`running · http://127.0.0.1:${st.port}`];
  if (st.url) lines.push(`public: ${st.url}`);
  else if (st.tunnel === 'failed') lines.push(`tunnel failed: ${st.tunnelError || 'unknown'}`);
  else if (st.tunnel === 'idle') lines.push('localhost only');
  lines.push(`access token: ${st.token || ''}`);
  el.textContent = lines.join('\n');
  btn.textContent = 'Stop portal';
  copy.classList.remove('hidden');
  $('#st-wportal-enabled').checked = true;
}

document.getElementById('wportal-toggle').addEventListener('click', async () => {
  if (portalRunning) {
    await window.vc.portalStop();
  } else {
    const r = await window.vc.portalStart({
      tunnel: $('#st-wportal-tunnel').value || 'off',
      port: parseInt($('#st-wportal-port').value, 10) || 8777,
      cloudflaredPath: $('#st-wportal-cfpath').value.trim(),
    });
    if (!r.ok) {
      $('#wportal-status').textContent = r.warning || r.error || 'portal failed to start';
      $('#wportal-status').className = 'wportal-status';
      return;
    }
    if (r.warning) {
      $('#wportal-status').textContent = `started (no tunnel) · ${r.warning}`;
      $('#wportal-status').className = 'wportal-status';
    }
  }
  await refreshPortalStatus();
  try { const s2 = await window.vc.init(); if (s2) snap = s2; } catch {}
});

document.getElementById('wportal-copy').addEventListener('click', async () => {
  let st;
  try { st = await window.vc.portalStatus(); } catch { return; }
  if (!st.running) return;
  const lines = [
    '# VoidCode Portal',
    `Local: http://127.0.0.1:${st.port}`,
  ];
  if (st.url) lines.push(`Public: ${st.url}  (keep this private)`);
  lines.push(`Access token: ${st.token}`);
  copyText(lines.join('\n'));
});

// ============================================================ updates

function renderUpdateStatus(status) {
  const el = $('#updates-status');
  const dl = $('#updates-download-btn');
  const inst = $('#updates-install-btn');
  dl.classList.add('hidden');
  inst.classList.add('hidden');
  switch (status.state) {
    case 'checking': el.textContent = 'checking for updates…'; break;
    case 'available': el.textContent = `update available: v${status.version}`; dl.classList.remove('hidden'); break;
    case 'not-available': el.textContent = `up to date · v${snap?.settings?.updates?.currentVersion || '?'}`; break;
    case 'downloading': el.textContent = `downloading update… ${status.percent || 0}%`; break;
    case 'downloaded': el.textContent = `v${status.version} downloaded — restart to install`; inst.classList.remove('hidden'); break;
    case 'error': el.textContent = `update check failed: ${status.message}`; break;
  }
}

document.getElementById('updates-check-btn').addEventListener('click', () => window.vc.checkForUpdates());
document.getElementById('updates-download-btn').addEventListener('click', () => window.vc.downloadUpdate());
document.getElementById('updates-install-btn').addEventListener('click', () => {
  if (confirm('Restart VoidCode to install the update?')) window.vc.installUpdate();
});

// ============================================================ desktop shell

function showView(view) {
  currentView = view;
  $('#app').dataset.view = view;
  window.Wallpaper?.setActive(view === 'desktop');
}

const FOLDER_ICON_SVG = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';
// Distinct glyph for containers (a stack of layers) — visually separates
// "reference collection" icons from plain folder-backed projects at a glance.
const CONTAINER_ICON_SVG = '<svg viewBox="0 0 24 24"><path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 18 9 5 9-5"/></svg>';

// Mirrors DESKTOP_GRID in app/main.js — must stay in sync so a locally
// snapped drag preview lands on the exact cell the main process will save.
const DESKTOP_GRID = { originX: 32, originY: 32, cellW: 104, cellH: 104 };
function snapToGrid(x, y) {
  const col = Math.max(0, Math.round((x - DESKTOP_GRID.originX) / DESKTOP_GRID.cellW));
  const row = Math.max(0, Math.round((y - DESKTOP_GRID.originY) / DESKTOP_GRID.cellH));
  return { x: DESKTOP_GRID.originX + col * DESKTOP_GRID.cellW, y: DESKTOP_GRID.originY + row * DESKTOP_GRID.cellH };
}
// How many columns actually fit the current desktop viewport — arranging
// wraps icons based on the real window size, not a fixed guess.
function desktopGridCols() {
  const host = $('#desktop-view');
  const usable = Math.max(DESKTOP_GRID.cellW, host.clientWidth - DESKTOP_GRID.originX);
  return Math.max(1, Math.floor(usable / DESKTOP_GRID.cellW));
}

function renderDesktop() {
  const host = $('#desktop-icons');
  host.innerHTML = '';
  (snap?.projects || []).forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'desktop-icon';
    el.dataset.id = p.id;
    el.style.left = (p.x ?? (32 + (i % 6) * 104)) + 'px';
    el.style.top = (p.y ?? (32 + Math.floor(i / 6) * 104)) + 'px';
    el.innerHTML = `${FOLDER_ICON_SVG}<span>${escapeHtml(p.name)}</span>`;
    bindDesktopIcon(el, p, 'project');
    host.appendChild(el);
  });
  (snap?.containers || []).forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'desktop-icon desktop-icon-container';
    el.dataset.id = c.id;
    el.style.left = (c.x ?? 32) + 'px';
    el.style.top = (c.y ?? 32) + 'px';
    el.innerHTML = `${CONTAINER_ICON_SVG}<span>${escapeHtml(c.name)}</span><span class="dicon-caption" data-container-caption="${c.id}"></span>`;
    bindDesktopIcon(el, c, 'container');
    host.appendChild(el);
    loadContainerCaption(c.id);
  });
}

async function loadContainerCaption(id) {
  try {
    const status = await window.vc.getContainerStatus(id);
    const el = document.querySelector(`[data-container-caption="${id}"]`);
    if (!el || !status) return;
    const trouble = (status.counts.missing || 0) + (status.counts.error || 0);
    el.textContent = trouble
      ? `${status.counts.total} refs · ${trouble} need attention`
      : `${status.counts.total} ref${status.counts.total === 1 ? '' : 's'}`;
  } catch { /* best-effort caption */ }
}

// Shared drag/snap/open/remove wiring for both project and container icons —
// `kind` picks which IPC bridge calls to use, everything else is identical.
function bindDesktopIcon(el, item, kind = 'project') {
  const bridge = kind === 'container'
    ? { move: window.vc.moveContainer, remove: window.vc.removeContainer, open: window.vc.openContainer }
    : { move: window.vc.moveProject, remove: window.vc.removeProject, open: window.vc.openProject };

  let dragging = false;
  let moved = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;

  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    origLeft = el.offsetLeft;
    origTop = el.offsetTop;
    el.setPointerCapture(e.pointerId);
  });
  // Find the container icon (if any) under the pointer, ignoring this icon
  // itself — used both for the live hover highlight while dragging and to
  // decide the drop outcome on release. Only a project can be dropped onto a
  // container (a container can't contain another container).
  const containerUnderPointer = (e) => {
    if (kind !== 'project') return null;
    const prevPointerEvents = el.style.pointerEvents;
    el.style.pointerEvents = 'none';
    const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('.desktop-icon-container');
    el.style.pointerEvents = prevPointerEvents;
    return hit || null;
  };

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      moved = true;
      el.classList.add('dragging');
      const host = $('#desktop-view');
      const left = Math.max(0, Math.min(host.clientWidth - el.offsetWidth, origLeft + dx));
      const top = Math.max(0, Math.min(host.clientHeight - el.offsetHeight, origTop + dy));
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      $$('.desktop-icon-container.drop-target').forEach((n) => n.classList.remove('drop-target'));
      containerUnderPointer(e)?.classList.add('drop-target');
    }
  });
  el.addEventListener('pointerup', async (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    el.releasePointerCapture(e.pointerId);
    $$('.desktop-icon-container.drop-target').forEach((n) => n.classList.remove('drop-target'));
    if (moved) {
      const dropTarget = containerUnderPointer(e);
      if (dropTarget) {
        // Dropped onto a container: add the whole project folder as
        // references rather than moving the icon there — the project icon
        // snaps back to where it started.
        el.style.left = origLeft + 'px';
        el.style.top = origTop + 'px';
        const containerId = dropTarget.dataset.id;
        try {
          const res = await window.vc.addContainerRefPaths(containerId, [item.path]);
          if (res?.addedCount) loadContainerCaption(containerId);
        } catch { /* best-effort */ }
        return;
      }
      const snapped = snapToGrid(el.offsetLeft, el.offsetTop);
      el.style.left = snapped.x + 'px';
      el.style.top = snapped.y + 'px';
      await bridge.move(item.id, snapped.x, snapped.y);
    }
  });

  el.addEventListener('dblclick', async () => {
    if (moved) return;
    snap = await bridge.open(item.id);
    showView('assistant');
    renderAll();
  });

  el.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const label = kind === 'container'
      ? `Remove container "${item.name}" from the desktop? This only removes VoidCode's index — none of the referenced files are touched.`
      : `Remove "${item.name}" from the desktop?`;
    if (!confirm(label)) return;
    snap = await bridge.remove(item.id);
    renderDesktop();
  });
}

// Windows-style "Arrange icons by" — right-click the empty desktop (not an
// icon) to sort every icon by name or by creation date, re-laid-out on the
// grid. A minimal self-built popup since the app has no menu component.
function closeDesktopMenu() {
  document.querySelector('.desktop-ctx-menu')?.remove();
}

function showDesktopContextMenu(clientX, clientY) {
  closeDesktopMenu();
  const menu = document.createElement('div');
  menu.className = 'desktop-ctx-menu';
  menu.style.left = clientX + 'px';
  menu.style.top = clientY + 'px';
  const currentWallpaper = (snap?.settings?.ui?.wallpaper) || 'none';
  const packs = window.Wallpaper ? window.Wallpaper.listPacks() : [{ id: 'none', name: 'None' }];
  const wallpaperBtns = packs.map((p) => `<button data-wallpaper="${p.id}" class="${p.id === currentWallpaper ? 'active' : ''}">${escapeHtml(p.name)}</button>`).join('');
  menu.innerHTML = `
    <div class="dcm-label">Arrange icons by</div>
    <button data-by="name">Name</button>
    <button data-by="created">Date created</button>
    <div class="dcm-sep"></div>
    <div class="dcm-label">Desktop background</div>
    ${wallpaperBtns}
  `;
  document.body.appendChild(menu);

  menu.querySelectorAll('[data-by]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const by = btn.dataset.by;
      closeDesktopMenu();
      // Sequential, not parallel: both calls read-modify-write the same
      // global config file, so firing them concurrently risks one save
      // clobbering the other's write.
      snap = await window.vc.arrangeProjects(by, desktopGridCols());
      snap = await window.vc.arrangeContainers(by, desktopGridCols());
      renderDesktop();
    });
  });

  menu.querySelectorAll('[data-wallpaper]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.wallpaper;
      closeDesktopMenu();
      window.Wallpaper?.setPack(id);
      window.Wallpaper?.setActive(currentView === 'desktop');
      snap = await window.vc.saveSettings({ ui: { wallpaper: id } });
    });
  });

  // Close on any click elsewhere, or Escape.
  const onDocClick = (e) => { if (!menu.contains(e.target)) { closeDesktopMenu(); cleanup(); } };
  const onKey = (e) => { if (e.key === 'Escape') { closeDesktopMenu(); cleanup(); } };
  const cleanup = () => {
    document.removeEventListener('pointerdown', onDocClick, true);
    document.removeEventListener('keydown', onKey);
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDocClick, true);
    document.addEventListener('keydown', onKey);
  }, 0);
}

function renderAll() {
  if (!snap) return;
  $('#project-name').textContent = snap.cwd;
  speakEnabled = snap.settings.voice.autoSpeak;
  $('#speak-btn').classList.toggle('on', speakEnabled);
  applyUi(snap.settings);
  renderSessions();
  renderHistory();
  statusIdle();
  updateModelName();
  refreshReview();
  renderSchedule();
  renderDesktop();
  renderContainerStrip();
}

// ============================================================ container strip
// Shown inside the chat view only when the currently open session is scoped
// to a container (snap.activeContainer, set by app/main.js's container:open)
// — lets you add/remove references, trigger a reindex, and see cross-file
// relationships without leaving the chat.

function statusPillClass(status) {
  return { indexed: 'ok', missing: 'fail', error: 'fail' }[status] || 'pending';
}

async function renderContainerStrip() {
  const strip = $('#container-strip');
  const container = snap?.activeContainer;
  if (!container) { strip.classList.add('hidden'); return; }
  strip.classList.remove('hidden');
  $('#cs-name').textContent = container.name;
  await refreshContainerRefs(container.id);
}

async function refreshContainerRefs(id) {
  const status = await window.vc.getContainerStatus(id);
  const body = $('#cs-refs');
  const refs = status?.refs || [];
  if (!refs.length) {
    body.innerHTML = '<div class="cs-empty">No references yet — click "Add references" to pick files or folders anywhere on disk.</div>';
    return;
  }
  body.innerHTML = refs.map((r) => `
    <div class="cs-ref-row">
      <span class="cs-ref-pill cs-ref-${statusPillClass(r.status)}">${escapeHtml(r.status)}</span>
      <span class="cs-ref-path" title="${escapeHtml(r.path)}">${escapeHtml(r.path)}</span>
      <button class="cs-ref-remove" data-ref="${r.ref_id}" title="Remove this reference (never deletes the file)">×</button>
    </div>
  `).join('');
  body.querySelectorAll('.cs-ref-remove').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await window.vc.removeContainerRef(id, btn.dataset.ref);
      await refreshContainerRefs(id);
      loadContainerCaption(id);
    });
  });
}

async function refreshContainerRelationships(id) {
  const rels = await window.vc.getContainerRelationships(id);
  const body = $('#cs-relationships');
  if (!rels.length) {
    body.innerHTML = '<div class="cs-empty">No cross-references found yet — add files and reindex.</div>';
    return;
  }
  body.innerHTML = rels.map((r) => `
    <div class="cs-rel-row">
      <span>${escapeHtml(r.fromTitle)}</span>
      <span class="cs-rel-type">${escapeHtml(r.type)}</span>
      <span>${escapeHtml(r.toTitle)}</span>
    </div>
  `).join('');
}

function setupContainerStrip() {
  $('#cs-add-refs').addEventListener('click', async () => {
    const container = snap?.activeContainer;
    if (!container) return;
    await window.vc.addContainerRefs(container.id);
    await refreshContainerRefs(container.id);
  });
  $('#cs-reindex').addEventListener('click', async () => {
    const container = snap?.activeContainer;
    if (!container) return;
    await window.vc.reindexContainer(container.id);
    note('Reindexing started — check the Focus panel for progress.');
  });
  $$('.cs-tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      $$('.cs-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.cstab;
      $('#cs-refs').classList.toggle('hidden', which !== 'refs');
      $('#cs-relationships').classList.toggle('hidden', which !== 'relationships');
      const container = snap?.activeContainer;
      if (container && which === 'relationships') await refreshContainerRelationships(container.id);
    });
  });
}

// ============================================================ wiring

function bind() {
  const input = $('#input');
  $('#image-btn').addEventListener('click', () => $('#image-input').click());
  $('#image-input').addEventListener('change', async (e) => {
    await addImageFiles(e.target.files || []);
    e.target.value = '';
  });
  input.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((item) => item.kind === 'file' && IMAGE_TYPES.has(item.type.toLowerCase()))
      .map((item) => item.getAsFile()).filter(Boolean);
    if (files.length) {
      e.preventDefault();
      await addImageFiles(files);
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const t = input.value;
      input.value = '';
      input.style.height = 'auto';
      sendText(t);
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  });

  $('#send-btn').addEventListener('click', () => {
    const t = input.value; input.value = ''; input.style.height = 'auto'; sendText(t);
  });
  $('#stop-btn').addEventListener('click', () => { window.vc.stop(); voice.stopSpeaking(); });

  $('#mic-btn').addEventListener('click', () => voice.pttToggle());
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); voice.pttToggle(); }
  });

  $('#handsfree-btn').addEventListener('click', async () => {
    const on = await voice.setHandsFree(!voice.handsFree);
    $('#handsfree-btn').classList.toggle('on', on);
  });

  $('#speak-btn').addEventListener('click', async () => {
    speakEnabled = !speakEnabled;
    $('#speak-btn').classList.toggle('on', speakEnabled);
    if (!speakEnabled) voice.stopSpeaking();
    snap = await window.vc.saveSettings({ voice: { autoSpeak: speakEnabled } });
  });

  $('#new-session').addEventListener('click', async () => {
    snap = await window.vc.newSession();
    renderAll();
  });

  $('#project-btn').addEventListener('click', async () => {
    const s = await window.vc.chooseFolder();
    if (s) { snap = s; renderAll(); }
  });

  $('#home-btn').addEventListener('click', () => showView('desktop'));

  $('#desktop-add-btn').addEventListener('click', async () => {
    const s = await window.vc.addProject();
    if (s) { snap = s; renderDesktop(); }
  });

  // window.prompt() is not implemented in Electron's renderer — it returns
  // null immediately with no visible dialog at all, which is why the old
  // prompt()-based version of this button silently did nothing. A real
  // HTML modal, same pattern as the settings/schedule modals.
  $('#desktop-add-container-btn').addEventListener('click', () => {
    $('#cn-input').value = '';
    $('#container-name-backdrop').classList.remove('hidden');
    $('#cn-input').focus();
  });
  const closeContainerNameModal = () => $('#container-name-backdrop').classList.add('hidden');
  const submitContainerName = async () => {
    const name = $('#cn-input').value.trim();
    if (!name) return;
    closeContainerNameModal();
    const s = await window.vc.createContainer(name);
    if (s) { snap = s; renderDesktop(); }
  };
  $('#cn-create').addEventListener('click', submitContainerName);
  $('#cn-cancel').addEventListener('click', closeContainerNameModal);
  $('#cn-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitContainerName();
    if (e.key === 'Escape') closeContainerNameModal();
  });
  $('#container-name-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'container-name-backdrop') closeContainerNameModal();
  });

  setupContainerStrip();

  $('#desktop-view').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.desktop-icon')) return; // icons handle their own (delete)
    e.preventDefault();
    showDesktopContextMenu(e.clientX, e.clientY);
  });

  $$('#right-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#right-tabs button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      $('#pane-review').classList.toggle('hidden', btn.dataset.pane !== 'review');
      $('#pane-todos').classList.toggle('hidden', btn.dataset.pane !== 'todos');
      $('#pane-schedule').classList.toggle('hidden', btn.dataset.pane !== 'schedule');
      $('#pane-focus').classList.toggle('hidden', btn.dataset.pane !== 'focus');
    });
  });

  $('#settings-btn').addEventListener('click', () => { openSettings(); refreshPortalStatus(); });
  $('#settings-save').addEventListener('click', saveSettings);
  $$('.theme-swatch').forEach((btn) => {
    btn.setAttribute('role', 'radio');
    btn.addEventListener('click', () => {
      applyTheme(btn.dataset.theme);
    });
  });
  $('#st-pacer')?.addEventListener('change', () => {
    pacerOn = $('#st-pacer').checked;
    setPacer(generating && pacerOn);
  });
  $('#settings-close').addEventListener('click', () => $('#modal-backdrop').classList.add('hidden'));
  $('#modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') $('#modal-backdrop').classList.add('hidden');
  });
  window.vc.onPortalStatus?.(() => { refreshPortalStatus(); });
  window.vc.onUpdateStatus?.(renderUpdateStatus);

  // schedule modal
  $('#sched-save').addEventListener('click', saveSchedTask);
  $('#sched-cancel').addEventListener('click', () => $('#sched-backdrop').classList.add('hidden'));
  $('#sched-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'sched-backdrop') $('#sched-backdrop').classList.add('hidden');
  });
  $('#sched-type').addEventListener('change', () => {
    const isCron = $('#sched-type').value === 'cron';
    $('#sched-cron-wrap').classList.toggle('hidden', !isCron);
    $('#sched-interval-wrap').classList.toggle('hidden', isCron);
  });

  // bug report modal
  $('#bugreport-btn').addEventListener('click', openBugReportModal);
  $('#bugreport-send').addEventListener('click', submitBugReportForm);
  $('#bugreport-close').addEventListener('click', () => $('#bugreport-backdrop').classList.add('hidden'));
  $('#bugreport-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'bugreport-backdrop') $('#bugreport-backdrop').classList.add('hidden');
  });
}

// ============================================================ focus panel
//
// Two views sharing one container: a flat list of active focus/sub agents,
// and a per-agent detail view (click a card to drill in, click "back" to
// return to the list — like a process tree with one level of children).
// The list-card "N min remaining" used to only update when a narrative log
// event fired (errors, compaction, questions, finish) — normal tool-call
// rounds never touched it, so it read as frozen for the whole run. Every
// tool call and every bit of the model's "thinking" prose is now logged as
// structured activity (see src/focus.js addLog), AND the remaining-time
// display ticks locally off a tracked deadline every second regardless of
// whether any backend event has fired at all.

let focusList = [];
let openFocusDetailId = null;
const focusDetailCache = {}; // id -> full detail payload from focus:detail
const focusDeadlines = new Map(); // id -> deadline (epoch ms), for active sessions only

function formatFocusRemaining(ms) {
  if (ms <= 0) return 'wrapping up…';
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}m ${String(sec).padStart(2, '0')}s remaining` : `${sec}s remaining`;
}

function trackFocusDeadline(s) {
  if (!s || !s.id) return;
  if (s.status === 'working' || s.status === 'waiting') {
    focusDeadlines.set(s.id, Date.now() + (s.remainingMs ?? (s.remainingMin || 0) * 60000));
  } else {
    focusDeadlines.delete(s.id);
  }
}

function tickFocusCountdowns() {
  if (!focusDeadlines.size) return;
  for (const [id, deadline] of focusDeadlines) {
    const text = formatFocusRemaining(deadline - Date.now());
    $$(`.fc-countdown[data-id="${id}"]`).forEach((el) => { el.textContent = text; });
  }
}

function formatFocusEntry(l) {
  const time = l.ts ? new Date(l.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  if (l.kind === 'tool') {
    const argsStr = l.args && Object.keys(l.args).length ? JSON.stringify(l.args) : '';
    return `
      <div class="fc-entry fc-entry-tool${l.ok === false ? ' fc-entry-fail' : ''}">
        <div class="fc-entry-head">
          <span class="fc-entry-time">${time}</span>
          <span class="fc-kind-badge fc-kind-tool">tool</span>
          <span class="fc-entry-tool-name">${escapeHtml(l.tool || '?')}</span>
          ${l.ok === false ? '<span class="fc-entry-badge-fail">failed</span>' : ''}
        </div>
        ${argsStr ? `<div class="fc-entry-args">${escapeHtml(argsStr.slice(0, 300))}</div>` : ''}
        ${l.output ? `<div class="fc-entry-output">${escapeHtml(String(l.output).slice(0, 400))}</div>` : ''}
      </div>`;
  }
  if (l.kind === 'thought') {
    return `
      <div class="fc-entry fc-entry-thought">
        <div class="fc-entry-head"><span class="fc-entry-time">${time}</span><span class="fc-kind-badge fc-kind-thought">thinking</span></div>
        <div class="fc-entry-text">${escapeHtml(l.text || '')}</div>
      </div>`;
  }
  return `
    <div class="fc-entry fc-entry-note">
      <div class="fc-entry-head"><span class="fc-entry-time">${time}</span><span class="fc-kind-badge fc-kind-note">note</span></div>
      <div class="fc-entry-text">${escapeHtml(l.text || '')}</div>
    </div>`;
}

function renderFocusPanel() {
  const container = $('#focus-panel');
  if (!container) return;
  if (openFocusDetailId) renderFocusDetailView(container);
  else renderFocusListView(container);
}

function renderFocusListView(container) {
  focusList.forEach(trackFocusDeadline);
  if (!focusList.length) {
    container.innerHTML = '<div class="fp-empty">No active focus sessions</div>';
    return;
  }
  container.innerHTML = focusList.map(s => `
    <div class="focus-card" data-id="${s.id}">
      <div class="fc-header">
        <span class="fc-id">${s.id}</span>
        <span class="fc-status ${s.status}">${s.status}</span>
      </div>
      <div class="fc-desc">${escapeHtml(s.description || '(no description)')}</div>
      <div class="fc-meta fc-countdown" data-id="${s.id}">${formatFocusRemaining(s.remainingMs)}</div>
      ${s.log && s.log.length ? `<div class="fc-log">${s.log.map(l => `<div class="fc-log-line">${escapeHtml(l.text || l.tool || '')}</div>`).join('')}</div>` : ''}
      ${s.question ? `<div class="fc-question">❓ ${escapeHtml(s.question)}</div>` : ''}
      ${s.finalReport ? `<div class="fc-report">${escapeHtml(s.finalReport)}</div>` : ''}
      ${s.status === 'waiting' ? `
        <div class="fc-answer-form">
          <input type="text" class="fc-answer-input" placeholder="Your answer…" data-id="${s.id}">
          <button class="fc-answer-btn" data-id="${s.id}">Answer</button>
        </div>` : ''}
    </div>
  `).join('');

  $$('.focus-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.fc-answer-form')) return;
      openFocusDetail(card.dataset.id);
    });
  });

  $$('.fc-answer-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const input = document.querySelector(`.fc-answer-input[data-id="${id}"]`);
      const answer = input?.value?.trim();
      if (!answer) return;
      input.value = '';
      await window.vc.focusAnswer(id, answer);
      focusList = (await window.vc.getFocusList()) || [];
      renderFocusPanel();
    });
  });
}

async function openFocusDetail(id) {
  openFocusDetailId = id;
  await refreshFocusDetail(id);
}

function closeFocusDetail() {
  openFocusDetailId = null;
  renderFocusPanel();
}

async function refreshFocusDetail(id) {
  try {
    const detail = await window.vc.getFocusDetail(id);
    if (detail) { focusDetailCache[id] = detail; trackFocusDeadline(detail); }
  } catch { /* best-effort */ }
  if (openFocusDetailId === id) renderFocusPanel();
}

function renderFocusDetailView(container) {
  const d = focusDetailCache[openFocusDetailId];
  if (!d) {
    container.innerHTML = `
      <div class="fc-detail">
        <div class="fc-breadcrumb"><button class="fc-back-btn">← Focus agents</button></div>
        <div class="fp-empty">Loading…</div>
      </div>`;
    $('.fc-back-btn')?.addEventListener('click', closeFocusDetail);
    return;
  }
  const isActive = d.status === 'working' || d.status === 'waiting';
  container.innerHTML = `
    <div class="fc-detail">
      <div class="fc-breadcrumb">
        <button class="fc-back-btn">← Focus agents</button>
        <span class="fc-crumb-sep">/</span>
        <span class="fc-crumb-current">${escapeHtml(d.id)}</span>
      </div>
      <div class="fc-detail-header">
        <span class="fc-status ${d.status}">${d.status}</span>
        <span class="fc-detail-model">${escapeHtml(d.model || 'inherits main model')}</span>
        ${d.role ? `<span class="fc-detail-role">${escapeHtml(d.role)}</span>` : ''}
      </div>
      <div class="fc-desc">${escapeHtml(d.description || '(no description)')}</div>
      ${isActive ? `<div class="fc-meta fc-countdown" data-id="${d.id}">${formatFocusRemaining(d.remainingMs)}</div>` : ''}
      ${d.scratchpad ? `<div class="fc-section-label">Currently thinking</div><div class="fc-scratch">${escapeHtml(d.scratchpad)}</div>` : ''}
      ${d.question ? `
        <div class="fc-question">❓ ${escapeHtml(d.question)}</div>
        <div class="fc-answer-form">
          <input type="text" class="fc-answer-input" placeholder="Your answer…" data-id="${d.id}">
          <button class="fc-answer-btn" data-id="${d.id}">Answer</button>
        </div>` : ''}
      <div class="fc-section-label">Activity (${d.toolCalls || 0} tool call${d.toolCalls === 1 ? '' : 's'})</div>
      <div class="fc-timeline" id="fc-timeline">
        ${d.log && d.log.length ? d.log.map(formatFocusEntry).join('') : '<div class="fp-empty">No activity recorded yet.</div>'}
      </div>
      ${d.finalReport ? `<div class="fc-section-label">Final report</div><div class="fc-report">${escapeHtml(d.finalReport)}</div>` : ''}
      ${isActive ? `<button class="fc-cancel-btn" data-id="${d.id}">Cancel this agent</button>` : ''}
    </div>
  `;

  $('.fc-back-btn')?.addEventListener('click', closeFocusDetail);
  const timeline = $('#fc-timeline');
  if (timeline) timeline.scrollTop = timeline.scrollHeight;

  $$('.fc-answer-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const input = document.querySelector(`.fc-answer-input[data-id="${id}"]`);
      const answer = input?.value?.trim();
      if (!answer) return;
      input.value = '';
      await window.vc.focusAnswer(id, answer);
      await refreshFocusDetail(id);
    });
  });
  $('.fc-cancel-btn')?.addEventListener('click', async (e) => {
    const id = e.currentTarget.dataset.id;
    await window.vc.focusCancel(id);
    await refreshFocusDetail(id);
  });
}

function setupFocusEvents() {
  window.vc.onFocusStart?.(async (session) => {
    focusList = (await window.vc.getFocusList()) || [];
    renderFocusPanel();
  });
  window.vc.onFocusQuestion?.(async ({ session, question }) => {
    focusList = (await window.vc.getFocusList()) || [];
    if (openFocusDetailId === session?.id) await refreshFocusDetail(session.id);
    else renderFocusPanel();
    note(`Focus ${session.id} asks: ${question}`);
  });
  window.vc.onFocusResume?.(async (session) => {
    focusList = (await window.vc.getFocusList()) || [];
    if (openFocusDetailId === session?.id) await refreshFocusDetail(session.id);
    else renderFocusPanel();
  });
  window.vc.onFocusDone?.(async ({ session, status, report }) => {
    focusList = (await window.vc.getFocusList()) || [];
    if (openFocusDetailId === session?.id) await refreshFocusDetail(session.id);
    else renderFocusPanel();
    note(`Focus ${session.id} ${status}: ${report?.slice(0, 200) || '(no report)'}`);
    // A container indexing job just finished — refresh the open strip (if
    // any container is currently open) and its desktop caption so the
    // status pills/counts don't sit stale until the next manual action.
    if (session?.role === 'indexer' && snap?.activeContainer) {
      await refreshContainerRefs(snap.activeContainer.id);
      loadContainerCaption(snap.activeContainer.id);
    }
  });
  window.vc.onFocusLog?.(async ({ session, entry }) => {
    focusList = (await window.vc.getFocusList()) || [];
    const id = session?.id;
    if (openFocusDetailId === id) {
      // Live-append straight into the open timeline — avoids a full
      // re-fetch/re-render (and losing scroll position) on every tool call
      // while the agent is actively working.
      const cached = focusDetailCache[id];
      const timeline = $('#fc-timeline');
      if (cached && timeline) {
        cached.log = [...(cached.log || []), entry].slice(-300);
        if (entry.kind === 'tool') cached.toolCalls = (cached.toolCalls || 0) + 1;
        timeline.insertAdjacentHTML('beforeend', formatFocusEntry(entry));
        timeline.scrollTop = timeline.scrollHeight;
      } else {
        renderFocusPanel();
      }
      return;
    }
    const card = document.querySelector(`.focus-card[data-id="${id || ''}"]`);
    if (card) {
      let log = card.querySelector('.fc-log');
      if (!log) { log = document.createElement('div'); log.className = 'fc-log'; card.appendChild(log); }
      const line = document.createElement('div');
      line.className = 'fc-log-line';
      line.textContent = entry.text || entry.tool || '';
      log.appendChild(line);
      while (log.children.length > 14) log.removeChild(log.firstChild);
    } else {
      renderFocusPanel();
    }
  });
}

// ============================================================ model selector

let modelList = [];
let selectedModelId = null;
let modelFilter = 'all';

async function loadModels() {
  try {
    modelList = (await window.vc.getModelList()) || [];
    renderModelSelector();
  } catch (err) {
    console.error('Failed to load models:', err);
  }
}

function matchesModelFilter(m, filter) {
  switch (filter) {
    case 'claude': return m.provider === 'claude';
    case 'local': return !!m.local;
    case 'or-paid': return m.provider === 'openrouter' && m.costCategory !== 'free';
    case 'or-free': return m.provider === 'openrouter' && m.costCategory === 'free';
    default: return true;
  }
}

function renderModelFilterBar() {
  $$('.model-filter').forEach((btn) => {
    const filter = btn.dataset.filter;
    const count = modelList.filter((m) => matchesModelFilter(m, filter)).length;
    btn.textContent = `${btn.textContent.replace(/\s*\(\d+\)$/, '')} (${count})`;
    btn.classList.toggle('active', filter === modelFilter);
  });
}

function renderModelSelector() {
  const container = $('#model-list');
  if (!container) return;
  renderModelFilterBar();
  const filtered = modelList.filter((m) => matchesModelFilter(m, modelFilter));
  if (!filtered.length) {
    container.innerHTML = `<div class="fp-empty">No models in this filter${modelList.length ? ' — try "All".' : '. The catalog pulls live from OpenRouter and local servers.'}</div>`;
    return;
  }
  container.innerHTML = filtered.map(m => `
    <div class="model-item${m.id === selectedModelId ? ' selected' : ''}" data-id="${m.id}">
      <div class="model-item-info">
        <div class="model-item-id">${m.id}</div>
        <div class="model-item-meta">${m.provider}/${m.modelName} <span class="${(m.costCategory === 'free' || m.local) ? 'free-badge' : 'paid-badge'}">${m.local ? 'local' : m.costCategory}</span></div>
        <div class="model-item-caps">${m.capabilities?.join(', ') || 'general'}${m.capabilities?.includes('vision') ? ' · image analysis' : ''}</div>
      </div>
    </div>
  `).join('');

  $$('.model-item').forEach(item => {
    item.addEventListener('click', async () => {
      const id = item.dataset.id;
      await selectModel(id);
    });
  });
}

async function selectModel(modelId) {
  try {
    const res = await window.vc.setModelId(modelId);
    if (res.ok) {
      selectedModelId = modelId;
      $('#model-name').textContent = `${res.provider.name}/${res.provider.model}`;
      loadModels();
      $('#model-backdrop').classList.add('hidden');
      note(`Model switched to ${res.provider.name}/${res.provider.model}`);
    } else {
      note(`Failed to switch model: ${res.error}`);
    }
  } catch (err) {
    note(`Error switching model: ${err.message}`);
  }
}

function updateModelName() {
  if (snap?.provider) {
    $('#model-name').textContent = `${snap.provider.name}/${snap.provider.model}`;
  }
}

async function renderAgentStructure() {
  const box = $('#agent-structure');
  if (!box) return;
  try {
    const s = await window.vc.getAgentStructure();
    if (!s) { box.classList.add('hidden'); return; }
    const lines = [`<div class="as-title">Agent <span class="dim">(main)</span> → <b>${escapeHtml(s.main || 'none')}</b></div>`];
    const roles = Object.entries(s.roles || {});
    if (roles.length) {
      lines.push('<div class="as-sec">Roles</div>');
      for (const [r, m] of roles) lines.push(`<div class="as-item">${escapeHtml(r)} → <code>${escapeHtml(m)}</code></div>`);
    }
    const agents = Object.entries(s.agents || {});
    if (agents.length) {
      lines.push('<div class="as-sec">Agents</div>');
      for (const [id, a] of agents) lines.push(`<div class="as-item">${escapeHtml(id)} [${escapeHtml(a.role || 'focus')}] → <code>${escapeHtml(a.model || 'inherits main')}</code> <span class="dim">(${a.status || ''})</span></div>`);
    }
    box.innerHTML = lines.join('');
    box.classList.remove('hidden');
  } catch (err) {
    box.classList.add('hidden');
  }
}

function setupModelSelector() {
  $('#model-select-btn').addEventListener('click', () => {
    $('#model-backdrop').classList.remove('hidden');
    loadModels();
    renderAgentStructure();
  });
  $('#model-close').addEventListener('click', () => $('#model-backdrop').classList.add('hidden'));
  $('#model-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'model-backdrop') $('#model-backdrop').classList.add('hidden');
  });
  $$('.model-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      modelFilter = btn.dataset.filter;
      renderModelSelector();
    });
  });
}

// ============================================================ widget bar (dock/undock)

function dockWidget(panelId, iconBtnId) {
  $('#' + panelId)?.classList.add('docked');
  const icon = $('#' + iconBtnId);
  icon?.classList.remove('hidden');
  $('#widget-bar')?.classList.remove('hidden');
}

function undockWidget(panelId, iconBtnId) {
  $('#' + panelId)?.classList.remove('docked');
  $('#' + iconBtnId)?.classList.add('hidden');
  if (!$$('.wb-icon:not(.hidden)').length) $('#widget-bar')?.classList.add('hidden');
}

function setupWidgetBar() {
  $$('.wb-icon').forEach((btn) => {
    btn.addEventListener('click', () => undockWidget(btn.dataset.widget, btn.id));
  });
}

// ============================================================ activity widget

const AW_MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function awLevel(turns, maxTurns) {
  if (!turns) return 0;
  if (maxTurns <= 1) return turns > 0 ? 3 : 0;
  const frac = turns / maxTurns;
  if (frac > 0.75) return 4;
  if (frac > 0.5) return 3;
  if (frac > 0.25) return 2;
  return 1;
}

function renderActivityWidget(summary) {
  if (!summary) return;
  const streakEl = $('#aw-streak');
  const weekEl = $('#aw-week');
  if (streakEl) streakEl.textContent = summary.streak > 0 ? `🔥 ${summary.streak} day${summary.streak === 1 ? '' : 's'}` : 'No streak yet';
  if (weekEl) weekEl.textContent = `${summary.activeThisWeek}/7 this week`;

  const grid = $('#aw-grid');
  const months = $('#aw-months');
  if (!grid || !months) return;
  grid.innerHTML = '';
  months.innerHTML = '';
  const cols = Math.ceil(summary.cells.length / 7);
  grid.style.gridTemplateColumns = `repeat(${cols}, 10px)`;
  let lastMonth = -1;
  for (let col = 0; col < cols; col++) {
    const weekCells = summary.cells.slice(col * 7, col * 7 + 7);
    const firstOfMonth = weekCells.find((c) => Number(c.date.slice(8, 10)) <= 7);
    const label = document.createElement('span');
    label.style.width = '10px';
    if (firstOfMonth) {
      const m = Number(firstOfMonth.date.slice(5, 7)) - 1;
      if (m !== lastMonth) { label.textContent = AW_MONTH_NAMES[m]; lastMonth = m; }
    }
    months.appendChild(label);
    for (const cell of weekCells) {
      const div = document.createElement('div');
      div.className = 'aw-cell';
      div.dataset.level = String(awLevel(cell.turns, summary.maxTurns));
      const [y, m, d] = cell.date.split('-');
      div.title = `${cell.turns} turn${cell.turns === 1 ? '' : 's'} on ${m}/${d}/${y}`;
      grid.appendChild(div);
    }
  }
}

async function refreshActivityWidget() {
  try {
    const summary = await window.vc.getActivitySummary();
    renderActivityWidget(summary);
  } catch { /* best-effort */ }
}

function setupActivityWidget() {
  const panel = $('#activity-widget');
  if (!panel) return;
  $('#aw-summary-btn').addEventListener('click', () => panel.classList.toggle('collapsed'));
  $('#aw-dock').addEventListener('click', (e) => { e.stopPropagation(); dockWidget('activity-widget', 'wb-activity'); });
  refreshActivityWidget();
}

async function boot() {
  snap = await window.vc.init();
  showView('desktop');
  bind();
  setupFocusEvents();
  setupModelSelector();
  focusList = (await window.vc.getFocusList()) || [];
  renderFocusPanel();
  setInterval(tickFocusCountdowns, 1000);
  await loadModels();
  setupActivityWidget();
  setupWidgetBar();
  // Set initial model name
  if (snap?.provider) {
    $('#model-name').textContent = `${snap.provider.name}/${snap.provider.model}`;
    selectedModelId = modelList.find(m => m.provider === snap.provider.name && m.modelName === snap.provider.model)?.id || null;
  }
  renderAll();
}

boot();