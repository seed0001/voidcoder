// /voice join|leave — live voice-channel conversation (turn-based: wait for
// silence, then respond; no barge-in interruption in v1).

const { SlashCommandBuilder } = require('discord.js');
const contacts = require('../contacts');
const { tierCapability, meetsMinTier } = require('../tiers');

const data = new SlashCommandBuilder()
  .setName('voice')
  .setDescription('Join or leave your current voice channel')
  .addSubcommand((sc) => sc.setName('join').setDescription('Join the voice channel you are currently in'))
  .addSubcommand((sc) => sc.setName('leave').setDescription('Leave the voice channel'));

async function execute(interaction, { cfg, voiceManager }) {
  const tier = contacts.getTier(interaction.user.id, cfg);
  if (!tier) return interaction.reply({ content: 'Not authorized.', ephemeral: true });
  if (!tierCapability(tier, cfg, 'canUseVoice') || !meetsMinTier(tier, cfg.discord.voice.minTierAllowed, cfg)) {
    return interaction.reply({ content: 'Your permission tier cannot use voice.', ephemeral: true });
  }
  if (!cfg.discord.voice.enabled) {
    return interaction.reply({ content: 'Voice is disabled (discord.voice.enabled is false in config).', ephemeral: true });
  }

  const sub = interaction.options.getSubcommand();
  if (sub === 'join') {
    const member = interaction.member;
    const channel = member?.voice?.channel;
    if (!channel) return interaction.reply({ content: 'Join a voice channel first, then run this again.', ephemeral: true });
    try {
      await voiceManager.join(channel);
      return interaction.reply({ content: `Joined **${channel.name}**. Speak normally — I'll reply once you pause. (Turn-based: I won't hear you while I'm talking.)`, ephemeral: true });
    } catch (err) {
      return interaction.reply({ content: `⚠ couldn't join: ${err.message}`, ephemeral: true });
    }
  }
  if (sub === 'leave') {
    const guildId = interaction.guildId;
    const left = voiceManager.leave(guildId);
    return interaction.reply({ content: left ? 'Left the voice channel.' : 'Not currently in a voice channel here.', ephemeral: true });
  }
}

module.exports = { data, execute };
