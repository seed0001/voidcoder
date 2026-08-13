// Voice I/O: push-to-talk, hands-free open mic with voice activity detection,
// barge-in (talk over the assistant to cut it off), and a sequential TTS
// playback queue fed sentence-by-sentence while the reply streams.
/* exported VoiceIO */

class VoiceIO {
  constructor({ onUtterance, onState, onBargeIn, onError }) {
    this.onUtterance = onUtterance;
    this.onState = onState;
    this.onBargeIn = onBargeIn;
    this.onError = onError || (() => {});

    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.vadTimer = null;

    this.handsFree = false;
    this.recorder = null;
    this.chunks = [];
    this.inSpeech = false;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    this.noiseFloor = 0.008;
    this.utteranceHadSpeech = false;
    this.recStartedAt = 0;

    this.pttActive = false;

    this.ttsQueue = [];
    this.player = null;
    this.speaking = false;
    this.ttsGen = 0; // bumped to invalidate queued audio after stop

    this.state = 'idle';
  }

  _setState(s) {
    this.state = s;
    this.onState?.(s);
  }

  async _ensureStream() {
    if (this.stream && this.stream.active) return this.stream;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.audioCtx = new AudioContext();
    const src = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    return this.stream;
  }

  _rms() {
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  // ---------------- hands-free ----------------

  async setHandsFree(on) {
    this.handsFree = on;
    if (on) {
      try {
        await this._ensureStream();
      } catch (err) {
        this.handsFree = false;
        this.onError(`Microphone unavailable: ${err.message}`);
        return false;
      }
      this._startRecorder();
      this._startVad();
      this._setState('listening');
    } else {
      this._stopVad();
      this._stopRecorder(false);
      this._setState(this.speaking ? 'speaking' : 'idle');
    }
    return this.handsFree;
  }

  _startRecorder() {
    if (!this.stream) return;
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm;codecs=opus' });
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.recorder.start(250);
    this.recStartedAt = Date.now();
  }

  _stopRecorder(process) {
    const rec = this.recorder;
    this.recorder = null;
    if (!rec || rec.state === 'inactive') return;
    const chunks = this.chunks;
    rec.onstop = async () => {
      if (!process) return;
      const blob = new Blob(chunks, { type: 'audio/webm' });
      if (blob.size < 2000) return;
      this._setState('transcribing');
      try {
        const buf = await blob.arrayBuffer();
        const text = await window.vc.transcribe(buf, 'audio/webm');
        if (text && text.length > 1) this.onUtterance(text);
      } catch (err) {
        this.onError(`Voice input failed: ${err.message}`);
      } finally {
        if (this.handsFree) this._setState(this.speaking ? 'speaking' : 'listening');
        else this._setState(this.speaking ? 'speaking' : 'idle');
      }
    };
    rec.stop();
  }

  _startVad() {
    this._stopVad();
    this.vadTimer = setInterval(() => {
      if (!this.analyser) return;
      const rms = this._rms();
      // adapt noise floor only outside speech
      if (!this.inSpeech) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      let thresh = Math.max(this.noiseFloor * 3.5, 0.012);
      if (this.speaking) thresh *= 2.5; // avoid triggering on our own TTS bleed

      if (!this.inSpeech) {
        if (rms > thresh) {
          this.speechFrames++;
          if (this.speechFrames >= 3) {
            this.inSpeech = true;
            this.silenceFrames = 0;
            this.utteranceHadSpeech = true;
            if (this.speaking) {
              this.stopSpeaking();
              this.onBargeIn?.();
            }
            this._setState('recording');
          }
        } else {
          this.speechFrames = 0;
          // rotate away long silent recordings so blobs stay small
          if (this.recorder && Date.now() - this.recStartedAt > 60000 && !this.utteranceHadSpeech) {
            this._stopRecorder(false);
            this._startRecorder();
          }
        }
      } else {
        if (rms < thresh * 0.7) {
          this.silenceFrames++;
          if (this.silenceFrames >= 18) { // ~900ms of silence = end of utterance
            this.inSpeech = false;
            this.speechFrames = 0;
            this.utteranceHadSpeech = false;
            this._stopRecorder(true);
            this._startRecorder();
          }
        } else {
          this.silenceFrames = 0;
        }
      }
    }, 50);
  }

  _stopVad() {
    if (this.vadTimer) { clearInterval(this.vadTimer); this.vadTimer = null; }
    this.inSpeech = false;
    this.speechFrames = 0;
  }

  // ---------------- push-to-talk ----------------

  async pttToggle() {
    if (this.handsFree) return; // hands-free owns the mic
    if (this.pttActive) {
      this.pttActive = false;
      this._stopRecorder(true);
      return;
    }
    try {
      await this._ensureStream();
    } catch (err) {
      this.onError(`Microphone unavailable: ${err.message}`);
      return;
    }
    this.stopSpeaking();
    this.pttActive = true;
    this._startRecorder();
    this._setState('recording');
  }

  // ---------------- TTS queue ----------------

  enqueue(text) {
    if (!text || !text.trim()) return;
    const item = {
      text: text.trim(),
      gen: this.ttsGen,
      state: 'queued',
      audio: null,
      mimeType: null,
    };
    this.ttsQueue.push(item);
    this._synthesizeItem(item);
    if (!this.speaking) this._drainQueue();
  }

  async _synthesizeItem(item) {
    if (item.gen !== this.ttsGen) return;
    item.state = 'synthesizing';
    try {
      const res = await window.vc.speak(item.text);
      if (item.gen !== this.ttsGen) return;
      if (res && res.audio) {
        item.audio = res.audio;
        item.mimeType = res.mimeType;
        item.state = 'ready';
      } else {
        item.state = 'failed';
      }
    } catch {
      item.state = 'failed';
    }
    if (this.speaking && this._currentWaitingItem === item) {
      this._currentWaitingResolve?.();
    }
  }

  async _drainQueue() {
    this.speaking = true;
    this._setState('speaking');
    while (this.ttsQueue.length) {
      const item = this.ttsQueue[0];
      if (item.gen !== this.ttsGen) {
        this.ttsQueue.shift();
        continue;
      }
      if (item.state === 'queued' || item.state === 'synthesizing') {
        this._currentWaitingItem = item;
        await new Promise((resolve) => {
          this._currentWaitingResolve = resolve;
        });
        this._currentWaitingItem = null;
        this._currentWaitingResolve = null;
      }
      this.ttsQueue.shift();
      if (item.gen !== this.ttsGen) continue;
      if (item.state === 'ready' && item.audio) {
        try {
          await new Promise((resolve) => {
            const blob = new Blob([item.audio], { type: item.mimeType || 'audio/mpeg' });
            this.player = new Audio(URL.createObjectURL(blob));
            this.player.onended = resolve;
            this.player.onerror = resolve;
            this.player.play().catch(resolve);
          });
        } catch { /* ignore playback errors */ }
      }
    }
    this.speaking = false;
    this._setState(this.handsFree ? 'listening' : 'idle');
  }

  stopSpeaking() {
    this.ttsGen++;
    this.ttsQueue = [];
    this._currentWaitingItem = null;
    if (this._currentWaitingResolve) {
      this._currentWaitingResolve();
      this._currentWaitingResolve = null;
    }
    if (this.player) { try { this.player.pause(); } catch { } this.player = null; }
    this.speaking = false;
    if (this.state === 'speaking') this._setState(this.handsFree ? 'listening' : 'idle');
  }
}
