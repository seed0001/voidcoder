// VoidCode mobile portal — chat + live event stream + focus over SSE.

(() => {
  const $ = (s) => document.querySelector(s);
  const LOGIN = $('#login'), APP = $('#app');

  let es = null;
  let streaming = false;
  let currentBubble = null;

  // ---------------------------------------------------------------- markdown-lite

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function md(s) {
    let out = esc(s);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/^### (.*)$/gm, '<h4>$1</h4>');
    out = out.replace(/^## (.*)$/gm, '<h3>$1</h3>');
    out = out.replace(/^# (.*)$/gm, '<h2>$1</h2>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    out = out.replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>');
    out = out.replace(/\n{2,}/g, '</p><p>');
    out = out.replace(/\n/g, '<br>');
    return out;
  }

  // ---------------------------------------------------------------- bubbles

  function addBubble(role, text, clazz) {
    const chat = $('#chat');
    const el = document.createElement('div');
    el.className = `bubble ${role}${clazz ? ' ' + clazz : ''}`;
    if (text) el.innerHTML = md(text);
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
    return el;
  }
  function appendTo(el, text) {
    el.innerHTML = md(text);
    const chat = $('#chat');
    chat.scrollTop = chat.scrollHeight;
  }
  function addNote(text) {
    const el = document.createElement('div');
    el.className = 'note';
    el.textContent = text;
    $('#chat').appendChild(el);
  }

  // ---------------------------------------------------------------- SSE

  function connectEvents() {
    if (typeof EventSource === 'undefined') return;
    if (es) es.close();
    es = new EventSource('/api/events');
    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleSSE(msg.channel, msg.payload);
    };
    es.onerror = () => {
      // EventSource auto-reconnects; if unauthorized, force re-login
      if (es.readyState === EventSource.CLOSED && !sessionOk()) return;
    };
  }

  function handleSSE(channel, p) {
    switch (channel) {
      case 'agent:turnStart':
        streaming = true;
        currentBubble = addBubble('assistant', '', 'streaming');
        setGenerating(true);
        break;
      case 'agent:delta':
        if (currentBubble) {
          const prev = currentBubble.dataset.acc || '';
          currentBubble.dataset.acc = prev + p;
          appendTo(currentBubble, prev + p);
        }
        break;
      case 'agent:turnEnd':
        streaming = false;
        currentBubble = null;
        setGenerating(false);
        refreshStatus();
        break;
      case 'agent:status':
        if (!streaming && currentBubble) currentBubble = null;
        break;
      case 'agent:todos':
        markTodos(p);
        break;
      case 'agent:toolStart':
        addNote(`⚙ ${p.name||''}`);
        break;
      case 'agent:toolEnd':
        // keep it quiet — tools render enough noise
        break;
      case 'agent:focusStart':
      case 'agent:focusLog':
      case 'agent:focusDone':
      case 'agent:focusQuestion':
        refreshFocus();
        if (channel === 'agent:focusQuestion') addNote(`❓ ${p.question || p?.session?.description || ''}`);
        break;
      case 'perm:ask':
        showPerm(p);
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- status / focus

  async function api(path, opts = {}) {
    const r = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (r.status === 401) { forceLogin('Session expired — reconnect with your access token.'); throw new Error('unauthorized'); }
    return r.json();
  }

  async function refreshStatus() {
    try {
      const s = await api('/api/status');
      const prov = s.provider ? `${s.provider.name}/${s.provider.model}` : '—';
      $('#status-line').textContent = `${s.cwd || ''}${s.generating ? ' ⏳ generating' : ''} · ${prov}`;
    } catch {}
  }

  async function refreshFocus() {
    let list = [];
    try { list = await api('/api/focus'); } catch { return; }
    const panel = $('#focus-panel');
    const btn = $('#focus-btn');
    if (!list.length) {
      panel.classList.add('hidden');
      btn.textContent = 'Focus sessions —';
      return;
    }
    btn.textContent = `Focus sessions (${list.length}) — tap to toggle`;
    btn.onclick = () => panel.classList.toggle('hidden');
    panel.innerHTML = list.map((s) => `
      <div class="fcard ${esc(s.status)}">
        <div class="fhead"><span>${esc(s.id)}</span><span>${esc(s.status)}</span></div>
        <div class="fdesc">${esc(s.description || '')}</div>
        <div class="fmeta">${s.remainingMin || 0}min left${s.mode === 'research' ? ' · research sweep' : ''}</div>
        ${s.log && s.log.length ? `<div class="flog">${s.log.map((l) => esc(l.entry)).join('<br>')}</div>` : ''}
        ${s.question ? `<div class="fq"><b>❓</b> ${esc(s.question)}</div>
          <div class="fans"><input class="fa-in" data-id="${esc(s.id)}" placeholder="Answer…"><button class="fa-btn" data-id="${esc(s.id)}">Answer</button></div>` : ''}
      </div>`).join('');
    panel.querySelectorAll('.fa-btn').forEach((b) => {
      b.onclick = async () => {
        const inp = panel.querySelector(`.fa-in[data-id="${b.dataset.id}"]`);
        const answer = (inp && inp.value.trim()) || '(no response)';
        await api('/api/focus/answer', { method: 'POST', body: { id: b.dataset.id, answer } });
        await refreshFocus();
      };
    });
  }

  // ---------------------------------------------------------------- permissions

  let permId = null;
  function showPerm(meta) {
    permId = meta.id || null;
    $('#perm-title').textContent = `Permission: ${meta.toolName || 'tool'}`;
    $('#perm-detail').textContent = meta.detail || meta.args ? JSON.stringify(meta.args || {}).slice(0, 240) : '';
    $('#perm-wrap').classList.remove('hidden');
  }
  function hidePerm() {
    permId = null;
    $('#perm-wrap').classList.add('hidden');
  }
  $('#perm-wrap').addEventListener('click', async (e) => {
    const a = e.target.closest('button[data-a]');
    if (!a || !permId) return;
    await api('/api/perm', { method: 'POST', body: { id: permId, answer: a.dataset.a } });
    hidePerm();
  });

  // ---------------------------------------------------------------- todos

  function markTodos(items) {
    if (!Array.isArray(items) || !items.length) return;
    const note = items
      .map((t) => `[${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '»' : '·'}] ${t.content}`)
      .join('\n');
    addBubble('assistant', `**Tasks**\n${note}`, 'todos');
  }

  // ---------------------------------------------------------------- streaming state

  function setGenerating(on) {
    $('#stop-btn').classList.toggle('hidden', !on);
    $('#send-btn').disabled = on;
    if (!on) hidePerm();
  }
  $('#stop-btn').addEventListener('click', () => api('/api/stop').catch(() => {}));

  // ---------------------------------------------------------------- chat

  async function send(text) {
    if (streaming) return;
    addBubble('user', text);
    $('#input').value = '';
    try {
      const r = await api('/api/chat', { method: 'POST', body: { text } });
      if (r && r.error) { addBubble('assistant', `⚠ ${r.error}`); return; }
      if (r && r.finalText) {
        if (currentBubble) { appendTo(currentBubble, r.finalText); }
        else addBubble('assistant', r.finalText);
      }
    } catch (err) {
      addBubble('assistant', `⚠ ${err.message}`);
    } finally {
      streaming = false;
      currentBubble = null;
      setGenerating(false);
      await refreshStatus();
    }
  }

  function submit() {
    const v = $('#input').value.trim();
    if (!v || streaming) return;
    send(v).catch(() => {});
  }
  $('#send-btn').addEventListener('click', submit);
  $('#input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  // ---------------------------------------------------------------- auth / boot

  function sessionOk() { return !!localStorage.getItem('vc_session'); }
  function forceLogin(msg) {
    if (!localStorage.getItem('vc_session')) return; // first run — boot shows the gate
    localStorage.removeItem('vc_session');
    if (es) { es.close(); es = null; }
    showLogin(msg || 'Session expired — reconnect with your access token.');
  }

  function showLogin(err) {
    APP.classList.add('hidden');
    LOGIN.classList.remove('hidden');
    if (err) { $('#login-err').textContent = err; $('#login-err').classList.remove('hidden'); }
  }

  async function boot() {
    // try to validate any existing session by checking a lightweight endpoint
    try {
      const s = await api('/api/status');
      APP.classList.remove('hidden');
      LOGIN.classList.add('hidden');
      $('#status-line').textContent = s.cwd || '';
      connectEvents();
      refreshStatus();
      refreshFocus();
      setGenerating(!!s.generating);
      setInterval(() => refreshStatus().catch(() => {}), 15000);
      setInterval(() => refreshFocus().catch(() => {}), 10000);
      return;
    } catch { /* no/invalid session */ }
    showLogin();
  }

  $('#login-btn').addEventListener('click', async () => {
    const token = $('#token-input').value.trim();
    if (!token) return;
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!r.ok) throw new Error('invalid access token');
      const rr = await r.json();
      if (!rr.ok) throw new Error('invalid access token');
      localStorage.setItem('vc_session', '1');
      $('#login-err').classList.add('hidden');
      boot();
    } catch (err) {
      $('#login-err').textContent = String(err.message || err);
      $('#login-err').classList.remove('hidden');
    }
  });
  $('#token-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#login-btn').click();
  });

  boot();
})();