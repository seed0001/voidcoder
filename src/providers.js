// Streaming OpenAI-compatible chat client with tool-call accumulation.
// Works against OpenRouter, OpenAI, Ollama (/v1), llama.cpp server, and any
// other OpenAI-compatible endpoint. provider.type === 'cli' (the Claude Code
// CLI, subscription-authenticated) is dispatched to a subprocess bridge
// instead — see claudeCli.js.

const { streamChatClaudeCli } = require('./claudeCli');

async function streamChat(provider, messages, tools, opts = {}) {
  if (provider.type === 'cli') return streamChatClaudeCli(provider, messages, tools, opts);
  return streamChatHttp(provider, messages, tools, opts);
}

async function streamChatHttp(provider, messages, tools, { onDelta, onReasoningDelta, signal, idleTimeoutMs = 90000 } = {}) {
  const url = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
  if (url.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://github.com/voidcode';
    headers['X-Title'] = 'VoidCode';
  }

  const body = { model: provider.model, messages, stream: true };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (url.includes('openrouter.ai')) body.usage = { include: true };
  if ((provider.name === 'ollama' || provider.name === 'llamacpp') && typeof provider.contextTokens === 'number') {
    body.options = { num_ctx: provider.contextTokens, num_predict: -1 };
  }

  // Idle watchdog: a silently stalled connection (dropped network, provider
  // hiccup) would otherwise block reader.read() forever and freeze the agent
  // loop mid-turn. Abort if no bytes arrive for idleTimeoutMs and surface a
  // normal Error (not AbortError, which callers treat as a user interrupt).
  const ctrl = new AbortController();
  let stalled = false;
  const onCallerAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { stalled = true; ctrl.abort(); }, idleTimeoutMs);
  };

  try {
    armIdle();
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let msg = errText;
      try { msg = JSON.parse(errText).error?.message || errText; } catch { }
      throw new Error(`${provider.name || 'provider'} request failed (HTTP ${res.status}): ${String(msg).slice(0, 600)}`);
    }

    let content = '';
    let reasoning = '';
    let finishReason = null;
    let usage = null;
    const toolCallsByIndex = new Map();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        if (parsed.usage) usage = parsed.usage;
        const choice = parsed.choices && parsed.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        if (delta.reasoning || delta.reasoning_content) {
          const r = delta.reasoning || delta.reasoning_content;
          reasoning += r;
          if (onReasoningDelta) onReasoningDelta(r);
        }
        if (delta.content) {
          content += delta.content;
          if (onDelta) onDelta(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsByIndex.has(idx)) {
              toolCallsByIndex.set(idx, {
                id: tc.id || `call_${Date.now().toString(36)}_${idx}`,
                type: 'function',
                function: { name: '', arguments: '' },
              });
            }
            const acc = toolCallsByIndex.get(idx);
            if (tc.id) acc.id = tc.id;
            if (tc.type) acc.type = tc.type;
            if (tc.function?.name) acc.function.name += tc.function.name;
            if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
            
            // Accumulate other properties (like thought_signature)
            for (const key of Object.keys(tc)) {
              if (key !== 'id' && key !== 'type' && key !== 'function' && key !== 'index') {
                if (typeof tc[key] === 'string') {
                  acc[key] = (acc[key] || '') + tc[key];
                } else {
                  acc[key] = tc[key];
                }
              }
            }
          }
        }
      }
    }

    let toolCalls = [...toolCallsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    if (toolCalls.length === 0 && content && tools && tools.length) {
      const availableTools = tools.map(t => t.function?.name || t.name).filter(Boolean);
      const extracted = extractToolCallsFromText(content, availableTools);
      if (extracted.length > 0) {
        toolCalls = extracted;
      }
    }
    return { content, reasoning, toolCalls, finishReason, usage };
  } catch (err) {
    if (stalled) {
      throw new Error(`${provider.name || 'provider'} stream stalled — no data received for ${Math.round(idleTimeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

function repairTruncatedJson(str) {
  let cleaned = str.trim();
  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{' || char === '[') {
      stack.push(char);
    } else if (char === '}' || char === ']') {
      if (stack.length > 0) {
        const expected = char === '}' ? '{' : '[';
        if (stack[stack.length - 1] === expected) {
          stack.pop();
        }
      }
    }
  }
  if (inString) cleaned += '"';
  while (stack.length > 0) {
    const open = stack.pop();
    cleaned += open === '{' ? '}' : ']';
  }
  return cleaned;
}

function extractToolCallsFromText(text, availableTools) {
  const calls = [];
  const addCall = (name, args) => {
    if (!name || !availableTools.includes(name)) return false;
    calls.push({
      id: `call_text_${Date.now().toString(36)}_${calls.length}`,
      type: 'function',
      function: {
        name,
        arguments: typeof args === 'object' ? JSON.stringify(args) : String(args)
      }
    });
    return true;
  };

  const tryParseJson = (str) => {
    try { return JSON.parse(str); }
    catch {
      try {
        return JSON.parse(repairTruncatedJson(str));
      } catch {
        let cleaned = str.trim()
          .replace(/,\s*([}\]])/g, '$1') // trailing commas
          .replace(/'/g, '"'); // single quotes
        try { return JSON.parse(cleaned); } catch {
          try { return JSON.parse(repairTruncatedJson(cleaned)); } catch { return null; }
        }
      }
    }
  };

  const inferAndAddTool = (obj) => {
    if (obj.prompt && (obj.description !== undefined || obj.minutes !== undefined || obj.role !== undefined)) {
      addCall('focus', obj);
    } else if (obj.filePath && obj.content !== undefined) {
      addCall('write', obj);
    } else if (obj.command) {
      addCall('bash', obj);
    } else if (obj.url) {
      addCall('webfetch', obj);
    }
  };

  // 1) Find markdown code blocks
  const mdJsonRegex = /```json\s*([\s\S]*?)\s*```/g;
  let match;
  while ((match = mdJsonRegex.exec(text)) !== null) {
    const rawJson = match[1].trim();
    const parsed = tryParseJson(rawJson);
    if (parsed && typeof parsed === 'object') {
      const name = parsed.name || parsed.tool || parsed.action;
      const args = parsed.arguments || parsed.parameters || parsed.args;
      if (name && args) {
        addCall(name, args);
      } else if (name) {
        const { name: n, tool: t, action: a, ...rest } = parsed;
        addCall(name, rest);
      } else {
        inferAndAddTool(parsed);
      }
    }
  }

  // Fallback for truncated markdown blocks
  if (calls.length === 0 && text.includes('```json')) {
    const parts = text.split('```json');
    const lastPart = parts[parts.length - 1].trim();
    const parsed = tryParseJson(lastPart);
    if (parsed && typeof parsed === 'object') {
      const name = parsed.name || parsed.tool || parsed.action;
      const args = parsed.arguments || parsed.parameters || parsed.args;
      if (name && args) {
        addCall(name, args);
      } else if (name) {
        const { name: n, tool: t, action: a, ...rest } = parsed;
        addCall(name, rest);
      } else {
        inferAndAddTool(parsed);
      }
    }
  }

  // 2) Find raw JSON objects in text (matching braces or truncated open braces)
  if (calls.length === 0) {
    let start = -1;
    let braceCount = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') {
        if (braceCount === 0) start = i;
        braceCount++;
      } else if (text[i] === '}') {
        if (braceCount > 0) {
          braceCount--;
          if (braceCount === 0 && start !== -1) {
            const rawJson = text.slice(start, i + 1);
            const parsed = tryParseJson(rawJson);
            if (parsed && typeof parsed === 'object') {
              const name = parsed.name || parsed.tool || parsed.action;
              const args = parsed.arguments || parsed.parameters || parsed.args;
              if (name && args) {
                addCall(name, args);
              } else if (name) {
                const { name: n, tool: t, action: a, ...rest } = parsed;
                addCall(name, rest);
              } else {
                inferAndAddTool(parsed);
              }
            }
          }
        }
      }
    }
    if (calls.length === 0 && braceCount > 0 && start !== -1) {
      const rawJson = text.slice(start);
      const parsed = tryParseJson(rawJson);
      if (parsed && typeof parsed === 'object') {
        const name = parsed.name || parsed.tool || parsed.action;
        const args = parsed.arguments || parsed.parameters || parsed.args;
        if (name && args) {
          addCall(name, args);
        } else if (name) {
          const { name: n, tool: t, action: a, ...rest } = parsed;
          addCall(name, rest);
        } else {
          inferAndAddTool(parsed);
        }
      }
    }
  }

  return calls;
}

// Strip literal tool-call-shaped JSON (fenced ```json blocks or raw balanced-
// brace objects carrying a name/tool/action key) out of assistant text before
// it is stored/displayed. Small/local models that can't do native tool
// calling write this JSON as their only way to "call" a tool (see
// extractToolCallsFromText above) — it's a wire-protocol artifact, never
// something the user should see in the chat, whether the call was recognized
// and routed to the worker or was a fully hallucinated tool name that just
// silently failed to match. Leaves surrounding prose untouched.
function stripToolCallText(text) {
  const s = String(text || '');

  const tryParseJson = (str) => {
    try { return JSON.parse(str); }
    catch {
      try { return JSON.parse(repairTruncatedJson(str)); }
      catch {
        const cleaned = str.trim().replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"');
        try { return JSON.parse(cleaned); }
        catch {
          try { return JSON.parse(repairTruncatedJson(cleaned)); }
          catch { return null; }
        }
      }
    }
  };
  const looksLikeCall = (obj) => !!obj && typeof obj === 'object' &&
    typeof (obj.name || obj.tool || obj.action) === 'string';

  let out = s.replace(/```json\s*([\s\S]*?)\s*```/g, (whole, inner) => (
    looksLikeCall(tryParseJson(inner.trim())) ? '' : whole
  ));

  // Raw balanced-brace objects (no fence) — same brace-matching scan as
  // extractToolCallsFromText above, but removing matches instead of
  // collecting them.
  let result = '';
  for (let i = 0; i < out.length;) {
    if (out[i] === '{') {
      let braceCount = 0;
      let j = i;
      for (; j < out.length; j++) {
        if (out[j] === '{') braceCount++;
        else if (out[j] === '}') {
          braceCount--;
          if (braceCount === 0) { j++; break; }
        }
      }
      if (braceCount === 0 && looksLikeCall(tryParseJson(out.slice(i, j)))) {
        i = j;
        continue;
      }
    }
    result += out[i];
    i++;
  }

  return result.replace(/\n{3,}/g, '\n\n').trim();
}

// Non-streaming single completion (titles, compaction summaries).
async function complete(provider, messages, { maxTokens } = {}) {
  const url = provider.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
  const body = { model: provider.model, messages, stream: false };
  if (maxTokens) body.max_tokens = maxTokens;
  if ((provider.name === 'ollama' || provider.name === 'llamacpp') && typeof provider.contextTokens === 'number') {
    body.options = { num_ctx: provider.contextTokens };
    if (maxTokens) body.options.num_predict = maxTokens;
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`completion failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

module.exports = { streamChat, complete, extractToolCallsFromText, stripToolCallText };
