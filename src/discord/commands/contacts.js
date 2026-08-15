// /contacts — owner-only contact list management. Every handler re-checks
// contacts.isOwner before doing anything; slash command permission defaults
// alone are not trusted as the sole gate (guild admins could otherwise grant
// the command to others).

const { SlashCommandBuilder } = require('discord.js');
const contacts = require('../contacts');

const data = new SlashCommandBuilder()
  .setName('contacts')
  .setDescription('Manage who this bot will talk to (owner only)')
  .addSubcommand((sc) => sc.setName('add').setDescription('Add a contact')
    .addUserOption((o) => o.setName('user').setDescription('the Discord user').setRequired(true))
    .addStringOption((o) => o.setName('tier').setDescription('permission tier').setRequired(true)))
  .addSubcommand((sc) => sc.setName('remove').setDescription('Remove a contact')
    .addUserOption((o) => o.setName('user').setDescription('the Discord user').setRequired(true)))
  .addSubcommand((sc) => sc.setName('settier').setDescription("Change a contact's tier")
    .addUserOption((o) => o.setName('user').setDescription('the Discord user').setRequired(true))
    .addStringOption((o) => o.setName('tier').setDescription('permission tier').setRequired(true)))
  .addSubcommand((sc) => sc.setName('list').setDescription('List all contacts'));

async function execute(interaction, { cfg }) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const list = contacts.listContacts();
    if (!list.length) return interaction.reply({ content: 'No contacts yet.', ephemeral: true });
    const lines = list.map((c) => `<@${c.id}> — ${c.tier}${c.note ? ` (${c.note})` : ''}`);
    return interaction.reply({ content: lines.join('\n'), ephemeral: true });
  }

  if (!contacts.isOwner(interaction.user.id, cfg)) {
    return interaction.reply({ content: 'Only the owner can manage contacts.', ephemeral: true });
  }

  try {
    if (sub === 'add') {
      const user = interaction.options.getUser('user', true);
      const tier = interaction.options.getString('tier', true);
      contacts.addContact(interaction.user.id, user.id, tier, cfg);
      return interaction.reply({ content: `Added <@${user.id}> as "${tier}".`, ephemeral: true });
    }
    if (sub === 'remove') {
      const user = interaction.options.getUser('user', true);
      contacts.removeContact(interaction.user.id, user.id, cfg);
      return interaction.reply({ content: `Removed <@${user.id}>.`, ephemeral: true });
    }
    if (sub === 'settier') {
      const user = interaction.options.getUser('user', true);
      const tier = interaction.options.getString('tier', true);
      contacts.setTier(interaction.user.id, user.id, tier, cfg);
      return interaction.reply({ content: `<@${user.id}> is now "${tier}".`, ephemeral: true });
    }
  } catch (err) {
    return interaction.reply({ content: `⚠ ${err.message}`, ephemeral: true });
  }
}

module.exports = { data, execute };
