// Session persistence. Sessions live in ~/.voidcode/projects/<project-slug>/
// as JSON files: full message history, title, file-change backups for /undo.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function mergeUsage(usg) {
  if (!usg || typeof usg !== 'object') return { input: 0, output: 0, turns: 0, cost: 0, activeTimeMs: 0 };
  return {
    input: usg.input || 0,
    output: usg.output || 0,
    turns: usg.turns || 0,
    cost: usg.cost || 0,
    activeTimeMs: usg.activeTimeMs || 0,
  };
}

function projectDir(cwd = process.cwd()) {
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(-60);
  const hash = crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 8);
  const dir = path.join(os.homedir(), '.voidcode', 'projects', `${slug}-${hash}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function newSessionId() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + crypto.randomBytes(3).toString('hex');
}

class Session {
  constructor(cwd, id = null) {
    this.dir = projectDir(cwd);
    this.id = id || newSessionId();
    this.file = path.join(this.dir, `${this.id}.json`);
    this.title = '';
    this.messages = [];
    this.scratchpad = '';
    this.fileBackups = []; // [{file, before, after, ts}] for /undo (before=null means file was created)
    this.usage = { input: 0, output: 0, turns: 0, cost: 0, activeTimeMs: 0 };
    this.contextTraces = [];
    this.createdAt = new Date().toISOString();
  }

  static load(cwd, id) {
    const s = new Session(cwd, id);
    if (!fs.existsSync(s.file)) throw new Error(`No session ${id} in this project.`);
    const data = JSON.parse(fs.readFileSync(s.file, 'utf8'));
    const sanitizedMessages = (data.messages || []).filter(m => {
      if (m.role === 'assistant') {
        const hasContent = typeof m.content === 'string' && m.content.trim().length > 0;
        const hasTools = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
        return hasContent || hasTools;
      }
      return true;
    });
    Object.assign(s, {
      title: data.title || '',
      messages: sanitizedMessages,
      scratchpad: data.scratchpad || '',
      fileBackups: data.fileBackups || [],
      usage: mergeUsage(data.usage),
      contextTraces: Array.isArray(data.contextTraces) ? data.contextTraces : [],
      createdAt: data.createdAt || s.createdAt,
    });
    return s;
  }

  static latest(cwd) {
    const all = Session.list(cwd);
    if (!all.length) return null;
    return Session.load(cwd, all[0].id);
  }

  static delete(cwd, id) {
    const file = path.join(projectDir(cwd), `${id}.json`);
    if (!fs.existsSync(file)) throw new Error(`No session ${id} in this project.`);
    fs.unlinkSync(file);
  }

  static list(cwd) {
    const dir = projectDir(cwd);
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json') && f !== 'cost.json')
      .map((f) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          return {
            id: f.replace(/\.json$/, ''),
            title: data.title || '(untitled)',
            updatedAt: data.updatedAt || data.createdAt,
            messages: (data.messages || []).length,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  save() {
    const data = {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      usage: this.usage,
      contextTraces: this.contextTraces.slice(-100),
      messages: this.messages,
      scratchpad: this.scratchpad,
      fileBackups: this.fileBackups.slice(-50), // cap undo history
    };
    fs.writeFileSync(this.file, JSON.stringify(data), 'utf8');
  }

  recordFileChange(file, before, after) {
    this.fileBackups.push({ file, before, after, ts: new Date().toISOString() });
  }

  // Undo the most recent file change; returns a description or null.
  undoLast() {
    const change = this.fileBackups.pop();
    if (!change) return null;
    if (change.before === null) {
      try { fs.unlinkSync(change.file); } catch { }
      this.save();
      return `Removed ${change.file} (was created by the last change)`;
    }
    fs.writeFileSync(change.file, change.before, 'utf8');
    this.save();
    return `Restored ${change.file} to its previous content`;
  }
}

module.exports = { Session, projectDir };
