// Live voice-channel conversation. Turn-based: @discordjs/voice's per-speaker
// receiver gives natural utterance boundaries (speaking start -> AfterSilence
// end) so no custom VAD is needed. A per-user `busy` flag blocks capturing
// that same user's next utterance while their previous one is still being
// transcribed/answered/spoken back — no barge-in interruption in v1. Only
// audio from contacts is ever subscribed to; everyone else is ignored,
// mirroring the text-side gate.
//
// Requires @discordjs/voice + an Opus codec (opusscript by default — see
// cfg.discord.voice.opusLib) + prism-media + ffmpeg-static + a voice
// encryption lib, all added as regular dependencies (package.json) rather
// than optional, so `npm install` always covers them.

const { Readable } = require('stream');

const contacts = require('../contacts');
const notify = require('../notify');
const voiceIO = require('../../voiceIO');
const { pcmToWav } = require('./wav');

const MIN_UTTERANCE_BYTES = 3200; // ~16ms at 48kHz/stereo/16-bit — filters out speaking-start noise blips

class VoiceManager {
  // cfg — base config. sessionRegistry — shared SessionRegistry (voice and
  // text share the same per-contact Agent/Session). client — discord.js
  // Client, used only for the "synthesis failed, posting text instead" fallback.
  constructor({ cfg, sessionRegistry, client }) {
    this.cfg = cfg;
    this.sessionRegistry = sessionRegistry;
    this.client = client;
    this.connections = new Map(); // guildId -> { connection, player, busy: Set<userId> }
  }

  async join(channel) {
    const { joinVoiceChannel, entersState, VoiceConnectionStatus, createAudioPlayer } = require('@discordjs/voice');
    const guildId = channel.guild.id;
    this.leave(guildId); // replace any existing connection in this guild

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

    const player = createAudioPlayer();
    connection.subscribe(player);

    const state = { connection, player, busy: new Set() };
    this.connections.set(guildId, state);

    connection.receiver.speaking.on('start', (userId) => {
      this._onSpeakingStart(guildId, userId).catch((err) => console.error('voice speaking-start error:', err));
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => this.leave(guildId));

    return state;
  }

  leave(guildId) {
    const state = this.connections.get(guildId);
    if (!state) return false;
    try { state.connection.destroy(); } catch { /* already gone */ }
    this.connections.delete(guildId);
    return true;
  }

  stop() {
    for (const guildId of [...this.connections.keys()]) this.leave(guildId);
  }

  async _onSpeakingStart(guildId, userId) {
    const state = this.connections.get(guildId);
    if (!state) return;
    if (!contacts.getTier(userId, this.cfg)) return; // not a contact — ignore this speaker entirely
    if (state.busy.has(userId)) return; // still processing this user's previous utterance

    const { EndBehaviorType } = require('@discordjs/voice');
    const prism = require('prism-media');

    const opusStream = state.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const pcmChunks = [];

    state.busy.add(userId);
    opusStream.pipe(decoder);
    decoder.on('data', (chunk) => pcmChunks.push(chunk));
    decoder.once('end', () => {
      this._handleUtterance(guildId, userId, Buffer.concat(pcmChunks))
        .catch((err) => console.error('voice utterance error:', err))
        .finally(() => state.busy.delete(userId));
    });
    decoder.once('error', (err) => {
      console.error('opus decode error:', err);
      state.busy.delete(userId);
    });
  }

  async _handleUtterance(guildId, userId, pcmBuffer) {
    if (pcmBuffer.length < MIN_UTTERANCE_BYTES) return;

    const wav = pcmToWav(pcmBuffer, { sampleRate: 48000, channels: 2 });
    let transcript;
    try {
      transcript = await voiceIO.transcribe(wav, 'audio/wav');
    } catch (err) {
      console.error('voice transcribe failed:', err);
      return;
    }
    if (!transcript || !transcript.trim()) return;

    const entry = this.sessionRegistry.get(userId);
    if (!entry) return; // contact was removed mid-conversation

    let replyText;
    try {
      replyText = await entry.agent.send(transcript, { autonomous: false });
    } catch (err) {
      replyText = `Sorry, I hit an error: ${err.message}`;
    }

    const synth = await voiceIO.synthesize(replyText || '(no reply)');
    if (!synth || synth.ok === false || !synth.audio) {
      const channelId = this.cfg.discord.reportChannelId;
      if (channelId) await notify.postToChannel(this.client, channelId, `🔈 (voice reply — speech synthesis failed) ${replyText}`);
      return;
    }

    await this._play(guildId, synth.audio);
  }

  async _play(guildId, audioBuffer) {
    const state = this.connections.get(guildId);
    if (!state) return;
    const { createAudioResource, StreamType, AudioPlayerStatus, entersState } = require('@discordjs/voice');
    const resource = createAudioResource(Readable.from(audioBuffer), { inputType: StreamType.Arbitrary });
    state.player.play(resource);
    try {
      await entersState(state.player, AudioPlayerStatus.Playing, 5_000);
      await entersState(state.player, AudioPlayerStatus.Idle, 60_000);
    } catch { /* playback finished, was interrupted, or the wait itself timed out — either way stop blocking */ }
  }
}

module.exports = { VoiceManager };
