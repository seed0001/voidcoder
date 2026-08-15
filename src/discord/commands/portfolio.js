// /portfolio — owner-only management of the autonomously-managed project list.

const { SlashCommandBuilder } = require('discord.js');
const contacts = require('../contacts');
const { tierCapability } = require('../tiers');
const portfolio = require('../portfolio');

const data = new SlashCommandBuilder()
  .setName('portfolio')
  .setDescription('Manage the projects under autonomous management (owner only)')
  .addSubcommand((sc) => sc.setName('add').setDescription('Register a project')
    .addStringOption((o) => o.setName('path').setDescription('absolute path to the project directory').setRequired(true))
    .addStringOption((o) => o.setName('name').setDescription('display name').setRequired(false))
    .addStringOption((o) => o.setName('goal').setDescription('monetization goal / notes').setRequired(false)))
  .addSubcommand((sc) => sc.setName('remove').setDescription('Deregister a project')
    .addStringOption((o) => o.setName('id').setDescription('project id (see /portfolio list)').setRequired(true)))
  .addSubcommand((sc) => sc.setName('list').setDescription('List registered projects'));

function tierOf(userId, cfg) {
  return contacts.getTier(userId, cfg);
}

async function execute(interaction, { cfg }) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const list = portfolio.listProjects();
    if (!list.length) return interaction.reply({ content: 'No projects registered.', ephemeral: true });
    const lines = list.map((p) => `${p.enabled ? '●' : '○'} \`${p.id}\` **${p.name}** — ${p.path}${p.monetizationGoal ? `\n   goal: ${p.monetizationGoal}` : ''}`);
    return interaction.reply({ content: lines.join('\n'), ephemeral: true });
  }

  const tier = tierOf(interaction.user.id, cfg);
  if (!tier || !tierCapability(tier, cfg, 'canManagePortfolio')) {
    return interaction.reply({ content: 'Only the owner can manage the portfolio.', ephemeral: true });
  }

  try {
    if (sub === 'add') {
      const path = interaction.options.getString('path', true);
      const name = interaction.options.getString('name') || undefined;
      const monetizationGoal = interaction.options.getString('goal') || '';
      const project = portfolio.addProject({ path, name, monetizationGoal });
      if (cfg.discord.portfolio.enabled) portfolio.reconcileScheduledSweeps(cfg);
      return interaction.reply({ content: `Registered \`${project.id}\` — **${project.name}** (${project.path}).${cfg.discord.portfolio.enabled ? '' : '\n\n⚠ discord.portfolio.enabled is false — sweeps will not run until it is turned on.'}`, ephemeral: true });
    }
    if (sub === 'remove') {
      const id = interaction.options.getString('id', true);
      const removed = portfolio.removeProject(id);
      if (cfg.discord.portfolio.enabled) portfolio.reconcileScheduledSweeps(cfg);
      return interaction.reply({ content: `Removed **${removed.name}**.`, ephemeral: true });
    }
  } catch (err) {
    return interaction.reply({ content: `⚠ ${err.message}`, ephemeral: true });
  }
}

module.exports = { data, execute };
