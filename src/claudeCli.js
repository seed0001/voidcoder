// Bridges VoidCode's provider interface to the Claude Code CLI running
// headless, authenticated via the operator's claude.ai subscription (OAuth
// session on disk) instead of an API key. Claude Code executes its own tool
// calls (file edits, bash, etc.) directly against the working directory
// during the call, so this provider always returns toolCalls: [] — not
// because Claude declined to use tools, but because the turn is already
// fully done by the time the subprocess exits.
//
// Multi-account: Claude Code has no built-in profile system, only a single
// /login per CLAUDE_CONFIG_DIR. Each entry in provider.accounts points at a
// separate config dir holding its own OAuth session; switching accounts just
// changes which CLAUDE_CONFIG_DIR the child process sees.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';

function psQuote(arg) {
  return `'${String(arg).replace(/'/g, "''")}'`;
}
function shQuote(arg) {
  return `'${String(arg).replace(/'/g, "'\\''")}'`;
}

function accountEnv(provider) {
  const accountName = provider.activeAccount || 'default';
  const account = (provider.accounts || {})[accountName] || {};
  const env = { ...process.env };
  if (account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function writeTempFile(content) {
  const p = path.join(os.tmpdir(), `voidcode-claude-sysprompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// args must be short (flags, model names, uuids, file paths) — the prompt
// itself is piped over stdin, never placed on the command line, both to
// dodge Windows command-line length limits and because a multi-KB string
// full of quotes/newlines/dashes is exactly what breaks `powershell -Command`
// re-parsing (a stray unescaped quote silently truncates the literal and the
// remainder gets interpreted as script).
function runClaude(args, { env, cwd, signal, timeoutMs, stdin }) {
  return new Promise((resolve, reject) => {
    const opts = { cwd, env, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true, signal };
    const cb = (err, stdout, stderr) => {
      if (err && err.name === 'AbortError') { resolve({ aborted: true, code: null, stdout: stdout || '', stderr: stderr || '' }); return; }
      if (err && err.killed) { resolve({ killed: true, code: null, stdout: stdout || '', stderr: stderr || '' }); return; }
      if (err && typeof err.code !== 'number') { reject(err); return; } // spawn failure (e.g. claude not on PATH)
      resolve({ code: err ? err.code : 0, stdout: stdout || '', stderr: stderr || '' });
    };
    let child;
    if (IS_WIN) {
      const command = ['claude', ...args.map(psQuote)].join(' ');
      child = execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], opts, cb);
    } else {
      const command = ['claude', ...args.map(shQuote)].join(' ');
      child = execFile('bash', ['-c', command], opts, cb);
    }
    child.stdin.end(typeof stdin === 'string' ? stdin : '', 'utf8');
  });
}

// Fold prior user/assistant turns into a plain-text transcript. VoidCode's
// own tool-call/tool-result messages are protocol-specific to its harness
// and are skipped — Claude Code has no use for them since it runs its own
// tools independently.
function foldTranscript(messages) {
  const turns = messages.filter((m) =>
    (m.role === 'user' || m.role === 'assistant') &&
    typeof m.content === 'string' && m.content.trim());
  if (!turns.length) return '';
  if (turns.length === 1) return turns[0].content;
  const history = turns.slice(0, -1)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
  const latest = turns[turns.length - 1].content;
  return `[Earlier conversation in this session]\n${history}\n\n[Current request]\n${latest}`;
}

async function invokeClaude(provider, prompt, { resumeId, signal, timeoutMs, systemAppend, cwd } = {}) {
  const model = provider.model || 'sonnet';
  const permissionMode = provider.permissionMode || 'acceptEdits';
  const args = ['-p', '--model', model, '--output-format', 'json', '--permission-mode', permissionMode];
  let sysFile = null;
  if (systemAppend) {
    sysFile = writeTempFile(systemAppend);
    args.push('--append-system-prompt-file', sysFile);
  }
  if (resumeId) args.push('--resume', resumeId);

  try {
    const { code, stdout, stderr, killed, aborted } = await runClaude(args, {
      env: accountEnv(provider),
      cwd: provider.cwd || cwd || process.cwd(),
      signal,
      timeoutMs: timeoutMs || 600000,
      stdin: prompt,
    });

    if (aborted) { const e = new Error('claude CLI aborted'); e.name = 'AbortError'; throw e; }
    if (killed) throw new Error(`claude CLI timed out after ${Math.round((timeoutMs || 600000) / 1000)}s`);
    if (code !== 0) throw new Error(`claude CLI exited ${code}: ${(stderr || stdout).slice(0, 600)}`);

    let parsed;
    try { parsed = JSON.parse(stdout); }
    catch { throw new Error(`claude CLI returned non-JSON output: ${stdout.slice(0, 300)}`); }
    if (parsed.is_error) throw new Error(`claude CLI error: ${String(parsed.result || stdout).slice(0, 600)}`);
    return parsed;
  } finally {
    if (sysFile) { try { fs.unlinkSync(sysFile); } catch {} }
  }
}

async function streamChatClaudeCli(provider, messages, tools, { signal, idleTimeoutMs, onDelta } = {}) {
  const systemMsg = messages.find((m) => m.role === 'system');
  const resumeId = provider._claudeSessionId;

  let parsed = null;
  if (resumeId) {
    const latest = [...messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');
    try {
      parsed = await invokeClaude(provider, latest?.content || '', {
        resumeId, signal, timeoutMs: idleTimeoutMs, systemAppend: systemMsg?.content,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // Stale/foreign session id — e.g. after a VoidCode /resume in a fresh
      // process, or the Claude-side session expired. Fall back to a fresh
      // Claude session seeded with the full folded transcript.
      provider._claudeSessionId = null;
    }
  }
  if (!parsed) {
    const prompt = foldTranscript(messages);
    parsed = await invokeClaude(provider, prompt, { signal, timeoutMs: idleTimeoutMs, systemAppend: systemMsg?.content });
  }

  if (parsed.session_id) provider._claudeSessionId = parsed.session_id;

  // Claude Code CLI's --output-format json returns the whole answer at once
  // (no token-level deltas), so the caller's renderer — which normally
  // accumulates via onDelta as chunks stream in — gets it as a single chunk
  // here instead of a live stream.
  if (onDelta && parsed.result) onDelta(parsed.result);

  const usage = parsed.usage || {};
  return {
    content: parsed.result || '',
    reasoning: '',
    toolCalls: [], // Claude Code already ran its own tools against the filesystem this turn.
    finishReason: 'stop',
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_cost: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined,
    },
  };
}

function listAccounts(provider) {
  return Object.entries(provider.accounts || {}).map(([name, a]) => ({ name, ...a }));
}

module.exports = { streamChatClaudeCli, listAccounts };
