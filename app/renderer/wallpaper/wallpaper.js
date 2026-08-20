// Live wallpaper engine for the desktop view. A module script (deferred by
// the browser until after HTML parsing) that exposes window.Wallpaper for
// the classic app.js to drive — see docs/... none yet, this is new. Kept
// intentionally separate from app.js's render/state cycle so a WebGL issue
// here can never break the rest of the UI.
import * as THREE from '../vendor/three.module.min.js';
import { PACKS } from './packs.js';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let canvas = null;
let renderer = null;
let current = null;
let currentId = 'none';
let active = false;
let rafId = null;
let lastT = 0;

function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  return {
    accent: (cs.getPropertyValue('--accent') || '#5eead4').trim(),
    bg: (cs.getPropertyValue('--bg') || '#07090d').trim(),
  };
}

function ensureRenderer() {
  if (renderer) return;
  canvas = document.getElementById('wallpaper-canvas');
  if (!canvas) return;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', () => setActive(active));
}

function onResize() {
  if (!renderer || !canvas) return;
  const w = canvas.clientWidth || 1;
  const h = canvas.clientHeight || 1;
  renderer.setSize(w, h, false);
  current?.resize?.(w, h);
}

function teardownCurrent() {
  current?.dispose?.();
  current = null;
}

function loop(t) {
  rafId = requestAnimationFrame(loop);
  if (!active || !current || !renderer) return;
  const dt = lastT ? (t - lastT) / 1000 : 0;
  lastT = t;
  current.update?.(dt, t / 1000);
  renderer.render(current.scene, current.camera);
}
rafId = requestAnimationFrame(loop);

export function listPacks() {
  return PACKS.map(({ id, name }) => ({ id, name }));
}

export function setPack(id) {
  const packDef = PACKS.find((p) => p.id === id) || PACKS[0];
  currentId = packDef.id;
  teardownCurrent();
  canvas = canvas || document.getElementById('wallpaper-canvas');
  if (!canvas) return;
  if (packDef.id === 'none' || !packDef.build || reduceMotion.matches) {
    canvas.classList.add('hidden');
    return;
  }
  ensureRenderer();
  if (!renderer) return;
  canvas.classList.remove('hidden');
  const w = canvas.clientWidth || 1;
  const h = canvas.clientHeight || 1;
  renderer.setSize(w, h, false);
  lastT = 0;
  current = packDef.build(THREE, { width: w, height: h, colors: themeColors() });
}

export function getPack() {
  return currentId;
}

export function retint() {
  current?.retint?.(themeColors());
}

export function setActive(isActive) {
  active = !!isActive && !document.hidden && !!current;
  if (active) lastT = 0;
}

window.Wallpaper = { listPacks, setPack, getPack, retint, setActive };
