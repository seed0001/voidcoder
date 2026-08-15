// Slash command registry: registers with Discord on startup, routes
// interactionCreate to the right handler.

const { REST, Routes } = require('discord.js');
const contactsCmd = require('./contacts');
const portfolioCmd = require('./portfolio');
const voiceCmd = require('./voice');

const COMMANDS = [contactsCmd, portfolioCmd, voiceCmd];

async function registerCommands(client, cfg) {
  const rest = new REST().setToken(client.token);
  const body = COMMANDS.map((c) => c.data.toJSON());
  const guildIds = cfg.discord.guildIds || [];
  if (guildIds.length) {
    for (const guildId of guildIds) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body });
    }
  } else {
    // Global registration can take up to an hour to propagate to all guilds —
    // set discord.guildIds for near-instant updates during setup/testing.
    await rest.put(Routes.applicationCommands(client.user.id), { body });
  }
}

async function handleInteraction(interaction, ctx) {
  if (!interaction.isChatInputCommand()) return;
  const cmd = COMMANDS.find((c) => c.data.name === interaction.commandName);
  if (!cmd) return;
  await cmd.execute(interaction, ctx);
}

module.exports = { registerCommands, handleInteraction, COMMANDS };
