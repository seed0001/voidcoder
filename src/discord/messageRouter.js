// messageCreate handler: the deterministic gate (contact list) plus the
// per-contact Agent turn. Non-contacts get zero response — no ack, no log
// visible to them, nothing.

const contacts = require('./contacts');
const { makeEventsForMessage } = require('./discordOutput');

function isAllowedContext(msg, cfg) {
  if (!msg.guild) return true; // DMs always allowed (contact gate already applies)
  const { guildIds = [], allowedChannelIds = [] } = cfg.discord;
  if (guildIds.length && !guildIds.includes(msg.guild.id)) return false;
  if (allowedChannelIds.length && !allowedChannelIds.includes(msg.channel.id)) return false;
  return true;
}

function stripMention(content, clientUserId) {
  return content.replace(new RegExp(`^<@!?${clientUserId}>\\s*`), '').trim();
}

function makeMessageRouter({ cfg, sessionRegistry, client }) {
  return async function handleMessage(msg) {
    if (msg.author.bot) return;

    const tier = contacts.getTier(msg.author.id, cfg);
    if (!tier) return; // not a contact — ignore completely, no ack

    if (!isAllowedContext(msg, cfg)) return;

    const text = stripMention(msg.content, client.user.id);
    if (!text) return;

    const entry = sessionRegistry.get(msg.author.id);
    if (!entry) return; // race: contact was removed between the getTier check and here

    sessionRegistry.bindChannel(msg.author.id, msg.channel);

    try { await msg.channel.sendTyping(); } catch { /* best effort */ }

    const { events, finalize } = makeEventsForMessage(msg.channel);
    entry.agent.events = events;

    try {
      await entry.agent.send(text, { autonomous: false });
    } catch (err) {
      try { await msg.channel.send(`⚠ error: ${err.message.slice(0, 300)}`); } catch { /* best effort */ }
    } finally {
      await finalize();
    }
  };
}

module.exports = { makeMessageRouter, isAllowedContext, stripMention };
