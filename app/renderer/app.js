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

// ============================================================ settings modal

function applyTheme(name) {
  uiTheme = THEMES.includes(name) ? name : 'void';
  document.documentElement.setAttribute('data-theme', uiTheme);
  $$('.theme-swatch').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === uiTheme);
    btn.setAttribute('aria-checked', btn.dataset.theme === uiTheme ? 'true' : 'false');
  });
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
}

const FOLDER_ICON_SVG = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';

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
    bindDesktopIcon(el, p);
    host.appendChild(el);
  });
}

function bindDesktopIcon(el, project) {
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
    }
  });
  el.addEventListener('pointerup', async (e) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    el.releasePointerCapture(e.pointerId);
    if (moved) {
      await window.vc.moveProject(project.id, el.offsetLeft, el.offsetTop);
    }
  });

  el.addEventListener('dblclick', async () => {
    if (moved) return;
    snap = await window.vc.openProject(project.id);
    showView('assistant');
    renderAll();
  });

  el.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    if (!confirm(`Remove "${project.name}" from the desktop?`)) return;
    snap = await window.vc.removeProject(project.id);
    renderDesktop();
  });
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

async function loadModels() {
  try {
    modelList = (await window.vc.getModelList()) || [];
    renderModelSelector();
  } catch (err) {
    console.error('Failed to load models:', err);
  }
}

function renderModelSelector() {
  const container = $('#model-list');
  if (!container) return;
  if (!modelList.length) {
    container.innerHTML = '<div class="fp-empty">No models available. The catalog pulls live from OpenRouter and local servers.</div>';
    return;
  }
  container.innerHTML = modelList.map(m => `
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
}

// ============================================================ corner media player
// A bottom-right media player that imports a local music folder, plays a
// shuffled playlist, and drives a frequency-reactive ambient visualizer from
// the live audio spectrum. Media logic lives in mediaPlayer.js + visualizer.js.
let mp = null;            // MediaPlayer instance
let mpViz = null;         // visualizer instance
let mpCollapsed = false;
let mpEl, mpTitleEl, mpFolderEl, mpMetaEl, mpFillEl;
let mpDrag = false;

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function baseName(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1];
}

function renderMp(state) {
  if (!mpTitleEl) return;
  const cur = state.current;
  mpTitleEl.textContent = cur ? baseName(cur) : '—';
  mpFolderEl.textContent = state.name ? (state.folder || state.name) : 'No music folder';
  const meta = [];
  if (state.total) meta.push(`${state.index + 1}/${state.total}`);
  if (state.playing) meta.push('●');
  else if (cur) meta.push('Ⅱ');
  mpMetaEl.textContent = meta.join('  ');
  // progress bar
  if (state.duration > 0) {
    const pct = Math.min(100, (state.position / state.duration) * 100);
    mpFillEl.style.width = pct + '%';
  } else {
    mpFillEl.style.width = '0%';
  }
  $('#mp-shuffle').classList.toggle('on', state.shuffle);
  $('#mp-repeat').classList.toggle('on', state.repeat);
  // play/pause icon
  const ic = $('#mp-toggle svg');
  if (ic) ic.innerHTML = state.playing ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
}

async function importMediaFolder() {
  const res = await window.vc.chooseMediaFolder();
  if (!res) return;
  const { folder, files } = res;
  if (!files || !files.length) {
    mpTitleEl.textContent = 'No audio found';
    mpFolderEl.textContent = folder;
    return;
  }
  const name = (String(folder).split(/[\\/]/).pop()) || folder;
  mp.setFolder(name, files);
  renderMp(mp.getState());
  mpTitleEl.textContent = baseName(files[0]) || 'Ready';
}

function setupMediaPlayer() {
  const panel = $('#media-player');
  if (!panel) return;
  mpEl = panel;
  mpTitleEl = $('#mp-title');
  mpFolderEl = $('#mp-folder');
  mpMetaEl = $('#mp-meta');
  mpFillEl = $('#mp-fill');
  const vizu = $('#vizu');

  // create player + visualizer
  mp = window.MediaPlayer.createMediaPlayer({
    onState: (s) => renderMp(s),
    onTrack: () => {},
  });
  mpViz = window.createVisualizer(vizu, () => mp.getFrequencyData());
  mpViz.start();

  // controls
  $('#mp-open').addEventListener('click', importMediaFolder);
  $('#mp-toggle').addEventListener('click', () => mp.toggle());
  $('#mp-next').addEventListener('click', () => mp.next());
  $('#mp-prev').addEventListener('click', () => mp.prev());
  $('#mp-shuffle').addEventListener('click', () => { mp.setShuffle(!mp.getState().shuffle); renderMp(mp.getState()); });
  $('#mp-repeat').addEventListener('click', () => { mp.setRepeat(!mp.getState().repeat); renderMp(mp.getState()); });
  $('#mp-volume').addEventListener('input', (e) => { mp.setVolume(parseFloat(e.target.value)); });
  $('#mp-collapse').addEventListener('click', () => {
    mpCollapsed = !mpCollapsed;
    panel.classList.toggle('collapsed', mpCollapsed);
    setTimeout(() => mpViz && mpViz.resize(), 30);
  });

  // progress bar scrubbing
  const mkBar = (e) => {
    const r = panel.querySelector('.mp-bar').getBoundingClientRect();
    const pct = (e.clientX - r.left) / r.width;
    const d = mp.getState().duration;
    if (d > 0) mp.seek(pct * d);
  };
  let scrubbing = false;
  panel.querySelector('.mp-bar').addEventListener('pointerdown', (e) => { scrubbing = true; mkBar(e); });
  window.addEventListener('pointermove', (e) => { if (scrubbing) mkBar(e); });
  window.addEventListener('pointerup', () => { scrubbing = false; });

  // drag to move the panel
  const handle = panel;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || e.target.closest('input') || e.target.closest('canvas') || e.target.closest('.mp-bar')) return;
    mpDrag = true;
  });
  window.addEventListener('pointermove', (e) => {
    if (!mpDrag) return;
    const rect = panel.getBoundingClientRect();
    const c = document.querySelector('.mp-collapse');
    const cRect = c.getBoundingClientRect();
    let x = e.clientX - rect.width / 2;
    let y = e.clientY - cRect.height / 2;
    x = Math.max(10, Math.min(window.innerWidth - rect.width - 10, x));
    y = Math.max(10, Math.min(window.innerHeight - rect.height - 10, y));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  });
  window.addEventListener('pointerup', () => { mpDrag = false; });

  window.addEventListener('resize', () => { if (mpViz) mpViz.resize(); });
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
  setupMediaPlayer();
  // Set initial model name
  if (snap?.provider) {
    $('#model-name').textContent = `${snap.provider.name}/${snap.provider.model}`;
    selectedModelId = modelList.find(m => m.provider === snap.provider.name && m.modelName === snap.provider.model)?.id || null;
  }
  renderAll();
}

boot();