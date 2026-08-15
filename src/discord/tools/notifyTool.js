// discord_post: lets the owner's agent proactively post an update to a
// Discord channel (e.g. "let me know in #updates when this finishes").
// Injected only into the owner's session (see sessionRegistry.js) — never
// added to the shared src/tools/index.js registry, which stays Discord-agnostic.

const defs = [
  {
    name: 'discord_post',
    description: 'Post a message to a Discord channel you have access to. Use this to send updates, reports, or notifications proactively.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'the message to post (will be chunked automatically if long)' },
        channelId: { type: 'string', description: 'target channel id; omit to use the configured default report channel' },
      },
      required: ['text'],
    },
  },
];

// ctx: { client, defaultChannelId }
function makeExecutors(ctx) {
  const { postToChannel } = require('../notify');
  return {
    async discord_post({ text, channelId }) {
      const target = channelId || ctx.defaultChannelId;
      if (!target) throw new Error('No channelId given and no default report channel configured.');
      await postToChannel(ctx.client, target, text);
      return `Posted to <#${target}>.`;
    },
  };
}

module.exports = { defs, makeExecutors };
