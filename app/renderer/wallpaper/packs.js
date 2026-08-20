// Wallpaper scene packs for the desktop view. Each pack is a plain builder
// function: (THREE, {width, height, colors}) -> { scene, camera, update(dt,
// elapsed), resize(w, h), retint(colors), dispose() }. Kept dependency-free
// beyond three.js core so packs stay cheap to add — no shader libraries, no
// loaders, no textures fetched over the network (CSP is script-src 'self').

function hexToVec3(THREE, hex) {
  return new THREE.Color(hex);
}

// ---------------------------------------------------------------- starfield
// A slowly-drifting field of points with gentle parallax from a faint
// camera sway. Cheap: one BufferGeometry, no per-frame allocation.
function buildStarfield(THREE, { width, height, colors }) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 100);
  camera.position.z = 8;

  const COUNT = 1400;
  const positions = new Float32Array(COUNT * 3);
  const sizes = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    positions[i * 3 + 0] = (Math.random() - 0.5) * 60;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 60;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 40 - 5;
    sizes[i] = Math.random() * 1.6 + 0.4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.PointsMaterial({
    color: hexToVec3(THREE, colors.accent),
    size: 0.09,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);

  return {
    scene,
    camera,
    update(dt, elapsed) {
      points.rotation.y = elapsed * 0.012;
      points.rotation.x = Math.sin(elapsed * 0.05) * 0.05;
      camera.position.x = Math.sin(elapsed * 0.08) * 0.6;
      camera.position.y = Math.cos(elapsed * 0.07) * 0.4;
      camera.lookAt(0, 0, -5);
    },
    resize(w, h) { camera.aspect = w / h; camera.updateProjectionMatrix(); },
    retint(next) { mat.color = hexToVec3(THREE, next.accent); },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

// ---------------------------------------------------------------- flow grid
// A wireframe ground plane with a rolling sine-wave displacement — a quiet
// synthwave-style horizon. Vertex positions are recomputed from a base copy
// each frame rather than accumulated, so it never drifts out of shape.
function buildFlowGrid(THREE, { width, height, colors }) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100);
  camera.position.set(0, 3.2, 7);
  camera.lookAt(0, 0, -4);

  const SEG = 46;
  const geo = new THREE.PlaneGeometry(26, 26, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const base = geo.attributes.position.array.slice();

  const mat = new THREE.MeshBasicMaterial({
    color: hexToVec3(THREE, colors.accent),
    wireframe: true,
    transparent: true,
    opacity: 0.35,
  });
  const grid = new THREE.Mesh(geo, mat);
  grid.position.y = -1.6;
  grid.position.z = -6;
  scene.add(grid);

  return {
    scene,
    camera,
    update(dt, elapsed) {
      const pos = geo.attributes.position.array;
      for (let i = 0; i < pos.length; i += 3) {
        const x = base[i];
        const z = base[i + 2];
        pos[i + 1] = Math.sin(x * 0.35 + elapsed * 0.6) * 0.35
          + Math.cos(z * 0.3 + elapsed * 0.4) * 0.35;
      }
      geo.attributes.position.needsUpdate = true;
    },
    resize(w, h) { camera.aspect = w / h; camera.updateProjectionMatrix(); },
    retint(next) { mat.color = hexToVec3(THREE, next.accent); },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

// -------------------------------------------------------------- aurora drift
// A handful of large, soft, additively-blended points drifting like slow
// curtains of light. No shaders — just PointsMaterial with a radial sprite
// drawn to an offscreen canvas so it stays inside the 'self' CSP with no
// network texture fetch.
function radialSprite(THREE, hex) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  const color = new THREE.Color(hex);
  const rgb = `${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}`;
  g.addColorStop(0, `rgba(${rgb}, 0.55)`);
  g.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

function buildAurora(THREE, { width, height, colors }) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 100);
  camera.position.z = 9;

  const COUNT = 90;
  const positions = new Float32Array(COUNT * 3);
  const phase = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    positions[i * 3 + 0] = (Math.random() - 0.5) * 20;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 12;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 10 - 6;
    phase[i] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const base = positions.slice();

  const tex = radialSprite(THREE, colors.accent);
  const mat = new THREE.PointsMaterial({
    size: 3.2,
    map: tex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);

  return {
    scene,
    camera,
    update(dt, elapsed) {
      const pos = geo.attributes.position.array;
      for (let i = 0; i < COUNT; i++) {
        pos[i * 3 + 0] = base[i * 3 + 0] + Math.sin(elapsed * 0.15 + phase[i]) * 1.2;
        pos[i * 3 + 1] = base[i * 3 + 1] + Math.cos(elapsed * 0.12 + phase[i]) * 0.8;
      }
      geo.attributes.position.needsUpdate = true;
    },
    resize(w, h) { camera.aspect = w / h; camera.updateProjectionMatrix(); },
    retint(next) { mat.map = radialSprite(THREE, next.accent); mat.needsUpdate = true; },
    dispose() { geo.dispose(); mat.dispose(); tex.dispose(); },
  };
}

// ------------------------------------------------------------------- ocean
// A shader-driven water surface: sum-of-sines vertex displacement (a cheap
// stand-in for the Gerstner waves three.js's own Water example uses) plus a
// fragment shader for sun specular glint, height-based deep/shallow tint,
// and a distance haze toward the horizon. No THREE.Water/Sky addons and no
// normal-map texture, since those aren't vendored and would need a network
// or data-URI fetch — this stays a self-contained ShaderMaterial like the
// rest of the packs.
const OCEAN_VERTEX_SHADER = `
varying vec3 vNormal;
varying float vHeight;
varying vec3 vViewPos;
uniform float uTime;

float waveHeight(vec2 p, float t) {
  float h = 0.0;
  h += 0.35 * sin(dot(vec2(0.8, 0.6), p) * 0.28 + t * 0.9);
  h += 0.22 * sin(dot(vec2(-0.5, 0.85), p) * 0.45 + t * 1.3);
  h += 0.14 * sin(dot(vec2(0.3, -0.95), p) * 0.75 + t * 1.8);
  h += 0.08 * sin(dot(vec2(-0.9, -0.2), p) * 1.3 + t * 2.6);
  h += 0.05 * sin(dot(vec2(0.15, 0.99), p) * 2.1 + t * 3.4);
  return h;
}

vec3 waveNormal(vec2 p, float t) {
  float eps = 0.08;
  float hL = waveHeight(p - vec2(eps, 0.0), t);
  float hR = waveHeight(p + vec2(eps, 0.0), t);
  float hD = waveHeight(p - vec2(0.0, eps), t);
  float hU = waveHeight(p + vec2(0.0, eps), t);
  return normalize(vec3((hL - hR) / (2.0 * eps), 1.0, (hD - hU) / (2.0 * eps)));
}

void main() {
  vec2 p = position.xz;
  float h = waveHeight(p, uTime);
  vec3 displaced = position + vec3(0.0, h, 0.0);
  vNormal = waveNormal(p, uTime);
  vHeight = h;
  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`;

const OCEAN_FRAGMENT_SHADER = `
varying vec3 vNormal;
varying float vHeight;
varying vec3 vViewPos;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSun;
uniform vec3 uSunDir;

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(-vViewPos);
  vec3 L = normalize(uSunDir);
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  vec3 base = mix(uDeep, uShallow, clamp(vHeight * 2.2 + 0.45, 0.0, 1.0));
  float diff = max(dot(N, L), 0.0);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 260.0);
  vec3 color = base * (0.32 + 0.68 * diff);
  color += uSun * spec * 2.2;
  color = mix(color, uSun, fresnel * 0.18);
  float haze = smoothstep(14.0, 34.0, length(vViewPos));
  color = mix(color, uDeep, haze);
  gl_FragColor = vec4(color, 1.0);
}
`;

function buildOcean(THREE, { width, height, colors }) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100);
  camera.position.set(0, 2.4, 9);
  camera.lookAt(0, 0.2, -8);

  const deep = hexToVec3(THREE, colors.bg).lerp(new THREE.Color('#03141c'), 0.5);
  const shallow = hexToVec3(THREE, colors.accent);
  const sun = hexToVec3(THREE, colors.accent).lerp(new THREE.Color('#ffffff'), 0.6);

  const uniforms = {
    uTime: { value: 0 },
    uDeep: { value: deep },
    uShallow: { value: shallow },
    uSun: { value: sun },
    uSunDir: { value: new THREE.Vector3(0.35, 0.55, 0.25).normalize() },
  };

  const geo = new THREE.PlaneGeometry(44, 44, 100, 100);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: OCEAN_VERTEX_SHADER,
    fragmentShader: OCEAN_FRAGMENT_SHADER,
  });

  const water = new THREE.Mesh(geo, mat);
  water.position.y = -1.3;
  scene.add(water);

  return {
    scene,
    camera,
    update(dt, elapsed) { uniforms.uTime.value = elapsed; },
    resize(w, h) { camera.aspect = w / h; camera.updateProjectionMatrix(); },
    retint(next) {
      uniforms.uDeep.value = hexToVec3(THREE, next.bg).lerp(new THREE.Color('#03141c'), 0.5);
      uniforms.uShallow.value = hexToVec3(THREE, next.accent);
      uniforms.uSun.value = hexToVec3(THREE, next.accent).lerp(new THREE.Color('#ffffff'), 0.6);
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

export const PACKS = [
  { id: 'none', name: 'None' },
  { id: 'starfield', name: 'Starfield', build: buildStarfield },
  { id: 'flow-grid', name: 'Flow Grid', build: buildFlowGrid },
  { id: 'aurora', name: 'Aurora Drift', build: buildAurora },
  { id: 'ocean', name: 'Ocean', build: buildOcean },
];
