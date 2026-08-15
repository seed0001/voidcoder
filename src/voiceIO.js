// Shared STT/TTS backend — used by the Electron desktop app (app/voice.js
// re-exports this) and the Discord daemon (src/discord/voice/session.js).
// STT: any OpenAI-compatible /audio/transcriptions endpoint.
// TTS: tries the configured backend first, then falls back through the chain
// (fish → edge → sapi) so a flaky cloud TTS degrades to speech instead of
// an error banner. synthesize() never throws — callers get {ok:false,error}.
// Uses only fs, global fetch/FormData/Blob, msedge-tts, and child_process —
// no Electron API — so it works unmodified in a plain Node process.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

let getCfg = () => ({});

function init(cfgGetter) { getCfg = cfgGetter; }

// Serialize TTS so multiple speakers (renderer queue + autoSpeak for scheduled
// tasks, or multiple Discord contacts) never open overlapping Edge WebSocket
// connections — that churn is what makes Microsoft drop the stream mid-utterance
// ("no turn.end received").
let ttsMutex = Promise.resolve();

async function transcribe(buffer, mimeType) {
  const cfg = getCfg().voice.stt;
  if (!cfg.baseUrl) throw new Error('No speech-to-text endpoint configured (Settings → Voice).');
  if (!cfg.apiKey && cfg.baseUrl.includes('groq.com')) {
    throw new Error('Speech-to-text needs an API key. Groq keys are free — add one in Settings → Voice.');
  }
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
  const ext = mimeType?.includes('ogg') ? 'ogg' : mimeType?.includes('wav') ? 'wav' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'audio/webm' }), `speech.${ext}`);
  form.append('model', cfg.model || 'whisper-large-v3-turbo');
  const headers = {};
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  const res = await fetch(url, { method: 'POST', headers, body: form });
  if (!res.ok) throw new Error(`transcription failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = await res.json();
  return (json.text || '').trim();
}

function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' — code shown on screen — ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function synthFish(text) {
  const cfg = getCfg().voice.tts.fish;
  if (!cfg.apiKey) throw new Error('no Fish Audio key');
  const body = { text, format: 'mp3', latency: 'normal' };
  if (cfg.voiceId) body.reference_id = cfg.voiceId;
  const res = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', 'model': cfg.model || 's1' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`fish HTTP ${res.status}`);
  return { audio: Buffer.from(await res.arrayBuffer()), mimeType: 'audio/mpeg' };
}

async function synthEdge(text) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
  const cfg = getCfg().voice.tts.edge;
  const voiceName = cfg.voice || 'en-US-AndrewMultilingualNeural';
  let lastErr = null;
  // Retry once: premature "close before turn.end" is usually a transient
  // Microsoft rate-limit/busy drop, and a fresh connection succeeds.
  for (let attempt = 0; attempt < 2; attempt++) {
    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      const { audioStream } = await tts.toStream(text);
      const chunks = [];
      // Only 'end' (turn.end received) counts as success. A premature close is
      // surfaced by the library as an 'error' on the stream → we fall through
      // to the next attempt / backend instead of playing truncated audio.
      await new Promise((resolve, reject) => {
        const watchdog = setTimeout(() => reject(new Error('edge TTS timed out')), 45000);
        audioStream.on('data', (c) => chunks.push(c));
        audioStream.on('end', () => { clearTimeout(watchdog); resolve(); });
        audioStream.on('error', (err) => { clearTimeout(watchdog); reject(err); });
        audioStream.on('close', () => { clearTimeout(watchdog); reject(new Error('edge stream closed before synthesis completed')); });
      });
      const buf = Buffer.concat(chunks);
      if (!buf.length) throw new Error('edge returned no audio');
      return { audio: buf, mimeType: 'audio/mpeg' };
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    } finally {
      try { tts.close(); } catch { /* the ws may already be dead */ }
    }
  }
  throw lastErr || new Error('edge failed');
}

async function synthSapi(text) {
  const cfg = getCfg().voice.tts.sapi;
  const outPath = path.join(os.tmpdir(), `vc-tts-${Date.now()}.wav`);
  const escaped = text.replace(/'/g, "''");
  const voiceSelect = cfg.voice ? `$s.SelectVoice('${cfg.voice.replace(/'/g, "''")}');` : '';
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${voiceSelect} $s.SetOutputToWaveFile('${outPath}'); $s.Speak('${escaped}'); $s.Dispose()`;
  await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 60000, windowsHide: true },
      (err) => (err ? reject(err) : resolve()));
  });
  const buf = fs.readFileSync(outPath);
  fs.unlink(outPath, () => { });
  return { audio: buf, mimeType: 'audio/wav' };
}

const SYNTH = { fish: synthFish, edge: synthEdge, sapi: synthSapi };

async function synthesize(text) {
  const spoken = cleanForSpeech(text);
  if (!spoken) return { audio: null };
  const capped = spoken.length > 3000 ? spoken.slice(0, 3000) + '…' : spoken;
  // Run the chain: configured backend first, then the rest in fallback order.
  const prefs = getCfg().voice.tts || {};
  const order = [prefs.backend, 'fish', 'edge', 'sapi']
    .filter((b, i, arr) => b && arr.indexOf(b) === i);
  let lastErr = null;
  for (const backend of order) {
    if (backend === 'fish' && !(getCfg().voice.tts.fish.apiKey)) { lastErr = new Error('no Fish Audio API key'); continue; }
    try {
      const out = await SYNTH[backend](capped);
      return { ...out, backend };
    } catch (err) {
      lastErr = err;
    }
  }
  return { ok: false, error: lastErr ? lastErr.message : 'no TTS backend succeeded' };
}

async function synthesizeQueued(text) {
  const task = ttsMutex.then(() => synthesize(text));
  ttsMutex = task.then(() => {}, () => {});
  return task;
}

module.exports = { init, transcribe, synthesize: synthesizeQueued };
