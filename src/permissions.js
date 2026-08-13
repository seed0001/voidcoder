// Permission gates with autonomy levels.
//
// autonomyLevel (config):
//   off      — every gated action prompts (current default behavior)
//   research — read-only tools + webfetch + project_memory are auto-allowed;
//              bash/write/edit/mcp still prompt
//   safe     — bash, webfetch, and project_memory are auto-allowed;
//              write/edit auto-allowed ONLY if the file path is NOT inside
//              a protectedPaths glob; otherwise they prompt
//   full     — everything auto-allowed (no prompts)
//
// In all modes, bashAllow patterns skip prompts for matching bash commands.
// Interactive answers: y (once), a (always for this session), n (deny).
//
// Protected paths default: ['**/*'] — meaning "protect everything".
// Set protectedPaths to finer globs in config to narrow what needs approval.

const { c } = require('./ui');
const { globToRegex } = require('./tools/searchTools');

function patternToRegex(pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[\\s\\S]*');
  return new RegExp(`^${esc}$`, 'i');
}

function matchesAnyGlob(filePath, globs) {
  const normalized = filePath.replace(/\\/g, '/');
  for (const g of globs) {
    const re = globToRegex(g);
    if (re.test(normalized) || re.test('/' + normalized)) return true;
  }
  return false;
}

class Permissions {
  constructor(cfg, promptFn) {
    this.cfg = cfg;
    this.promptFn = promptFn; // async (question) => 'y'|'n'|'a'
    this.sessionAllow = new Set(); // tool names allowed for the rest of the session
    this.bashAllowRes = (cfg.bashAllow || []).map(patternToRegex);
  }

  setBashAllow(patterns) {
    this.bashAllowRes = (patterns || []).map(patternToRegex);
  }

  categoryFor(toolName) {
    if (toolName === 'bash') return 'bash';
    if (toolName === 'write') return 'write';
    if (toolName === 'edit') return 'write';
    if (toolName === 'webfetch') return 'webfetch';
    if (toolName.startsWith('mcp_')) return 'mcp';
    return null; // read-only tools: read, ls, glob, grep, todowrite, task, project_memory
  }

  // returns true (run), false (denied)
  async check(toolName, args, { autonomous = false } = {}) {
    const cat = this.categoryFor(toolName);
    if (!cat) return true; // read-only tools always allowed

    const mode = this.cfg.permissions?.[cat] ?? (cat === 'mcp' ? 'ask' : 'ask');
    if (mode === 'deny') return false;
    if (mode === 'allow') return true;

    const level = this.cfg.autonomyLevel || 'off';

    // ---- autonomy: research ----
    if (level === 'research') {
      // Only truly read-only gated tools are auto-allowed at research level.
      // webfetch is auto-allowed (it doesn't modify anything locally).
      if (cat === 'webfetch') return true;
      // Everything else prompts normally.
    }

    // ---- autonomy: safe ----
    if (level === 'safe') {
      // bash, webfetch, and project_memory are auto-allowed
      if (cat === 'bash' || cat === 'webfetch') return true;
      if (cat === 'write') {
        // write/edit allowed ONLY if the file is NOT in protectedPaths
        const filePath = args.filePath || '';
        const protectedGlobs = this.cfg.protectedPaths || ['**/*'];
        if (!matchesAnyGlob(filePath, protectedGlobs)) {
          return true;
        }
        // File is protected — fall through to prompt
      }
    }

    // ---- autonomy: full ----
    if (level === 'full') return true;

    // ---- session allowlist shortcut ----
    if (this.sessionAllow.has(toolName)) return true;

    // ---- bash allow patterns ----
    if (cat === 'bash' && this.bashAllowRes.some((re) => re.test(args.command || ''))) return true;

    // ---- autonomous mode (non-interactive) ----
    if (autonomous) return false;

    // ---- interactive prompt ----
    const detail = cat === 'bash' ? args.command
      : cat === 'write' ? (args.filePath || '')
      : cat === 'webfetch' ? (args.url || '')
      : JSON.stringify(args).slice(0, 200);
    const answer = await this.promptFn(
      `${c.warn('permission')} ${c.bold(toolName)} ${c.muted('→')} ${detail}\n  ${c.muted('[y] once  [a] always this session  [n] deny')} `,
      { toolName, args, detail, category: cat }
    );
    if (answer === 'a') { this.sessionAllow.add(toolName); return true; }
    return answer === 'y';
  }
}

module.exports = { Permissions };