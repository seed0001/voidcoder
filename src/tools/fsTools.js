// File tools: read, write, edit, ls. Write/edit snapshot the previous content
// into the session so /undo can restore it.

const fs = require('fs');
const path = require('path');
const os = require('os');

function expand(p, base) {
  if (!p) throw new Error('path is required');
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  // Relative paths resolve against the active project folder, not process.cwd()
  // (which is wherever the app was launched from, e.g. the install directory).
  return path.resolve(base || process.cwd(), p);
}

const MAX_READ = 250000;

const defs = [
  {
    name: 'read',
    description: 'Read a text file. Returns content with line numbers. Use offset/limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        offset: { type: 'number', description: '1-based line to start from' },
        limit: { type: 'number', description: 'max lines to return (default 2000)' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'write',
    description: 'Write content to a file (creates parent directories, overwrites existing).',
    parameters: {
      type: 'object',
      properties: { filePath: { type: 'string' }, content: { type: 'string' } },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'edit',
    description: 'Edit a file by replacing oldString with newString. oldString must match the file content exactly (including whitespace) and must be unique unless replaceAll=true.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        oldString: { type: 'string' },
        newString: { type: 'string' },
        replaceAll: { type: 'boolean' },
      },
      required: ['filePath', 'oldString', 'newString'],
    },
  },
  {
    name: 'ls',
    description: 'List a directory. Directories end with /.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
  },
];

function makeExecutors(ctx) {
  // ctx: { session, cwd, onFileChange(file, oldText, newText) }
  return {
    read({ filePath, offset = 1, limit = 2000 }) {
      const p = expand(filePath, ctx.cwd);
      const stat = fs.statSync(p);
      if (stat.size > 10 * 1024 * 1024) throw new Error(`File is ${(stat.size / 1e6).toFixed(1)} MB — too large. Use grep or bash to inspect it.`);
      const text = fs.readFileSync(p, 'utf8');
      const lines = text.split('\n');
      const start = Math.max(0, offset - 1);
      const slice = lines.slice(start, start + limit);
      const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(5)}→${l.length > 500 ? l.slice(0, 500) + '…' : l}`).join('\n');
      const out = numbered.slice(0, MAX_READ);
      const suffix = lines.length > start + limit ? `\n… file has ${lines.length} lines total; continue with offset=${start + limit + 1}` : '';
      return out + suffix;
    },

    write({ filePath, content }) {
      const p = expand(filePath, ctx.cwd);
      const old = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
      ctx.onFileChange?.(p, old, content);
      return `Wrote ${content.length} chars to ${p}`;
    },

    edit({ filePath, oldString, newString, replaceAll = false }) {
      const p = expand(filePath, ctx.cwd);
      if (oldString === newString) throw new Error('oldString and newString are identical.');
      const current = fs.readFileSync(p, 'utf8');
      const count = current.split(oldString).length - 1;
      if (count === 0) throw new Error('oldString not found in file. Read the file and match the exact text, including whitespace and indentation.');
      if (count > 1 && !replaceAll) throw new Error(`oldString appears ${count} times. Provide a longer unique snippet or set replaceAll=true.`);
      const next = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString);
      fs.writeFileSync(p, next, 'utf8');
      ctx.onFileChange?.(p, current, next);
      return `Edited ${p} (${replaceAll ? count : 1} replacement${count > 1 && replaceAll ? 's' : ''})`;
    },

    ls({ path: dirPath }) {
      const p = expand(dirPath || ctx.cwd || '.', ctx.cwd);
      const entries = fs.readdirSync(p, { withFileTypes: true })
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return `${p}\n${entries.join('\n') || '(empty)'}`;
    },
  };
}

module.exports = { defs, makeExecutors, expand };
