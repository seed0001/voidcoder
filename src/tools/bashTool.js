// Shell execution. Each call runs in a fresh shell (PowerShell on Windows,
// bash elsewhere) but the working directory persists across calls: the wrapper
// emits the final cwd on a sentinel line and we carry it forward.

const { execFile } = require('child_process');
const os = require('os');

const SENTINEL = '::VOIDCODE_CWD::';
const IS_WIN = process.platform === 'win32';

const defs = [
  {
    name: 'bash',
    description: IS_WIN
      ? 'Run a PowerShell command. Working directory persists between calls. Use for git, npm, builds, tests, and anything else. Returns stdout+stderr.'
      : 'Run a bash command. Working directory persists between calls. Returns stdout+stderr.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'number', description: 'milliseconds, default 120000, max 600000' },
        description: { type: 'string', description: 'one line describing what this does' },
      },
      required: ['command'],
    },
  },
];

function makeExecutors(ctx) {
  // ctx.shellCwd holds the persistent working directory
  if (!ctx.shellCwd) ctx.shellCwd = ctx.cwd || process.cwd();

  return {
    // `signal` (the agent's shared turn-abort signal — see agent.js _loop) lets
    // the Stop button kill an in-flight command immediately instead of letting
    // it run to its own timeout (up to 10 minutes) while the UI sits stopped.
    bash({ command, timeout = 120000 }, { signal } = {}) {
      timeout = Math.min(timeout, 600000);
      return new Promise((resolve) => {
        let file, args;
        if (IS_WIN) {
          const wrapped = `${command}\nWrite-Output "${SENTINEL}$((Get-Location).Path)"`;
          file = 'powershell.exe';
          args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', wrapped];
        } else {
          const wrapped = `${command}\necho "${SENTINEL}$(pwd)"`;
          file = 'bash';
          args = ['-c', wrapped];
        }
        let canceled = false;
        const child = execFile(file, args, {
          cwd: ctx.shellCwd,
          timeout,
          maxBuffer: 20 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' },
        }, (err, stdout, stderr) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          let out = stdout || '';
          // pull the cwd sentinel off the output and persist it
          const idx = out.lastIndexOf(SENTINEL);
          if (idx !== -1) {
            const after = out.slice(idx + SENTINEL.length);
            const newCwd = after.split('\n')[0].trim();
            if (newCwd) ctx.shellCwd = newCwd;
            out = out.slice(0, idx);
          }
          let combined = out.trimEnd();
          if (stderr && stderr.trim()) combined += (combined ? '\n' : '') + stderr.trimEnd();
          if (canceled) combined += '\n(canceled by user)';
          else if (err) {
            if (err.killed) combined += `\n(timed out after ${timeout}ms)`;
            else if (err.code && idx === -1) combined += `\n(exit code ${err.code})`;
          }
          if (combined.length > 30000) combined = combined.slice(0, 30000) + `\n…[truncated ${combined.length - 30000} chars]`;
          resolve(combined || '(no output)');
        });
        // A plain child.kill() only signals the immediate process — on Windows
        // that's powershell.exe itself, not whatever it went on to launch
        // (git, npm, node, ...), which would keep running orphaned. taskkill
        // /t kills the whole process tree; elsewhere SIGTERM is enough since
        // execFile's own shell already reaps its children.
        const onAbort = () => {
          canceled = true;
          if (IS_WIN && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => {});
          else child.kill('SIGTERM');
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    },
  };
}

module.exports = { defs, makeExecutors };
