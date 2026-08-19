// VoidCode terminal interface: REPL, slash commands, streaming render,
// permission prompts, and non-interactive (-p) mode.

const readline = require('readline');
const fs = require('fs');
const path = require('path');

const config = require('./config');
const { Agent, estTokens } = require('./agent');
const { Session } = require('./sessions');
const { Permissions } = require('./permissions');
const mcp = require('./mcp');
const { Scheduler } = require('./scheduler');
const schedule = require('./schedule');
const costTracker = require('./costTracker');
const ui = require('./ui');
const { c } = ui;

const HELP = `
${c.bold('Slash commands')}
  /help                 this help
  /settings             interactive settings (API keys, provider, model, permissions)
  /new                  start a new session
  /sessions             list sessions in this project
  /resume <id>          resume a session
  /delete <id>          permanently delete a session and its data
  /model [id]           show or set model (e.g. /model openrouter/anthropic/claude-sonnet-4.5)
  /models [query]       list models from the live catalog (filter optional)
  /models set <id>      switch to a model from the catalog
  /claude-account [name]  list/switch Claude subscription accounts (add: /claude-account add <name> <dir>)
  /compact              summarize old context to free the window
  /undo                 revert the most recent file change
  /diff                 show files changed this session
  /tools                list available tools (incl. MCP)
  /mcp                  MCP server status
  /init                 analyze the project and write AGENTS.md
  /usage                token usage for this session
  /context [status|list] inspect the SQL-backed execution context database
  /scheduler            show scheduled task status
  /research <min> <topic>  timed autonomous research sweep; search trail streams live
  /focus [list|answer|cancel]  manage background focus sessions
  /clear                clear the screen
  /exit                 quit (also Ctrl+D)

${c.bold('Keys')}   Ctrl+C interrupts a running response; twice at an empty prompt exits.
${c.bold('Config')} ~/.voidcode/config.json (global) and .voidcode.json (project) — permissions, providers, bashAllow, mcpServers.
${c.bold('Schedule')} The agent manages a calendar via the schedule tool. Tasks run autonomously in the background. Use /scheduler to check the engine status.
${c.bold('Focus')}    Background subagents with time budgets. Spawn with focus tool (task mode finishes when done; research mode sweeps sources until the budget is gone). focus role=... uses role-assigned models. Use /research <min> <topic> for a timed sweep, /focus list/answer/cancel to manage, and /focus answer <id> <answer> to answer a question.
${c.bold('Models')}    Live catalog (OpenRouter + local) — agent-side tools list_models, set_model, assign_model, agent_structure configure everything. Use /models [query] to list, /models set <id> to switch the main agent.
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--print') args.print = argv[++i];
    else if (a === '-c' || a === '--continue') args.continue = true;
    else if (a === '--resume') args.resume = argv[++i];
    else if (a === '--model' || a === '-m') args.model = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '-v' || a === '--version') args.version = true;
    else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    console.log(require('../package.json').version);
    return;
  }
  if (args.help) {
    console.log(`voidcode [options] \n\n  -p, --print <prompt>   run one prompt non-interactively, print result, exit\n  -c, --continue         resume the most recent session\n  --resume <id>          resume a specific session\n  -m, --model <model>    override model (provider/model syntax supported)\n${HELP}`);
    return;
  }

  const cwd = process.cwd();
  let cfg = config.load(cwd);
  let provider;
  try {
    provider = config.resolveProvider(cfg, args.model);
  } catch (err) {
    console.error(c.err(err.message));
    process.exit(1);
  }

  // ---- session ----
  let session;
  try {
    if (args.resume) session = Session.load(cwd, args.resume);
    else if (args.continue) session = Session.latest(cwd) || new Session(cwd);
    else session = new Session(cwd);
  } catch (err) {
    console.error(c.err(err.message));
    process.exit(1);
  }

  // ---- MCP ----
  const { servers: mcpServers, errors: mcpErrors } = await mcp.startServers(cfg.mcpServers);

  // ---- interactive vs print mode ----
  const interactive = !args.print;
  const spinner = new ui.Spinner('thinking');
  let rl = null;
  let generating = false;

  const promptPermission = async (question) => {
    spinner.stop();
    process.stdout.write('\n');
    if (!interactive) return 'n';
    return new Promise((resolve) => {
      rl.question(question, (ans) => resolve((ans || 'n').trim().toLowerCase()[0] || 'n'));
    });
  };

  const permissions = new Permissions(cfg, promptPermission);

  // ---- render events ----
  const md = new ui.MdStream();
  let streamedThisTurn = false;
  let reasoningStreamedThisTurn = false;

  const events = {
    onReasoningDelta: (t) => {
      if (!reasoningStreamedThisTurn) {
        spinner.stop();
        process.stdout.write(`\n${c.muted('◇ thinking…')}\n`);
        reasoningStreamedThisTurn = true;
      }
      process.stdout.write(c.muted(t));
    },
    onDelta: (t) => {
      if (reasoningStreamedThisTurn && !streamedThisTurn) process.stdout.write('\n\n');
      if (!streamedThisTurn) { spinner.stop(); process.stdout.write('\n'); streamedThisTurn = true; }
      md.push(t);
    },
    onToolStart: (name, toolArgs) => {
      md.flush();
      spinner.stop();
      const detail = toolArgs.command || toolArgs.filePath || toolArgs.pattern || toolArgs.url || toolArgs.path
        || toolArgs.description || '';
      process.stdout.write(`\n${ui.toolHeader(name, detail)}\n`);
      spinner.start(`running ${name}`);
    },
    onToolEnd: (name, toolArgs, ok, output) => {
      spinner.stop();
      if (!ok) process.stdout.write(c.err(`  ✗ ${output.split('\n')[0].slice(0, 200)}`) + '\n');
      else if (name !== 'edit' && name !== 'write' && name !== 'todowrite') {
        process.stdout.write(ui.toolResultPreview(output) + '\n');
      }
      spinner.start('thinking');
    },
    onFileChange: (file, before, after) => {
      spinner.stop();
      const rel = path.relative(cwd, file) || file;
      if (before === null) {
        process.stdout.write(c.ok(`  + created ${rel} (${after.length} chars)`) + '\n');
      } else {
        process.stdout.write(ui.diffLines(before, after).map((l) => '  ' + l).join('\n') + '\n');
      }
    },
    onTodos: (todos) => {
      spinner.stop();
      const lines = todos.map((t) => {
        const mark = t.status === 'completed' ? c.ok('✓') : t.status === 'in_progress' ? c.warn('▸') : c.muted('○');
        const text = t.status === 'completed' ? c.muted(t.content) : t.content;
        return `  ${mark} ${text}`;
      });
      process.stdout.write(lines.join('\n') + '\n');
    },
    onStatus: (s) => spinner.update(s),
    onContextTrace: (trace) => {
      const status = trace.status === 'unavailable' ? 'unavailable' : trace.status === 'incomplete_mandatory' ? 'incomplete mandatory context' : `context: ${trace.recordsInjected?.length || 0} record(s)`;
      process.stdout.write(c.muted(`[${status}]\n`));
    },
    onSubagentStart: (desc) => {
      spinner.stop();
      process.stdout.write(`\n${c.accent('◆')} ${c.bold('subagent')}${c.muted(`: ${desc}`)}\n`);
      spinner.start(`subagent: ${desc}`);
    },
    onSubagentEnd: (desc, result) => {
      spinner.stop();
      process.stdout.write(ui.toolResultPreview(result, 3) + '\n');
      spinner.start('thinking');
    },
    onFocusStart: (session) => {
      spinner.stop();
      process.stdout.write(`\n${c.accent('⧉')} ${c.bold('focus')} ${c.muted(`(${session.id}): ${session.description}`)}\n`);
    },
    onFocusQuestion: (session, question) => {
      spinner.stop();
      process.stdout.write(`\n${c.warn('❓')} ${c.bold(`focus ${session.id}`)} asks: ${question}\n`);
      process.stdout.write(c.muted(`  → Use /focus answer ${session.id} "your answer" or focus_answer tool\n`));
    },
    onFocusDone: (session, status, report) => {
      spinner.stop();
      const icon = status === 'done' ? c.ok('✓') : status === 'timeout' ? c.warn('⏱') : c.err('✗');
      process.stdout.write(`\n${icon} ${c.bold(`focus ${session.id}`)} ${status}: ${report?.slice(0, 200) || '(no report)'}\n`);
    },
    onFocusLog: (session, entry) => {
      spinner.stop();
      process.stdout.write(`${c.accent('⧉')} ${c.muted(`[${session.id}]`)} ${entry}\n`);
    },
  };

  const agent = new Agent({ cfg, provider, session, permissions, mcpServers, events });

  // ---- scheduler (background task runner) ----
  let scheduler = null;
  const scheduledTasks = schedule.listTasks().filter((t) => t.enabled);
  if (scheduledTasks.length > 0) {
    scheduler = new Scheduler({
      runTask: async (task) => {
        // Run the scheduled task through the agent with the task's autonomy level
        const prevLevel = cfg.autonomyLevel;
        cfg.autonomyLevel = task.autonomyLevel || 'safe';
        try {
          spinner.stop();
          process.stdout.write(`\n${c.accent('⏰')} ${c.bold('scheduled task')}${c.muted(`: ${task.title}`)}\n`);
          const result = await agent.send(task.prompt, { autonomous: true, organismTask: `scheduled: ${task.title}` });
          process.stdout.write(c.muted(`  ✓ task "${task.title}" completed\n`));
          return result || '(no output)';
        } catch (err) {
          return `ERROR: ${err.message}`;
        } finally {
          cfg.autonomyLevel = prevLevel;
        }
      },
      onComplete: (task, result) => {
        const isError = result && result.startsWith && result.startsWith('ERROR');
        if (isError) {
          process.stdout.write(`\n${c.err('⚠')} ${c.bold('scheduled task failed')}${c.muted(`: ${task.title}`)}\n`);
        }
      },
    });
    scheduler.start();
    process.stdout.write(c.muted(`scheduler: ${scheduledTasks.length} task(s) queued\n`));
  }

  const runTurn = async (text, { autonomous = false } = {}) => {
    generating = true;
    streamedThisTurn = false;
    reasoningStreamedThisTurn = false;
    const started = Date.now();
    spinner.start('thinking');
    try {
      await agent.send(text, { autonomous });
      md.flush();
      spinner.stop();
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const u = session.usage;
      const usageStr = u.input || u.output ? ` · ${u.input + u.output} tokens total` : '';
      process.stdout.write(c.muted(`\n${secs}s${usageStr}\n`));
    } catch (err) {
      md.flush();
      spinner.stop();
      if (err.name === 'AbortError') process.stdout.write(c.warn('\n⏹ interrupted\n'));
      else process.stdout.write(c.err(`\nerror: ${err.message}\n`));
    } finally {
      generating = false;
    }
  };

  // ================= non-interactive mode =================
  if (!interactive) {
    if (!provider.apiKey && ['openrouter', 'openai'].includes(provider.name)) {
      console.error(c.err(`No API key for provider "${provider.name}". Set ${cfg.providers[provider.name]?.apiKeyEnv || 'the apiKey in config'}.`));
      process.exit(1);
    }
    await runTurn(args.print, { autonomous: true });
    for (const s of mcpServers) s.stop();
    process.exit(0);
  }

  // ================= interactive REPL =================
  console.log(`\n${c.accent(c.bold ? '◢◤' : '')} ${c.bold('VoidCode')} ${c.muted(`v${require('../package.json').version}`)}`);
  console.log(c.muted(`${provider.name}/${provider.model} · ${path.basename(cwd)} · session ${session.id.slice(0, 10)}${session.messages.length ? ` (${session.messages.length} msgs resumed)` : ''}`));
  for (const e of mcpErrors) console.log(c.warn(`mcp: ${e}`));
  if (mcpServers.length) console.log(c.muted(`mcp: ${mcpServers.map((s) => `${s.name}(${s.tools.length} tools)`).join(', ')}`));
  console.log(c.muted(`/help for commands\n`));

  rl = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 200 });
  const PROMPT = c.accent('❯ ');
  rl.setPrompt(PROMPT);

  const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve((a || '').trim())));

  // Ask for a secret with the echo masked to *.
  const askMasked = (q) => new Promise((resolve) => {
    const orig = rl._writeToOutput;
    rl.question(q, (a) => {
      rl._writeToOutput = orig;
      process.stdout.write('\n');
      resolve((a || '').trim());
    });
    rl._writeToOutput = function (s) {
      // echo the prompt normally, mask typed characters
      if (s.includes(q)) orig.call(rl, s);
      else orig.call(rl, s.replace(/[^\r\n]/g, '*'));
    };
  });

  const applyConfig = () => {
    cfg = config.load(cwd);
    try {
      provider = config.resolveProvider(cfg, args.model);
    } catch { /* keep previous provider */ }
    agent.cfg = cfg;
    agent.provider = provider;
    agent.refreshProviders();
    permissions.cfg = cfg;
  };

  const maskKey = (k) => (k ? `${k.slice(0, 8)}…${k.slice(-4)}` : c.muted('(not set)'));

  const setIntegrationTokenFlow = async (name, envName) => {
    const label = name === 'githubToken' ? 'GitHub' : name === 'railwayToken' ? 'Railway' : 'Tavily';
    const token = await askMasked(`  ${label} token (Enter to clear): `);
    if (token.startsWith('/') || /\s/.test(token)) {
      console.log(c.warn('  that does not look like a token — not saved'));
      return;
    }
    config.saveGlobal({ integrations: { [name]: token } });
    applyConfig();
    console.log(c.ok(`  ${token ? 'saved' : 'cleared'} — ${label} token is now ${token ? 'set' : 'not set'}${process.env[envName] && !token ? ' (environment token remains available)' : ''}`));
  };

  const setKeyFlow = async (providerName) => {
    const name = providerName || await ask(`  provider name [${Object.keys(cfg.providers).join('/')}]: `);
    if (!cfg.providers[name]) { console.log(c.err(`  unknown provider "${name}"`)); return; }
    const key = await askMasked(`  API key for ${name} (Enter to clear): `);
    if (key.startsWith('/') || /\s/.test(key)) {
      console.log(c.warn('  that does not look like an API key — not saved'));
      return;
    }
    config.saveGlobal({ providers: { [name]: { apiKey: key } } });
    applyConfig();
    console.log(c.ok(`  ${key ? 'saved' : 'cleared'} — ${name} key is now ${maskKey(key)}`));
  };

  const settingsMenu = async () => {
    while (true) {
      const perms = cfg.permissions;
      console.log(`\n${c.bold('settings')} ${c.muted(`(saved to ${cfg._globalPath})`)}`);
      console.log(`  1) provider & model   ${c.info(`${provider.name}/${provider.model}`)}`);
      console.log(`  2) API keys           ${Object.entries(cfg.providers).map(([n, p]) => `${n}:${p.apiKey || (p.apiKeyEnv && process.env[p.apiKeyEnv]) ? c.ok('set') : c.muted('—')}`).join('  ')}`);
      console.log(`  3) integrations       GitHub:${cfg.integrations?.githubToken || process.env.GITHUB_TOKEN ? c.ok('set') : c.muted('—')}  Railway:${cfg.integrations?.railwayToken || process.env.RAILWAY_TOKEN ? c.ok('set') : c.muted('—')}  Tavily:${cfg.integrations?.tavilyApiKey || process.env[cfg.integrations?.tavilyApiKeyEnv || 'TAVILY_API_KEY'] ? c.ok('set') : c.muted('—')}`);
      console.log(`  4) permissions        ${Object.entries(perms).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      console.log(`  5) auto-allowed bash  ${c.muted((cfg.bashAllow || []).join(', ').slice(0, 70) || '(none)')}`);
      console.log(`  6) custom persona     ${cfg.persona ? c.ok('set') : c.muted('—')}`);
      console.log(`  7) custom memory      ${cfg.memory ? c.ok('set') : c.muted('—')}`);
      console.log(`  8) autonomy level     ${c.info(cfg.autonomyLevel || 'off')}`);
      console.log(`  9) protected paths    ${c.muted((cfg.protectedPaths || ['**/*']).join(', ').slice(0, 60))}`);
      console.log(`  q) done`);
      const choice = await ask('  choose: ');
      if (choice === 'q' || choice === '') break;
      if (choice === '1') {
        const m = await ask(`  model (e.g. openrouter/anthropic/claude-sonnet-4.5, ollama/llama3.1): `);
        if (m) {
          try {
            provider = config.resolveProvider(cfg, m);
            config.saveGlobal({ provider: provider.name, model: provider.model });
            applyConfig();
            console.log(c.ok(`  model → ${provider.name}/${provider.model}`));
          } catch (err) { console.log(c.err(`  ${err.message}`)); }
        }
      } else if (choice === '2') {
        await setKeyFlow();
      } else if (choice === '3') {
        const target = await ask('  integration [github/railway/tavily]: ');
        if (target === 'github') await setIntegrationTokenFlow('githubToken', 'GITHUB_TOKEN');
        else if (target === 'railway') await setIntegrationTokenFlow('railwayToken', 'RAILWAY_TOKEN');
        else if (target === 'tavily') await setIntegrationTokenFlow('tavilyApiKey', 'TAVILY_API_KEY');
        else console.log(c.err('  invalid integration'));
      } else if (choice === '4') {
        const cat = await ask('  category [bash/write/webfetch/mcp]: ');
        if (!['bash', 'write', 'webfetch', 'mcp'].includes(cat)) { console.log(c.err('  invalid category')); continue; }
        const mode = await ask('  mode [allow/ask/deny]: ');
        if (!['allow', 'ask', 'deny'].includes(mode)) { console.log(c.err('  invalid mode')); continue; }
        config.saveGlobal({ permissions: { [cat]: mode } });
        applyConfig();
        console.log(c.ok(`  ${cat} → ${mode}`));
      } else if (choice === '5') {
        const pat = await ask('  add pattern (e.g. "npm *") or -pattern to remove: ');
        if (!pat) continue;
        let list = [...(cfg.bashAllow || [])];
        if (pat.startsWith('-')) list = list.filter((p) => p !== pat.slice(1));
        else if (!list.includes(pat)) list.push(pat);
        config.saveGlobal({ bashAllow: list });
        applyConfig();
        permissions.setBashAllow(list);
        console.log(c.ok(`  bashAllow updated (${list.length} patterns)`));
      } else if (choice === '6') {
        const p = await ask('  custom persona instructions (Enter to clear): ');
        config.saveGlobal({ persona: p });
        applyConfig();
        console.log(c.ok(`  persona updated`));
      } else if (choice === '7') {
        const m = await ask('  custom memory / facts (Enter to clear): ');
        config.saveGlobal({ memory: m });
        applyConfig();
        console.log(c.ok(`  memory updated`));
      } else if (choice === '8') {
        const lvl = await ask('  autonomy level [off/research/safe/full]: ');
        if (!['off', 'research', 'safe', 'full'].includes(lvl)) { console.log(c.err('  invalid level')); continue; }
        config.saveGlobal({ autonomyLevel: lvl });
        applyConfig();
        console.log(c.ok(`  autonomy → ${lvl}`));
      } else if (choice === '9') {
        const pat = await ask('  add protected path glob (e.g. "src/**") or -pattern to remove. Default is **/* (everything): ');
        if (!pat) continue;
        let list = [...(cfg.protectedPaths || ['**/*'])];
        if (pat.startsWith('-')) list = list.filter((p) => p !== pat.slice(1));
        else if (!list.includes(pat)) list.push(pat);
        if (list.length === 0) list = ['**/*'];
        config.saveGlobal({ protectedPaths: list });
        applyConfig();
        console.log(c.ok(`  protectedPaths updated (${list.length} patterns)`));
      }
    }
  };

  let sigintCount = 0;
  rl.on('SIGINT', () => {
    if (generating) {
      agent.stop();
      return;
    }
    if (rl.line) {
      rl.write(null, { ctrl: true, name: 'u' }); // clear the line
      return;
    }
    sigintCount++;
    if (sigintCount >= 2) { shutdown(); return; }
    process.stdout.write(c.muted('\n(press Ctrl+C again to exit)\n'));
    rl.prompt();
    setTimeout(() => { sigintCount = 0; }, 1500);
  });

  const shutdown = () => {
    session.save();
    if (scheduler) scheduler.stop();
    for (const s of mcpServers) s.stop();
    process.stdout.write(c.muted('\nbye\n'));
    process.exit(0);
  };
  rl.on('close', shutdown);

  const handleSlash = async (line) => {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case 'help': console.log(HELP); break;
      case 'settings': await settingsMenu(); break;
      case 'exit': case 'quit': shutdown(); break;
      case 'clear': console.clear(); break;
      case 'new':
        session.save();
        session = new Session(cwd);
        agent.session = session;
        console.log(c.muted(`new session ${session.id.slice(0, 10)}`));
        break;
      case 'sessions': {
        const list = Session.list(cwd);
        if (!list.length) { console.log(c.muted('no sessions yet')); break; }
        for (const s of list.slice(0, 20)) {
          console.log(`${c.info(s.id)}  ${c.muted(`${s.messages} msgs`)}  ${s.title}`);
        }
        break;
      }
      case 'resume': {
        if (!arg) { console.log(c.err('usage: /resume <id>')); break; }
        try {
          session = Session.load(cwd, arg);
          agent.session = session;
          console.log(c.muted(`resumed "${session.title}" (${session.messages.length} messages)`));
        } catch (err) { console.log(c.err(err.message)); }
        break;
      }
      case 'model': {
        if (!arg) { console.log(`${provider.name}/${provider.model}`); break; }
        try {
          provider = config.resolveProvider(cfg, arg);
          agent.provider = provider;
          agent.refreshProviders();
          config.saveGlobal({ provider: provider.name, model: provider.model });
          cfg = config.load(cwd);
          console.log(c.muted(`model → ${provider.name}/${provider.model} (saved)`));
        } catch (err) { console.log(c.err(err.message)); }
        break;
      }
      case 'claude-account': {
        const cp = cfg.providers.claude || {};
        const accounts = Object.keys(cp.accounts || {});
        if (!arg) {
          if (!accounts.length) { console.log(c.muted('no claude accounts configured')); break; }
          for (const name of accounts) {
            const mark = name === (cp.activeAccount || 'default') ? c.ok('●') : ' ';
            const dir = cp.accounts[name].configDir || '(default ~/.claude)';
            console.log(`${mark} ${name}  ${c.muted(dir)}`);
          }
          console.log(c.muted('usage: /claude-account <name>  ·  /claude-account add <name> <configDir>'));
          break;
        }
        const [sub, ...subRest] = arg.split(/\s+/);
        if (sub === 'add') {
          const [name, dir] = subRest;
          if (!name || !dir) { console.log(c.err('usage: /claude-account add <name> <configDir>')); break; }
          config.saveGlobal({ providers: { claude: { accounts: { [name]: { configDir: dir } } } } });
          cfg = config.load(cwd);
          console.log(c.ok(`account "${name}" added — log into it once with:`));
          console.log(c.muted(`  $env:CLAUDE_CONFIG_DIR="${dir}"; claude auth login`));
          break;
        }
        if (!accounts.includes(sub)) { console.log(c.err(`unknown account "${sub}" — configured: ${accounts.join(', ') || '(none)'}`)); break; }
        config.saveGlobal({ providers: { claude: { activeAccount: sub } } });
        cfg = config.load(cwd);
        if (provider.name === 'claude') {
          provider = config.resolveProvider(cfg, `claude/${provider.model}`);
          agent.provider = provider;
          agent.refreshProviders();
        }
        console.log(c.muted(`claude account → ${sub} (saved)`));
        break;
      }
      case 'delete': {
        if (!arg) { console.log(c.err('usage: /delete <id>')); break; }
        try {
          if (session.id === arg) { session = new Session(cwd); agent.session = session; }
          Session.delete(cwd, arg);
          console.log(c.ok(`session ${arg} deleted`));
        } catch (err) { console.log(c.err(err.message)); }
        break;
      }
      case 'compact':
        try {
          const did = await agent.compact();
          console.log(c.muted(did ? 'context compacted' : 'nothing to compact'));
        } catch (err) { console.log(c.err(`compaction failed: ${err.message}`)); }
        break;
      case 'undo': {
        const msg = session.undoLast();
        console.log(msg ? c.warn(msg) : c.muted('nothing to undo'));
        break;
      }
      case 'diff': {
        const changed = [...new Set(session.fileBackups.map((b) => b.file))];
        if (!changed.length) { console.log(c.muted('no files changed this session')); break; }
        for (const f of changed) {
          const first = session.fileBackups.find((b) => b.file === f);
          const before = first.before ?? '';
          let after = '';
          try { after = fs.readFileSync(f, 'utf8'); } catch { }
          console.log(c.bold(`\n${f}`));
          console.log(ui.diffLines(before, after).join('\n'));
        }
        break;
      }
      case 'tools': {
        const defs = agent.tools.apiDefs || [];
        if (!defs.length && agent.mode === 'split') {
          console.log(c.muted('chat agent holds no tools — work is delegated to the action agent'));
          break;
        }
        for (const d of defs) {
          console.log(`${c.info(d.function.name.padEnd(22))} ${c.muted(d.function.description.split('\n')[0].slice(0, 90))}`);
        }
        break;
      }
      case 'mcp': {
        if (!mcpServers.length && !mcpErrors.length) {
          console.log(c.muted('no MCP servers configured (add mcpServers to ~/.voidcode/config.json)'));
        }
        for (const s of mcpServers) console.log(`${c.ok('●')} ${s.name}: ${s.tools.map((t) => t.name).join(', ')}`);
        for (const e of mcpErrors) console.log(`${c.err('●')} ${e}`);
        break;
      }
      case 'context': {
        const service = agent.contextService;
        if (!service?.repository) { console.log(c.muted('context database disabled')); break; }
        try {
          const sub = rest[0] || 'status';
          if (sub === 'status') console.log(JSON.stringify(await service.repository.status(), null, 2));
          else if (sub === 'list') console.log(JSON.stringify(await service.repository.list({}), null, 2));
          else console.log(c.err('usage: /context [status|list]'));
        } catch (err) { console.log(c.err(`context database: ${err.message}`)); }
        break;
      }
      case 'usage': {
        const u = session.usage;
        const agg = costTracker.load(cwd);
        console.log(`input ${u.input} · output ${u.output} · turns ${u.turns} · est context ${estTokens(session.messages)} tokens`);
        console.log(`session cost ${costTracker.formatCost(u.cost)} · time ${costTracker.formatDuration(u.activeTimeMs)}`);
        if (agg.sessions > 1) {
          console.log(`project total: ${costTracker.formatCost(agg.totalCost)} · ${costTracker.formatDuration(agg.totalActiveTimeMs)} across ${agg.sessions} sessions`);
        }
        break;
      }
      case 'scheduler': {
        const status = scheduler ? scheduler.getStatus() : { running: false, activeTaskId: null };
        const allTasks = schedule.listTasks();
        if (!allTasks.length) {
          console.log(c.muted('no scheduled tasks. Tell the agent to create one via the schedule tool.'));
        } else {
          for (const t of allTasks) {
            const statusIcon = t.enabled ? c.ok('●') : c.muted('○');
            const when = t.cron || `every ${t.interval}min`;
            const next = t.nextRun ? new Date(t.nextRun).toLocaleString() : c.muted('—');
            const last = t.lastRun ? new Date(t.lastRun).toLocaleString() : c.muted('never');
            const active = t.id === status.activeTaskId ? c.warn(' [running]') : '';
            console.log(`${statusIcon} ${c.bold(t.title)}${active}  ${c.muted(when)}  next: ${next}  last: ${last}`);
          }
        }
        if (status.running) {
          console.log(c.muted(`scheduler engine: active (polling every 30s)`));
        } else {
          console.log(c.muted(`scheduler engine: idle`));
        }
        break;
      }
      case 'focus': {
        const parts = arg.split(/\s+/);
        const sub = parts[0];
        if (!sub || sub === 'list') {
          const list = agent.focus.list();
          if (!list.length) { console.log(c.muted('no focus sessions')); break; }
          for (const s of list) {
            let line = `  ${c.info(s.id)} [${c.bold(s.status)}] — ${s.description} (${s.remainingMin}min)`;
            if (s.question) line += ` ${c.warn('❓')} ${s.question}`;
            console.log(line);
          }
          break;
        }
        if (sub === 'answer') {
          const id = parts[1];
          const answer = parts.slice(2).join(' ');
          if (!id || !answer) { console.log(c.err('usage: /focus answer <id> <answer>')); break; }
          const res = agent.focus.answer(id, answer);
          console.log(res.ok ? c.ok(`Answered ${id}`) : c.err(res.error));
          break;
        }
        if (sub === 'cancel') {
          const id = parts[1];
          if (!id) { console.log(c.err('usage: /focus cancel <id>')); break; }
          const res = agent.focus.cancel(id);
          console.log(res.ok ? c.ok(`Cancelled ${id}`) : c.err('No such session'));
          break;
        }
        console.log(c.err(`unknown /focus subcommand: ${sub}`));
        break;
      }
      case 'research': {
        const m = arg.match(/^(\d+)\s+([\s\S]*)$/);
        const minutes = m ? Math.max(1, parseInt(m[1], 10)) : 30;
        const topic = m ? m[2].trim() : arg.trim();
        if (!topic) { console.log(c.err('usage: /research <minutes> <topic...>')); break; }
        const prompt = `You are on a timed research sweep (${minutes} minutes). Research this topic thoroughly and compile a comprehensive report:\n\n${topic}\n\nCover it from many angles. Search the web (websearch), GitHub (search_repos), npm (search_packages), and Hacker News (search_news) for relevant tools, libraries, frameworks, and ideas. Read the most promising results with webfetch. Keep researching until the time budget expires — the system will reject early completion. Then deliver ONE aggregated report: findings per area, all sources consulted (with URLs), what is most promising, and any open questions.`;
        const { id } = agent.focus.spawn({ description: `research: ${topic.slice(0, 60)}`, prompt, minutes, mode: 'research' });
        console.log(c.ok(`⧉ research sweep ${id} started — ${minutes}min. The search trail will stream live here.`));
        console.log(c.muted(`  /focus list to check  ·  brief it mid-flight with /focus answer ${id} "..."`));
        break;
      }
      case 'models': {
        const { discoverModels, findModels } = require('./modelCatalog');
        const parts = arg.split(/\s+/);
        const sub = parts[0];
        if (!sub || sub === 'list') {
          const models = await discoverModels(cfg, cwd);
          const q = parts[1];
          const list = q ? findModels(models, q) : models;
          if (!list.length) { console.log(c.muted(q ? `no models match "${q}"` : 'no models available')); break; }
          for (const m of list.slice(0, 60)) {
            const caps = (m.capabilities || []).join(', ') || 'general';
            const cost = m.costCategory || (m.local ? 'free' : 'paid');
            console.log(`  ${c.info(m.id)} (${m.provider}/${m.modelName}) [${cost}, local:${!!m.local}] — ${caps}`);
          }
          if (list.length > 60) console.log(c.muted(`  … and ${list.length - 60} more`));
          if (q) console.log(c.muted(`${list.length} model(s) matching "${q}"`));
          break;
        }
        if (sub === 'set') {
          const modelId = parts[1];
          if (!modelId) { console.log(c.err('usage: /models set <modelId>')); break; }
          const res = await agent.setModel(modelId);
          if (res.ok) {
            console.log(c.ok(`Switched to ${res.provider.name}/${res.provider.model}`));
            provider = res.provider;
          } else {
            console.log(c.err(res.error || 'Failed to switch model'));
          }
          break;
        }
        console.log(c.err(`unknown /models subcommand: ${sub}`));
        break;
      }
      case 'init':
        await runTurn('Analyze this project (structure, language, build/test/run commands, conventions) and write an AGENTS.md file at the project root: a concise guide for AI coding agents working here. If AGENTS.md exists, improve it. Keep it under 60 lines.');
        break;
      default:
        console.log(c.err(`unknown command /${cmd} — /help`));
    }
  };

  // First launch with no key: ask for it right here, save it, continue.
  if (!provider.apiKey && ['openrouter', 'openai'].includes(provider.name)) {
    console.log(c.warn(`No API key set for ${provider.name}.`));
    await setKeyFlow(provider.name);
    if (!provider.apiKey) console.log(c.muted('skipped — you can add it anytime with /settings'));
  }

  const loop = () => {
    rl.prompt();
  };

  rl.on('line', async (line) => {
    const text = line.trim();
    sigintCount = 0;
    if (!text) { rl.prompt(); return; }
    if (text.startsWith('/')) {
      await handleSlash(text);
      rl.prompt();
      return;
    }
    rl.pause();
    await runTurn(text);
    rl.resume();
    rl.prompt();
  });

  loop();
}

module.exports = { main };
