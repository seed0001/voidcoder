// VoidCode Desktop — frequency-reactive ambient visualizer.
// A modern take on classic 90s media-player visuals (Winamp AVS / the mountain
// ranges you used to fly through): layered ridgelines that spike with the low
// frequencies, a tonal color field that shifts with the music, drifting mist,
// and particles streaming past the camera. Pulls live FFT data from the media
// player's AnalyserNode via an injected getData() callback. No deps.

function createVisualizer(canvas, getData) {
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  let raf = 0;
  let last = 0;
  let running = false;

  const BUCKETS = 48;
  const bucketBuf = new Float32Array(BUCKETS);
  const ridgeEnergy = new Float32Array(6);
  const particles = [];
  const MAX_PARTICLES = 220;
  let loudness = 0;
  let bassBoostCache = 0;
  let lowMidCache = 0;

  function resize() {
    DPR = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function reseedParticles() {
    particles.length = 0;
    const n = Math.floor(MAX_PARTICLES * 0.7);
    for (let i = 0; i < n; i++) {
      particles.push({
        x: Math.random(),
        y: 0.15 + Math.random() * 0.7,
        z: 0.05 + Math.random() * 0.95,
        size: 0.6 + Math.random() * 1.6,
      });
    }
  }

  function spectrumOf(data) {
    const n = data.length;
    const bands = [0, 0, 0, 0, 0, 0];
    const edges = [0.02, 0.06, 0.14, 0.3, 0.55, 0.8, 1.0];
    for (let b = 0; b < bands.length; b++) {
      const a = Math.floor(edges[b] * n);
      const z = Math.max(a + 1, Math.floor(edges[b + 1] * n));
      let sum = 0, c = 0;
      for (let i = a; i < z; i++) { sum += data[i]; c++; }
      bands[b] = c ? sum / c / 255 : 0;
    }
    return bands;
  }

  function bucketed(data) {
    const n = data.length;
    for (let i = 0; i < BUCKETS; i++) {
      const a = Math.floor((i / BUCKETS) * n);
      let sum = 0;
      const z = Math.max(a + 1, Math.floor(((i + 1) / BUCKETS) * n));
      for (let j = a; j < z; j++) sum += data[j];
      bucketBuf[i] = (sum / (z - a)) / 255;
    }
  }

  function drawFrame(data) {
    if (!data || !data.length) { ctx.clearRect(0, 0, W, H); return; }
    if (canvas.width !== W * DPR) resize();

    const bands = spectrumOf(data);
    const bass = bands[0] * 0.6 + bands[1] * 0.4;
    const treble = bands[5];
    bassBoostCache = bands[0] * 0.8 + bands[1] * 0.5;
    lowMidCache = bands[2];

    ridgeEnergy[0] += (bass - ridgeEnergy[0]) * 0.35;
    ridgeEnergy[1] += (bands[1] - ridgeEnergy[1]) * 0.3;
    ridgeEnergy[2] += (bands[2] - ridgeEnergy[2]) * 0.28;
    ridgeEnergy[3] += (bands[3] - ridgeEnergy[3]) * 0.24;
    ridgeEnergy[4] += (bands[4] - ridgeEnergy[4]) * 0.22;
    ridgeEnergy[5] += (treble - ridgeEnergy[5]) * 0.2;

    let sum = 0;
    for (let i = 0; i < data.length; i += 2) sum += data[i];
    loudness += ((sum / (data.length / 2) / 255) - loudness) * 0.2;

    let num = 0, den = 0;
    for (let i = 0; i < BUCKETS; i++) { num += i * bucketBuf[i]; den += bucketBuf[i]; }
    const centroid = den ? num / den / BUCKETS : 0.5;
    let hue = (348 - (centroid * 215)) % 360;
    if (hue < 0) hue += 360;
    const sat = 60 + loudness * 35;
    const light = 42 + loudness * 26;

    ctx.clearRect(0, 0, W, H);

    // backdrop
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `hsla(${hue},${sat}%,${Math.max(6, light - 30)}%,1)`);
    g.addColorStop(1, `hsla(${(hue + 40) % 360},${sat}%,${Math.max(6, light - 55)}%,1)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // stars
    const starCount = Math.floor(W * H / 2600);
    for (let s = 0; s < starCount; s++) {
      const sx = (s * 137.508) % W;
      const sy = (s * 73.7) % (H * 0.5);
      const a = 0.15 + 0.5 * treble * ((s % 5) / 5);
      ctx.fillStyle = `hsla(${hue},20%,90%,${a})`;
      ctx.fillRect(sx, sy, 1, 1);
    }

    // layered ridges
    for (let layer = 0; layer < 5; layer++) {
      const depth = layer / 5;
      const energy = ridgeEnergy[layer] * (1 - depth * 0.5) + 0.08;
      drawRidge(layer, depth, energy, hue, sat, light);
    }

    drawParticles(bands, hue);
    drawMist(hue, sat, light);
  }

  function drawRidge(layer, depth, energy, hue, sat, light) {
    const baseY = H * (0.62 + depth * 0.36);
    const amp = (10 + depth * 34) * energy;
    const freq = 0.012 + depth * 0.012;
    const phase = layer * 1.7 + performance.now() * 0.00012 * (0.5 + depth);
    const baseAlpha = 0.30 + (1 - depth) * 0.4;
    const l = light + (1 - depth) * 14;

    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 2) {
      const n =
        Math.sin(x * freq + phase) * 0.6 +
        Math.sin(x * freq * 2.3 + phase * 1.7) * 0.3 +
        Math.sin(x * freq * 5.1 + phase * 2.3) * 0.1;
      const y = baseY - amp * Math.max(0, n);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, baseY - amp, 0, H);
    grad.addColorStop(0, `hsla(${hue},${sat}%,${l}%,${baseAlpha})`);
    grad.addColorStop(1, `hsla(${(hue + 60) % 360},${sat}%,${Math.max(4, l - 40)}%,${baseAlpha * 0.9})`);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  function drawParticles(bands, hue) {
    const speed = 0.008 + loudness * 0.02;
    const treble = bands[5];
    for (const p of particles) {
      p.z -= speed * (0.4 + p.z) * (1 + treble * 2);
      if (p.z <= 0.01) { p.x = Math.random(); p.y = 0.1 + Math.random() * 0.7; p.z = 0.95; }
      const px = p.x * W;
      const py = p.y * H;
      const s = p.size * (1 - p.z) * 2 * (1 + bassBoostCache);
      ctx.globalAlpha = (1 - p.z) * 0.9;
      ctx.fillStyle = `hsla(${(hue + 180) % 360},100%,85%,1)`;
      ctx.fillRect(px, py, Math.max(0.5, s), Math.max(0.5, s * 1.6));
    }
    ctx.globalAlpha = 1;
  }

  function drawMist(hue, sat, light) {
    const drift = performance.now() * 0.00002 * (1 + lowMidCache * 4);
    for (let m = 0; m < 3; m++) {
      const y = ((m * 0.33 + drift) % 1) * H * 0.6;
      const g = ctx.createLinearGradient(0, y - 12, 0, y + 12);
      const a = 0.04 + lowMidCache * 0.08;
      g.addColorStop(0, `hsla(${hue},${sat}%,${light}%,0)`);
      g.addColorStop(0.5, `hsla(${hue},${sat}%,${light + 10}%,${a})`);
      g.addColorStop(1, `hsla(${hue},${sat}%,${light}%,0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, y - 12, W, 24);
    }
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (!running) return;
    if (now - last < 33) return;   // ~30fps cap
    last = now;
    let data = null;
    try { data = getData(); } catch {}
    drawFrame(data);
  }

  return {
    start() {
      if (running) return;
      running = true;
      if (!particles.length) reseedParticles();
      resize();
      last = 0;
      if (!raf) raf = requestAnimationFrame(loop);
    },
    stop() { running = false; ctx.clearRect(0, 0, W, H); },
    resize,
    destroy() {
      running = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    },
  };
}

window.createVisualizer = createVisualizer;
