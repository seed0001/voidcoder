// glob + grep. Pure JS, skips node_modules/.git/binaries, capped output.

const fs = require('fs');
const path = require('path');
const { expand } = require('./fsTools');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv']);

function* walk(dir, depth = 0) {
  if (depth > 12) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full, depth + 1);
    else if (e.isFile()) yield full;
  }
}

// Convert a glob pattern to a RegExp. Supports **, *, ?, {a,b}.
function globToRegex(pattern) {
  let re = '';
  let i = 0;
  const p = pattern.replace(/\\/g, '/');
  while (i < p.length) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (p[i] === '/') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') { re += '[^/]'; i++; }
    else if (ch === '{') {
      const end = p.indexOf('}', i);
      if (end === -1) { re += '\\{'; i++; continue; }
      const opts = p.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
      re += `(${opts.join('|')})`;
      i = end + 1;
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

const defs = [
  {
    name: 'glob',
    description: 'Find files matching a glob pattern (e.g. "**/*.js", "src/**/*.test.ts"). Returns paths sorted by modification time (newest first).',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'directory to search (default: project root)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: 'Search file contents with a regular expression. Returns matching lines as file:line:text.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JS regular expression' },
        path: { type: 'string', description: 'directory or file to search (default: project root)' },
        include: { type: 'string', description: 'glob filter for files, e.g. "*.js"' },
        ignoreCase: { type: 'boolean' },
        maxResults: { type: 'number', description: 'default 100' },
      },
      required: ['pattern'],
    },
  },
];

function makeExecutors(ctx) {
  return {
    glob({ pattern, path: dir }) {
      const root = expand(dir || ctx.cwd, ctx.cwd);
      const re = globToRegex(pattern);
      const hits = [];
      for (const f of walk(root)) {
        const rel = path.relative(root, f).replace(/\\/g, '/');
        if (re.test(rel) || re.test('/' + rel)) {
          try { hits.push({ f, mtime: fs.statSync(f).mtimeMs }); } catch { }
          if (hits.length >= 2000) break;
        }
      }
      hits.sort((a, b) => b.mtime - a.mtime);
      const shown = hits.slice(0, 200).map((h) => h.f);
      return shown.length
        ? shown.join('\n') + (hits.length > 200 ? `\n… +${hits.length - 200} more` : '')
        : 'No files matched.';
    },

    grep({ pattern, path: target, include, ignoreCase, maxResults = 100 }) {
      const root = expand(target || ctx.cwd, ctx.cwd);
      const re = new RegExp(pattern, ignoreCase ? 'i' : '');
      const includeRe = include ? globToRegex(include) : null;
      const results = [];
      const files = [];
      try {
        if (fs.statSync(root).isFile()) files.push(root);
        else for (const f of walk(root)) files.push(f);
      } catch (e) { throw new Error(`Cannot access ${root}: ${e.message}`); }

      for (const f of files) {
        if (includeRe && !includeRe.test(path.basename(f))) continue;
        try {
          if (fs.statSync(f).size > 2 * 1024 * 1024) continue;
          const text = fs.readFileSync(f, 'utf8');
          if (text.includes('\u0000')) continue; // binary
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              results.push(`${f}:${i + 1}:${lines[i].trim().slice(0, 250)}`);
              if (results.length >= maxResults) return results.join('\n') + '\n… (maxResults hit)';
            }
          }
        } catch { /* unreadable */ }
      }
      return results.length ? results.join('\n') : 'No matches.';
    },
  };
}

module.exports = { defs, makeExecutors, globToRegex };
