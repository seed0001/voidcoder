// Outbound notifications: plain status updates and irreversible-action
// approval requests. Used by the scheduler's onComplete, focus's onFocusDone,
// and portfolio sweeps — anywhere in the daemon that needs to tell the owner
// something happened or ask them to approve something.

const { chunkMessage } = require('./discordOutput');

async function postToChannel(client, channelId, text) {
  if (!channelId) return;
  let channel;
  try { channel = await client.channels.fetch(channelId); } catch { return; }
  if (!channel) return;
  for (const chunk of chunkMessage(text)) {
    try { await channel.send(chunk); } catch { /* best effort — don't crash the daemon over a notification */ }
  }
}

const APPROVE = '✅';
const REJECT = '❌';

// Posts a proposal with approve/reject reactions restricted to the owner.
// onApprove()/onReject() run once, on the first matching reaction. No
// timeout — irreversible-action proposals stay open until the owner acts,
// rather than silently expiring into a denial like a routine permission prompt.
async function postProposal(client, channelId, proposalText, { ownerId, onApprove, onReject }) {
  if (!channelId) return null;
  let channel;
  try { channel = await client.channels.fetch(channelId); } catch { return null; }
  if (!channel) return null;

  const header = `📝 **proposal — needs your approval**\n${proposalText}\n\n${APPROVE} approve and execute  ·  ${REJECT} reject`;
  let msg;
  try {
    msg = await channel.send(header);
    await msg.react(APPROVE);
    await msg.react(REJECT);
  } catch {
    return null;
  }

  const collector = msg.createReactionCollector({
    filter: (reaction, user) => user.id === ownerId && [APPROVE, REJECT].includes(reaction.emoji.name),
  });
  collector.on('collect', async (reaction) => {
    collector.stop();
    const approved = reaction.emoji.name === APPROVE;
    try {
      await msg.edit(`${header}\n\n→ **${approved ? 'approved' : 'rejected'}**`);
    } catch { /* best effort */ }
    try {
      if (approved) await onApprove?.();
      else await onReject?.();
    } catch (err) {
      try { await channel.send(`⚠ error acting on approved proposal: ${err.message.slice(0, 300)}`); } catch { /* best effort */ }
    }
  });
  return collector;
}

module.exports = { postToChannel, postProposal };
