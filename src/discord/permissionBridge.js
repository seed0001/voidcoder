// Bridges the CLI's interactive y/n/a permission prompt (see promptPermission
// in src/index.js) into Discord: post a message with reaction options, wait
// for the requester to react (or reply "y"/"n"/"a"), and resolve exactly the
// same 'y'|'n'|'a' shape Permissions.check() already expects. On timeout,
// deny — never leave a gated action hanging indefinitely.

const YES = '✅';
const ALWAYS = '♾️';
const NO = '❌';

function parseReaction(emojiName) {
  if (emojiName === YES) return 'y';
  if (emojiName === ALWAYS) return 'a';
  if (emojiName === NO) return 'n';
  return null;
}

function parseReply(content) {
  const c = content.trim().toLowerCase();
  if (/^(y|yes)$/.test(c)) return 'y';
  if (/^(a|always)$/.test(c)) return 'a';
  if (/^(n|no)$/.test(c)) return 'n';
  return null;
}

// Returns an async (question, meta) => 'y'|'n'|'a' bound to one Discord user,
// posting prompts to `channel` (a DM channel or the configured report channel).
function makePromptFn(discordUserId, cfg, channel) {
  const timeoutMs = (cfg.discord?.permissionTimeoutSec || 120) * 1000;
  return function promptFn(question, meta = {}) {
    const detail = meta.detail ? `\n\`${String(meta.detail).slice(0, 300)}\`` : '';
    const text = `🔒 **permission requested** — \`${meta.toolName || 'action'}\`${detail}\n${question}\n${YES} once · ${ALWAYS} always this session · ${NO} deny (auto-denies in ${Math.round(timeoutMs / 1000)}s)`;

    return new Promise(async (resolvePrompt) => {
      let msg;
      try {
        msg = await channel.send(text);
        await msg.react(YES);
        await msg.react(ALWAYS);
        await msg.react(NO);
      } catch {
        // Couldn't even post the prompt (channel gone, missing perms, etc.) — fail closed.
        resolvePrompt('n');
        return;
      }

      let settled = false;
      const finish = async (answer) => {
        if (settled) return;
        settled = true;
        try { reactionCollector.stop(); } catch { /* already stopped */ }
        try { replyCollector.stop(); } catch { /* already stopped */ }
        try {
          await msg.edit(`${text}\n\n→ **${answer === 'y' ? 'approved once' : answer === 'a' ? 'approved (always this session)' : 'denied'}**`);
        } catch { /* best effort — the decision already stands */ }
        resolvePrompt(answer);
      };

      const reactionCollector = msg.createReactionCollector({
        filter: (reaction, user) => user.id === discordUserId && parseReaction(reaction.emoji.name) !== null,
        time: timeoutMs,
      });
      reactionCollector.on('collect', (reaction) => finish(parseReaction(reaction.emoji.name)));
      reactionCollector.on('end', () => finish('n')); // timed out with nothing collected

      const replyCollector = msg.channel.createMessageCollector({
        filter: (m) => m.author.id === discordUserId && parseReply(m.content) !== null,
        time: timeoutMs,
      });
      replyCollector.on('collect', (m) => finish(parseReply(m.content)));
      replyCollector.on('end', () => finish('n')); // timed out with nothing collected
    });
  };
}

module.exports = { makePromptFn };
