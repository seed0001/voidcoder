// Discord daemon orchestration root. Standalone long-running process,
// decoupled from the Electron app's window-bound lifecycle (see the plan —
// app/main.js quits the whole process on window-all-closed, it's not a
// service). Run via `npm run discord` / bin/voidcode-discord.js.

const config = require('../config');
const { Agent } = require('../agent');
const { Session } = require('../sessions');
const { Permissions } = require('../permissions');
const mcp = require('../mcp');
const { Scheduler } = require('../scheduler');

const { SessionRegistry } = require('./sessionRegistry');
const { makeMessageRouter } = require('./messageRouter');
const { registerCommands, handleInteraction } = require('./commands');
const portfolio = require('./portfolio');
const { extractProposal } = require('./sweepPrompt');
const notify = require('./notify');
const { VoiceManager } = require('./voice/session');

function loadDiscordConfig() {
  let cfg = config.load(process.cwd());
  if (cfg.discord.projectPath && cfg.discord.projectPath !== process.cwd()) {
    cfg = config.load(cfg.discord.projectPath);
  }
  return cfg;
}

function resolveToken(cfg) {
  return cfg.discord.token || process.env[cfg.discord.tokenEnv] || '';
}

// Runs one scheduled task (either a user-created reminder/automation or a
// portfolio-sweep) as a fresh scratch Agent — not tied to any contact's
// live session, since background tasks have no human turn-taking.
async function runScheduledTask(cfg, mcpServers, task) {
  const cwd = task.projectPath || cfg.discord.projectPath || process.cwd();
  const taskCfg = { ...cfg, autonomyLevel: task.autonomyLevel || 'safe' };
  const provider = config.resolveProvider(taskCfg);
  const session = new Session(cwd); // scratch — scheduled tasks don't need persistent multi-turn history
  const permissions = new Permissions(taskCfg, async () => 'n'); // autonomous run — no human available to prompt
  const agent = new Agent({ cfg: taskCfg, provider, session, permissions, mcpServers, events: {}, cwd });
  try {
    const result = await agent.send(task.prompt, { autonomous: true, organismTask: `scheduled: ${task.title}` });
    return result || '(no output)';
  } catch (err) {
    return `ERROR: ${err.message}`;
  }
}

// One elevated follow-up turn executing an owner-approved proposal, on a
// fresh scratch Agent scoped to exactly this call — narrow, auditable elevation.
async function runApprovedProposal(cfg, mcpServers, task, proposalText) {
  const cwd = task.projectPath || cfg.discord.projectPath || process.cwd();
  const elevatedCfg = { ...cfg, autonomyLevel: 'full' };
  const provider = config.resolveProvider(elevatedCfg);
  const session = new Session(cwd);
  const permissions = new Permissions(elevatedCfg, async () => 'y');
  const agent = new Agent({ cfg: elevatedCfg, provider, session, permissions, mcpServers, events: {}, cwd });
  const result = await agent.send(
    `Owner approved this specific action:\n\n${proposalText}\n\nExecute it now.`,
    { autonomous: true, organismTask: `approved proposal: ${task.title}` },
  );
  return result;
}

async function main() {
  const cfg = loadDiscordConfig();
  if (!cfg.discord.enabled) {
    console.log('discord.enabled is false in config — nothing to do. Set discord.enabled: true and discord.ownerId to start the bot.');
    return;
  }
  if (!cfg.discord.ownerId) {
    console.error('discord.ownerId is not set — refusing to start (there would be no owner to gate anything against).');
    process.exit(1);
  }
  const token = resolveToken(cfg);
  if (!token) {
    console.error(`No Discord bot token. Set ${cfg.discord.tokenEnv} or discord.token in config.`);
    process.exit(1);
  }

  const { Client, GatewayIntentBits, Partials } = require('discord.js');
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel], // required to receive DM messageCreate events for uncached DM channels
  });

  // Headless daemon — nobody to prompt, so project-local (untrusted)
  // mcpServers entries are skipped rather than auto-started. Trust a project
  // via `config.trustMcpProject(path)` (e.g. through the terminal's
  // interactive prompt) to have the daemon start its servers too.
  const mcpUntrustedNames = cfg._trustedMcpProjects.includes(cfg._projectPath) ? [] : cfg._projectMcpServerNames;
  const { servers: mcpServers, errors: mcpErrors } = await mcp.startServers(cfg.mcpServers, { untrustedNames: mcpUntrustedNames });
  for (const e of mcpErrors) console.warn(`mcp: ${e}`);

  const sessionRegistry = new SessionRegistry({ cfg, mcpServers, client });
  const messageRouter = makeMessageRouter({ cfg, sessionRegistry, client });
  const voiceManager = new VoiceManager({ cfg, sessionRegistry, client });

  if (cfg.discord.portfolio.enabled) {
    try { portfolio.reconcileScheduledSweeps(cfg); } catch (err) { console.warn(`portfolio reconcile: ${err.message}`); }
  }

  const scheduler = new Scheduler({
    runTask: (task) => runScheduledTask(cfg, mcpServers, task),
    onComplete: async (task, result) => {
      const isPortfolio = task.source === 'portfolio-sweep';
      const channelId = isPortfolio ? portfolio.reportChannelForTask(task, cfg) : cfg.discord.reportChannelId;
      if (!channelId) return;

      if (isPortfolio) {
        const { hasProposal, proposalText, rest } = extractProposal(result);
        if (hasProposal) {
          await notify.postProposal(client, channelId, proposalText, {
            ownerId: cfg.discord.ownerId,
            onApprove: () => runApprovedProposal(cfg, mcpServers, task, proposalText),
          });
          if (rest) await notify.postToChannel(client, channelId, `📊 sweep "${task.title}": ${rest}`);
          return;
        }
      }
      const prefix = isPortfolio ? '📊 sweep' : '⏰ scheduled task';
      await notify.postToChannel(client, channelId, `${prefix} "${task.title}": ${result}`);
    },
  });

  client.once('ready', async () => {
    console.log(`discord daemon logged in as ${client.user.tag}`);
    try { await registerCommands(client, cfg); } catch (err) { console.warn(`slash command registration: ${err.message}`); }
    scheduler.start();
  });

  client.on('messageCreate', (msg) => {
    messageRouter(msg).catch((err) => console.error('messageRouter error:', err));
  });

  client.on('interactionCreate', (interaction) => {
    handleInteraction(interaction, { cfg, sessionRegistry, voiceManager }).catch(async (err) => {
      console.error('interaction error:', err);
      try {
        if (interaction.isRepliable() && !interaction.replied) await interaction.reply({ content: `⚠ ${err.message}`, ephemeral: true });
      } catch { /* best effort */ }
    });
  });

  const shutdown = async (signal) => {
    console.log(`\n${signal} — shutting down discord daemon`);
    scheduler.stop();
    voiceManager.stop();
    sessionRegistry.stop();
    for (const s of mcpServers) { try { s.stop(); } catch { /* best effort */ } }
    try { await client.destroy(); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await client.login(token);
}

module.exports = { main };
