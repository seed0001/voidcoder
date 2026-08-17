// VoidCode Desktop — corner media player.
// Imports a local folder of music, builds a shuffled playlist, and plays it
// through an <audio> element whose output feeds a Web Audio AnalyserNode so
// the visualizer can read live frequency data. Self-contained (no deps).

const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.oga', '.wav', '.m4a', '.aac', '.flac', '.opus', '.webm']);

// Media files are served by the main process through the custom
// `mediafile://` protocol so they play under our strict CSP (media-src 'self' blob:).
// The host is always "local"; the path carries an encoded absolute file path.
function toMediaUrl(absPath) {
  return 'mediafile://local/' + encodeURIComponent(String(absPath).replace(/\\/g, '/'));
}

function createMediaPlayer({ onState, onTrack }) {
  // ---- state
  const state = {
    folder: null,
    name: null,
    queue: [],          // shuffled playback order (list of file paths)
    index: -1,
    playing: false,
    shuffle: true,
    repeat: false,
    volume: 0.8,
  };

  // hidden audio element (kept out of the DOM tree; only the Web Audio graph
  // needs it, so we never visually surface native controls)
  const audio = new Audio();
  audio.preload = 'auto';

  // ---- Web Audio graph feeding the visualizer
  let audioCtx = null;
  let analyser = null;
  let srcNode = null;
  let freqData = new Uint8Array(0);

  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.82;
      analyser.connect(audioCtx.destination);
      freqData = new Uint8Array(analyser.frequencyBinCount);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function emit() {
    onState && onState({
      folder: state.folder,
      name: state.name,
      index: state.index,
      total: state.queue.length,
      playing: state.playing,
      shuffle: state.shuffle,
      repeat: state.repeat,
      volume: state.volume,
      current: state.queue[state.index] || null,
      position: typeof audio.currentTime === 'number' && isFinite(audio.currentTime) ? audio.currentTime : 0,
      duration: typeof audio.duration === 'number' && isFinite(audio.duration) ? audio.duration : 0,
    });
  }

  function notifyTrack() {
    if (onTrack) onTrack(state.queue[state.index] || null);
  }

  function loadTrack(path, autoplay) {
    state.index = state.queue.indexOf(path);
    if (state.index < 0) state.index = 0;
    const real = state.queue[state.index];
    audio.src = toMediaUrl(real);
    audio.load();
    if (autoplay) audio.play().catch(() => {});
  }

  function play() {
    if (!state.queue.length) return;
    if (state.index < 0) state.index = 0;
    if (audio.src) audio.play().catch(() => {});
  }

  function playIndex(i) {
    if (i < 0 || i >= state.queue.length) return;
    state.index = i;
    const p = state.queue[i];
    audio.src = toMediaUrl(p);
    audio.load();
    audio.play().catch(() => {});
    notifyTrack();
  }

  function next() {
    if (!state.queue.length) return;
    nextIndexAuto();
    playIndex(state.index);
  }

  function prev() {
    if (!state.queue.length) return;
    // restart current track if it's more than 3s in
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    const n = state.queue.length;
    state.index = ((state.index - 1) + n) % n;
    playIndex(state.index);
  }

  // advance the pointer, honoring shuffle/repeat
  function nextIndexAuto() {
    const n = state.queue.length;
    if (state.shuffle) {
      // pick a random track; if repeat is off, avoid the current one when possible
      let i;
      if (n === 1) { i = 0; }
      else {
        do { i = Math.floor(Math.random() * n); } while (i === state.index);
      }
      state.index = i;
    } else {
      if (state.index >= n - 1) state.index = state.repeat ? 0 : n - 1;
      else state.index++;
    }
  }

  // ---- audio wiring
  audio.addEventListener('play', () => { state.playing = true; ensureAudio(); emit(); });
  audio.addEventListener('pause', () => { state.playing = false; emit(); });
  audio.addEventListener('ended', () => {
    if (!state.queue.length) { state.playing = false; emit(); return; }
    if (state.repeat && state.queue.length === 1) {
      audio.currentTime = 0; audio.play().catch(() => {}); return;
    }
    nextIndexAuto();
    playIndex(state.index);
  });
  audio.addEventListener('timeupdate', () => emit());
  audio.addEventListener('loadedmetadata', () => emit());

  function attachAnalyser() {
    if (!srcNode) {
      srcNode = audioCtx.createMediaElementSource(audio);
      srcNode.connect(analyser);
    }
    analyser.getByteFrequencyData(freqData);
  }

  // Pull fresh FFT data for the visualizer's own rAF loop.
  function getFrequencyData() {
    if (!audioCtx) return null;
    if (!srcNode) attachAnalyser();
    analyser.getByteFrequencyData(freqData);
    return freqData;
  }

  // ---- API
  return {
    getState: () => {
      return {
        folder: state.folder,
        name: state.name,
        index: state.index,
        total: state.queue.length,
        playing: state.playing,
        shuffle: state.shuffle,
        repeat: state.repeat,
        volume: state.volume,
        current: state.queue[state.index] || null,
        position: typeof audio.currentTime === 'number' && isFinite(audio.currentTime) ? audio.currentTime : 0,
        duration: typeof audio.duration === 'number' && isFinite(audio.duration) ? audio.duration : 0,
      };
    },
    setFolder(name, files) {
      state.folder = files.length ? (files[0] != null ? (files[0].split('/').slice(0, -1).join('/') || name) : name) : name;
      state.name = name;
      state.queue = files.slice();
      if (state.shuffle) shuffle(state.queue);
      state.index = state.queue.length ? 0 : -1;
      audio.src = '';
      audio.load();
      state.playing = false;
      emit();
      return state.queue.length;
    },
    play,
    pause: () => audio.pause(),
    toggle: () => { if (state.playing) audio.pause(); else play(); },
    next,
    prev,
    playIndex,
    setShuffle: (v) => { state.shuffle = !!v; emit(); },
    setRepeat: (v) => { state.repeat = !!v; emit(); },
    setVolume: (v) => { state.volume = Math.max(0, Math.min(1, v)); audio.volume = state.volume; emit(); },
    seek: (t) => { if (isFinite(t)) { audio.currentTime = t; emit(); } },
    getFrequencyData,
    getAnalyser: () => analyser,
  };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isAudioFile(p) {
  return AUDIO_EXTS.has((p.split('.').pop() || '').toLowerCase());
}

// Public surface for the renderer bundle.
window.MediaPlayer = { createMediaPlayer, isAudioFile, AUDIO_EXTS };
