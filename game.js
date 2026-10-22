/* Roadster Loop – night ramp stunt game. three.js r128, no build step.
 * World units are metres (1 unit = 1 m). Gravity is 32.2 ft/s^2 = 9.81 u/s^2,
 * so ft/s and mph readouts are converted from world units. */
(function () {
'use strict';

if (typeof THREE === 'undefined') {
  document.getElementById('fatal').hidden = false;
  document.getElementById('title').hidden = true;
  return;
}

/* ===================================================================
 * Constants
 * =================================================================== */
const G = 32.2 * 0.3048;            // 9.81 u/s^2
const FT = 1 / 0.3048;              // units -> feet
const MPH = 0.44704;                // mph -> u/s
const STEP = 1 / 120;               // fixed physics step
const RIDE = 0.54;                  // car centre height above the surface
const ROAD_START = -150;            // x where the car starts
const R1 = 22;                      // quarter-pipe radius
const WALL = 14;                    // vertical wall height
const R2 = 9;                       // curl radius
const CURL = 22 * Math.PI / 180;    // curl sweep past vertical
const THRUST = 26;                  // u/s^2 from the floor ports
const GAS_DRAIN = 0.28;             // tank/s
const RING_REFILL = 0.35;
const RING_COUNT = 7;
const RING_R = 2.6;
const SPIN_ACC = 7.0;               // rad/s^2 from arrow keys
const SPIN_DAMP = 0.4;              // 1/s
const SPIN_CARRY = 0.45;            // fraction of ramp rotation kept at launch
const SINK_LIMIT = 39;              // ft/s
const TILT_LIMIT = 28;              // degrees
const BEST_KEY = 'roadsterLoopBest';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const wrapPi = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
const rand = (a, b) => a + Math.random() * (b - a);

/* ===================================================================
 * Ramp path, sampled by arc length (this is the car-centre path)
 * =================================================================== */
const L1 = R1 * Math.PI / 2;
const L2 = L1 + WALL;
const PATH_LEN = L2 + R2 * CURL;
const CURL_CX = R1 - R2;
const CURL_CY = RIDE + R1 + WALL;

function pathExact(s) {
  if (s <= L1) {
    const a = s / R1;
    return { x: R1 * Math.sin(a), y: RIDE + R1 * (1 - Math.cos(a)), h: a, r: R1 };
  }
  if (s <= L2) return { x: R1, y: RIDE + R1 + (s - L1), h: Math.PI / 2, r: 0 };
  const b = (s - L2) / R2;
  return { x: CURL_CX + R2 * Math.cos(b), y: CURL_CY + R2 * Math.sin(b), h: Math.PI / 2 + b, r: R2 };
}

const DS = 0.05;
const PN = Math.ceil(PATH_LEN / DS) + 2;
const PX = new Float32Array(PN), PY = new Float32Array(PN), PH = new Float32Array(PN), PR = new Float32Array(PN);
for (let i = 0; i < PN; i++) {
  const p = pathExact(Math.min(i * DS, PATH_LEN));
  PX[i] = p.x; PY[i] = p.y; PH[i] = p.h; PR[i] = p.r;
}
const _p = { x: 0, y: 0, h: 0, r: 0 };
function pathAt(s) {
  s = clamp(s, 0, PATH_LEN);
  const f = s / DS, i = Math.min(PN - 2, Math.floor(f)), t = f - i;
  _p.x = lerp(PX[i], PX[i + 1], t);
  _p.y = lerp(PY[i], PY[i + 1], t);
  _p.h = lerp(PH[i], PH[i + 1], t);
  _p.r = PR[i];
  return _p;
}

/* Dry-run of the ramp so the rings can be placed along the nominal arc. */
function simulateRampExit(v0) {
  let s = 0, v = v0;
  while (s < PATH_LEN && v > 0.5) {
    const p = pathAt(s);
    v -= G * Math.sin(p.h) * STEP;
    s += v * STEP;
  }
  const p = pathAt(s);
  return { x: p.x, y: p.y, vx: v * Math.cos(p.h), vy: v * Math.sin(p.h), v };
}

/* ===================================================================
 * Game state
 * =================================================================== */
let state = 'title';   // title | count | drive | ramp | air | landed | crashed | results
const keys = { left: false, right: false, space: false };
const run = {};
let best = 0;
try { best = parseInt(localStorage.getItem(BEST_KEY), 10) || 0; } catch (e) { best = 0; }

const count = { t: 0, hold: 2, green: false, greenAt: 0, lockUntil: 0 };
let landT = 0, crashT = 0, resultsAt = 0, inputGuard = 0, snapCam = true, titleT = 0;
let shake = 0;

function resetRun() {
  Object.assign(run, {
    x: ROAD_START, y: RIDE, vx: 0, vy: 0, v: 0, accel: 0, s: 0,
    angle: 0, omega: 0, gas: 1,
    reaction: 0, rampMph: 0, rampSpeed: 0,
    flips: 0, inv: false, rings: 0, airtime: 0, maxAlt: 0, peakG: 1,
    touchdown: 0, landTilt: 0, landed: false, score: 0, wheelSpin: 0, thrusting: false
  });
}
resetRun();

/* ===================================================================
 * three.js scene
 * =================================================================== */
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050818);
scene.fog = new THREE.FogExp2(0x070b1d, 0.0036);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1500);

scene.add(new THREE.HemisphereLight(0x5f7bd6, 0x10142a, 0.75));
const moonLight = new THREE.DirectionalLight(0x9fb8ff, 0.7);
moonLight.position.set(-60, 120, 80);
scene.add(moonLight);

function glowTexture(color) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, color); grd.addColorStop(0.35, color.replace(/[\d.]+\)$/, '0.35)')); grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/* --- sky: stars + moon --- */
(function sky() {
  const n = 900, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const th = Math.random() * Math.PI * 2, ph = Math.random() * 1.2 + 0.1, r = 900;
    pos[i * 3] = Math.cos(th) * Math.sin(ph) * r - 100;
    pos[i * 3 + 1] = Math.cos(ph) * r * 0.6 + 40;
    pos[i * 3 + 2] = -Math.abs(Math.sin(th) * Math.sin(ph)) * r - 200;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xcfe0ff, size: 2.2, sizeAttenuation: false, fog: false })));
  const moon = new THREE.Mesh(new THREE.CircleGeometry(26, 40), new THREE.MeshBasicMaterial({ color: 0xe9f0ff, fog: false }));
  moon.position.set(-230, 250, -700);
  scene.add(moon);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(160,190,255,1)'), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.55 }));
  halo.scale.set(240, 240, 1); halo.position.copy(moon.position);
  scene.add(halo);
})();

/* --- skyline --- */
(function skyline() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#0a0f21'; g.fillRect(0, 0, 64, 128);
  for (let y = 4; y < 124; y += 8) for (let x = 4; x < 60; x += 8) {
    const r = Math.random();
    if (r < 0.34) { g.fillStyle = r < 0.1 ? '#6fe6ff' : (r < 0.2 ? '#ffd88a' : '#ff9ad0'); g.fillRect(x, y, 4, 5); }
  }
  const base = new THREE.CanvasTexture(c);
  base.wrapS = base.wrapT = THREE.RepeatWrapping;
  base.magFilter = THREE.NearestFilter;
  for (let i = 0; i < 46; i++) {
    const w = rand(14, 34), h = rand(24, 120), d = rand(14, 30);
    const tex = base.clone(); tex.needsUpdate = true;
    tex.repeat.set(w / 8, h / 16);
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ map: tex, color: 0xbcc8ff }));
    m.position.set(-420 + i * 14 + rand(-4, 4), h / 2 - 1, -rand(60, 150));
    scene.add(m);
  }
})();

/* --- ground, road, street lights --- */
(function ground() {
  const gnd = new THREE.Mesh(new THREE.PlaneGeometry(1400, 500), new THREE.MeshStandardMaterial({ color: 0x0b1120, roughness: 0.95 }));
  gnd.rotation.x = -Math.PI / 2; gnd.position.set(-200, -0.05, 0);
  scene.add(gnd);

  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#161b2b'; g.fillRect(0, 0, 128, 64);
  for (let i = 0; i < 400; i++) { g.fillStyle = 'rgba(255,255,255,' + Math.random() * 0.05 + ')'; g.fillRect(Math.random() * 128, Math.random() * 64, 2, 1); }
  g.fillStyle = '#d9e4ff'; g.fillRect(8, 30, 48, 4);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const roadLen = 420;
  tex.repeat.set(roadLen / 10, 1);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(roadLen, 11), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, metalness: 0.25 }));
  road.rotation.x = -Math.PI / 2; road.position.set(-roadLen / 2 + 40, 0, 0);
  scene.add(road);

  [-5.6, 5.6].forEach((z, i) => {
    const e = new THREE.Mesh(new THREE.BoxGeometry(roadLen, 0.08, 0.14), new THREE.MeshBasicMaterial({ color: i ? 0xff3fa4 : 0x3ff0ff }));
    e.position.set(-roadLen / 2 + 40, 0.05, z);
    scene.add(e);
  });
  const line = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 11), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  line.rotation.x = -Math.PI / 2; line.position.set(ROAD_START + 7, 0.03, 0);
  scene.add(line);

  const glow = glowTexture('rgba(255,214,150,1)');
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b3350, roughness: 0.6 });
  for (let x = -350; x <= 40; x += 32) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 9, 8), poleMat);
    pole.position.set(x, 4.5, -8.5);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 2.6), poleMat);
    arm.position.set(x, 9, -7.4);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe2b0 }));
    bulb.position.set(x, 8.85, -6.2);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9 }));
    spr.scale.set(11, 11, 1); spr.position.copy(bulb.position);
    scene.add(pole, arm, bulb, spr);
  }
})();

/* --- ramp --- */
(function ramp() {
  const W = 11;
  const surf = [], back = [];
  for (let s = 0; s <= PATH_LEN + 1e-4; s += 0.4) {
    const p = pathExact(Math.min(s, PATH_LEN));
    const nx = -Math.sin(p.h), ny = Math.cos(p.h);
    surf.push(new THREE.Vector2(p.x - RIDE * nx, p.y - RIDE * ny));
    back.push(new THREE.Vector2(p.x - (RIDE + 1.4) * nx, p.y - (RIDE + 1.4) * ny));
  }
  const shape = new THREE.Shape();
  shape.moveTo(-6, 0);
  surf.forEach((v) => shape.lineTo(v.x, v.y));
  for (let i = back.length - 1; i >= 0; i--) shape.lineTo(back[i].x, back[i].y);
  shape.lineTo(-6, -1.4);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: W, bevelEnabled: false, steps: 1 });
  geo.translate(0, 0, -W / 2);
  const slab = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x1a2440, roughness: 0.55, metalness: 0.35 }));
  scene.add(slab);

  const cy = new THREE.MeshBasicMaterial({ color: 0x3ff0ff }), mg = new THREE.MeshBasicMaterial({ color: 0xff3fa4 });
  for (let s = 1.5, k = 0; s < PATH_LEN; s += 3, k++) {
    const p = pathExact(s);
    const nx = -Math.sin(p.h), ny = Math.cos(p.h);
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, W - 0.8), k % 2 ? mg : cy);
    m.position.set(p.x - (RIDE - 0.03) * nx, p.y - (RIDE - 0.03) * ny, 0);
    m.rotation.z = p.h;
    scene.add(m);
  }
  [-W / 2 + 0.05, W / 2 - 0.05].forEach((z, i) => {
    const pts = [];
    for (let s = 0; s <= PATH_LEN; s += 0.5) {
      const p = pathExact(s), nx = -Math.sin(p.h), ny = Math.cos(p.h);
      pts.push(new THREE.Vector3(p.x - (RIDE - 0.05) * nx, p.y - (RIDE - 0.05) * ny, z));
    }
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, 0.09, 6, false), new THREE.MeshBasicMaterial({ color: i ? 0xff3fa4 : 0x3ff0ff }));
    scene.add(tube);
  });
  const l1 = new THREE.PointLight(0x3ff0ff, 1.1, 60); l1.position.set(-6, 8, 8); scene.add(l1);
  const l2 = new THREE.PointLight(0xff3fa4, 1.0, 70); l2.position.set(10, 30, 10); scene.add(l2);
})();

/* --- car --- */
const car = new THREE.Group();
const wheels = [];
const plumes = [];
const PORTS = [[1.25, 0.62], [1.25, -0.62], [-1.2, 0.62], [-1.2, -0.62]];
const thrustLight = new THREE.PointLight(0x4aa8ff, 0, 14);
const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe6ecf7, metalness: 0.45, roughness: 0.3 });
(function buildCar() {
  const b = new THREE.Shape();
  b.moveTo(-2.28, -0.3); b.lineTo(2.1, -0.3);
  b.quadraticCurveTo(2.38, -0.28, 2.34, -0.04);
  b.quadraticCurveTo(2.3, 0.12, 1.4, 0.26);
  b.lineTo(0.7, 0.36); b.lineTo(-1.7, 0.4);
  b.quadraticCurveTo(-2.3, 0.36, -2.34, 0.0);
  b.quadraticCurveTo(-2.34, -0.28, -2.28, -0.3);
  const bg = new THREE.ExtrudeGeometry(b, { depth: 1.5, bevelEnabled: true, bevelThickness: 0.14, bevelSize: 0.1, bevelSegments: 3 });
  bg.translate(0, 0, -0.75);
  car.add(new THREE.Mesh(bg, bodyMat));

  const c = new THREE.Shape();
  c.moveTo(0.85, 0.33);
  c.quadraticCurveTo(0.35, 0.78, -0.35, 0.8);
  c.quadraticCurveTo(-1.2, 0.8, -1.6, 0.4);
  c.lineTo(-1.6, 0.33);
  const cg = new THREE.ExtrudeGeometry(c, { depth: 1.1, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.06, bevelSegments: 2 });
  cg.translate(0, 0, -0.55);
  car.add(new THREE.Mesh(cg, new THREE.MeshStandardMaterial({ color: 0x0f2238, metalness: 0.9, roughness: 0.12, emissive: 0x06121e })));

  const head = new THREE.MeshBasicMaterial({ color: 0xeaffff });
  const tail = new THREE.MeshBasicMaterial({ color: 0xff2a3d });
  const acc = new THREE.MeshBasicMaterial({ color: 0x3ff0ff });
  const hb = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 1.3), head); hb.position.set(2.36, 0.0, 0); car.add(hb);
  const tb = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 1.5), tail); tb.position.set(-2.4, 0.16, 0); car.add(tb);
  [-1, 1].forEach((sz) => {
    const st = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.05, 0.02), acc); st.position.set(0, -0.2, sz * 0.9); car.add(st);
  });

  const tyre = new THREE.MeshStandardMaterial({ color: 0x0c0d12, roughness: 0.8 });
  const rim = new THREE.MeshStandardMaterial({ color: 0x9fb0cc, metalness: 0.8, roughness: 0.3 });
  [[1.45, 1], [1.45, -1], [-1.4, 1], [-1.4, -1]].forEach(([x, sz]) => {
    const w = new THREE.Group();
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.3, 20), tyre); t.rotation.x = Math.PI / 2; w.add(t);
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.32, 5), rim); r.rotation.x = Math.PI / 2; w.add(r);
    w.position.set(x, -0.2, sz * 0.86);
    car.add(w); wheels.push(w);
  });

  const portMat = new THREE.MeshStandardMaterial({ color: 0x1b2233, metalness: 0.8, roughness: 0.4, emissive: 0x0a1a33 });
  const coneGeo = new THREE.ConeGeometry(0.2, 1, 14, 1, true); coneGeo.translate(0, -0.5, 0);
  const coreGeo = new THREE.ConeGeometry(0.1, 1, 10, 1, true); coreGeo.translate(0, -0.5, 0);
  const outer = new THREE.MeshBasicMaterial({ color: 0x2f8bff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const core = new THREE.MeshBasicMaterial({ color: 0xd8eeff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  PORTS.forEach(([x, z]) => {
    const port = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.08, 12), portMat);
    port.position.set(x, -0.32, z); car.add(port);
    const grp = new THREE.Group(); grp.position.set(x, -0.34, z); grp.visible = false;
    grp.add(new THREE.Mesh(coneGeo, outer), new THREE.Mesh(coreGeo, core));
    car.add(grp); plumes.push(grp);
  });

  const headL = new THREE.PointLight(0xbfe9ff, 0.9, 26); headL.position.set(4, 0.5, 0); car.add(headL);
  const under = new THREE.PointLight(0x3ff0ff, 0.9, 9); under.position.set(0, -0.7, 0); car.add(under);
  thrustLight.position.set(0, -1.4, 0); car.add(thrustLight);
})();
scene.add(car);
const BODY_PTS = [[1.45, -0.54], [-1.4, -0.54], [2.34, -0.1], [-2.34, -0.1], [0.3, 0.8], [-0.9, 0.8]];

/* --- rings --- */
const rings = [];
const ringGeo = new THREE.TorusGeometry(RING_R, 0.2, 12, 44);
const ringGlowGeo = new THREE.TorusGeometry(RING_R, 0.65, 8, 44);
function clearRings() {
  rings.forEach((r) => scene.remove(r.obj));
  rings.length = 0;
}
function spawnRings() {
  clearRings();
  const e = simulateRampExit(run.rampSpeed);
  const Tl = (e.vy + Math.sqrt(e.vy * e.vy + 2 * G * (e.y - RIDE))) / G;
  for (let i = 0; i < RING_COUNT; i++) {
    const t = Tl * (0.1 + 0.78 * i / (RING_COUNT - 1));
    const x = e.x + e.vx * t, y = Math.max(5.5, e.y + e.vy * t - 0.5 * G * t * t);
    const obj = new THREE.Group();
    const core = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x3ff0ff, transparent: true }));
    const halo = new THREE.Mesh(ringGlowGeo, new THREE.MeshBasicMaterial({ color: 0x2f8bff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
    obj.add(core, halo);
    obj.position.set(x, y, 0);
    scene.add(obj);
    rings.push({ obj, core, halo, x, y, got: false, t: 0, ph: i * 0.7 });
  }
}

/* --- particles --- */
const PN_MAX = 260;
const parts = [];
const partGeo = new THREE.BoxGeometry(1, 1, 1);
for (let i = 0; i < PN_MAX; i++) {
  const m = new THREE.Mesh(partGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
  m.visible = false; scene.add(m);
  parts.push({ m, vx: 0, vy: 0, vz: 0, life: 0, max: 1, g: 0, size: 1, spin: 0, shrink: true });
}
let partIdx = 0;
function spawn(x, y, z, vx, vy, vz, life, color, size, grav, additive, spin) {
  const p = parts[partIdx]; partIdx = (partIdx + 1) % PN_MAX;
  p.m.position.set(x, y, z); p.vx = vx; p.vy = vy; p.vz = vz;
  p.life = p.max = life; p.g = grav; p.size = size; p.spin = spin || 0;
  p.m.material.color.setHex(color);
  p.m.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
  p.m.scale.setScalar(size); p.m.visible = true;
  p.m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
}
function updateParts(dt) {
  for (const p of parts) {
    if (!p.m.visible) continue;
    p.life -= dt;
    if (p.life <= 0) { p.m.visible = false; continue; }
    p.vy -= G * p.g * dt;
    p.m.position.x += p.vx * dt; p.m.position.y += p.vy * dt; p.m.position.z += p.vz * dt;
    if (p.m.position.y < 0.1 && p.g > 0) { p.m.position.y = 0.1; p.vy *= -0.35; p.vx *= 0.8; p.vz *= 0.8; }
    const k = p.life / p.max;
    p.m.material.opacity = Math.min(1, k * 1.6);
    p.m.scale.setScalar(p.size * (p.g > 0.3 ? 1 : (0.4 + k)));
    if (p.spin) { p.m.rotation.x += p.spin * dt; p.m.rotation.y += p.spin * dt * 0.7; }
  }
}
const boomLight = new THREE.PointLight(0xff8a3a, 0, 70);
scene.add(boomLight);
let boomT = 0;

function explode() {
  const x = run.x, y = run.y;
  for (let i = 0; i < 70; i++) {
    const a = Math.random() * Math.PI * 2, sp = rand(4, 26);
    spawn(x, y, rand(-1, 1), Math.cos(a) * sp, Math.sin(a) * sp + 4, rand(-8, 8), rand(0.5, 1.4), Math.random() < 0.5 ? 0xff8a1f : 0xffd24a, rand(0.5, 1.6), 0, true);
  }
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2, sp = rand(2, 10);
    spawn(x, y, rand(-1, 1), Math.cos(a) * sp, Math.sin(a) * sp + 3, rand(-4, 4), rand(1.2, 2.4), 0x1b1d26, rand(1.2, 2.6), -0.05, false);
  }
  for (let i = 0; i < 34; i++) {
    const a = Math.random() * Math.PI * 2, sp = rand(6, 22);
    spawn(x, y, rand(-1, 1), Math.cos(a) * sp, Math.sin(a) * sp + 8, rand(-8, 8), rand(2.5, 4.5), Math.random() < 0.5 ? 0xe6ecf7 : 0x2a3350, rand(0.2, 0.6), 1, false, rand(-8, 8));
  }
  boomT = 1; shake = 1;
}

/* ===================================================================
 * Audio (tiny WebAudio synth, created on first gesture)
 * =================================================================== */
let AC = null, master = null, muted = false, whine = null, hiss = null, noiseBuf = null;
function audio() {
  if (!AC) {
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      master = AC.createGain(); master.gain.value = muted ? 0 : 0.5; master.connect(AC.destination);
      noiseBuf = AC.createBuffer(1, AC.sampleRate * 2, AC.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const w = AC.createOscillator(); w.type = 'sawtooth'; w.frequency.value = 90;
      const wl = AC.createBiquadFilter(); wl.type = 'lowpass'; wl.frequency.value = 900;
      const wg = AC.createGain(); wg.gain.value = 0;
      w.connect(wl); wl.connect(wg); wg.connect(master); w.start();
      whine = { osc: w, gain: wg };
      const hs = AC.createBufferSource(); hs.buffer = noiseBuf; hs.loop = true;
      const hf = AC.createBiquadFilter(); hf.type = 'bandpass'; hf.frequency.value = 1800; hf.Q.value = 0.7;
      const hg = AC.createGain(); hg.gain.value = 0;
      hs.connect(hf); hf.connect(hg); hg.connect(master); hs.start();
      hiss = { gain: hg };
    } catch (e) { AC = null; }
  }
  if (AC && AC.state === 'suspended') AC.resume();
  return AC;
}
function tone(f, d, type, vol, slideTo) {
  if (!audio()) return;
  const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain();
  o.type = type || 'sine'; o.frequency.setValueAtTime(f, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + d);
  g.gain.setValueAtTime(vol || 0.2, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + d + 0.02);
}
function burst(d, vol, freq) {
  if (!audio()) return;
  const t = AC.currentTime, s = AC.createBufferSource(); s.buffer = noiseBuf;
  const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(freq, t); f.frequency.exponentialRampToValueAtTime(80, t + d);
  const g = AC.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  s.connect(f); f.connect(g); g.connect(master); s.start(t, Math.random()); s.stop(t + d + 0.05);
}
function setMuted(m) {
  muted = m; $('muteBtn').innerHTML = m ? '&#128263;' : '&#128266;';
  if (master) master.gain.value = m ? 0 : 0.5;
}

/* ===================================================================
 * HUD helpers
 * =================================================================== */
const el = {
  hud: $('hud'), speed: $('hSpeed'), alt: $('hAlt'), score: $('hScore'), gas: $('hGas'),
  lights: $('lights'), msg: $('msg'), air: $('airInfo'), tilt: $('hTilt'), tiltIcon: $('tiltIcon'),
  sink: $('hSink'), flips: $('hFlips'), rings: $('hRings'),
  title: $('title'), results: $('results')
};
const lamps = Array.from(el.lights.querySelectorAll('.lamp'));
let msgUntil = 0;
function showMsg(html, ms, cls) {
  el.msg.innerHTML = html; el.msg.className = 'msg on ' + (cls || '');
  msgUntil = performance.now() + ms;
}
function liveScore() {
  return run.rings * 500 + run.flips * 1500 + Math.round(run.maxAlt * FT * 5);
}

/* ===================================================================
 * State transitions
 * =================================================================== */
function startCountdown() {
  resetRun();
  clearRings();
  car.visible = true;
  state = 'count';
  count.t = 0; count.hold = rand(0.8, 2.2); count.green = false; count.lockUntil = 0;
  lamps.forEach((l) => (l.className = 'lamp'));
  el.title.hidden = true; el.results.hidden = true;
  el.hud.hidden = false; el.lights.hidden = false; el.air.hidden = true;
  showMsg('Get ready', 1500);
  snapCam = true;
  inputGuard = performance.now() + 250;
  audio();
}

function falseStart() {
  count.lockUntil = performance.now() + 400;
  showMsg('Too early, wait for green', 1300, 'bad');
  el.lights.classList.remove('shake'); void el.lights.offsetWidth; el.lights.classList.add('shake');
  tone(170, 0.28, 'square', 0.22);
}

function launch(reaction) {
  run.reaction = Math.max(0, reaction);
  run.rampMph = clamp(90 - 5 * run.reaction, 76, 90);
  run.rampSpeed = run.rampMph * MPH;
  run.accel = run.rampSpeed * run.rampSpeed / (2 * Math.abs(ROAD_START));
  run.v = 0;
  spawnRings();
  el.lights.hidden = true;
  state = 'drive';
  showMsg('GO!', 900, 'good');
  tone(660, 0.18, 'triangle', 0.25, 990);
}

function enterRamp() {
  state = 'ramp';
  run.s = 0; run.v = run.rampSpeed;
  showMsg('Hold on!', 900);
}

function enterAir() {
  const p = pathAt(PATH_LEN);
  const h = p.h, v = Math.max(run.v, 4);
  run.x = p.x; run.y = p.y; run.angle = h;
  run.vx = v * Math.cos(h); run.vy = v * Math.sin(h);
  run.omega = SPIN_CARRY * v / R2;
  run.inv = false;
  state = 'air';
  el.air.hidden = false;
  showMsg('Airborne<small>&larr; &rarr; rotate &middot; hold Space for thrusters</small>', 2600);
}

function touchdown() {
  const sink = Math.max(0, -run.vy) * FT;
  const tilt = Math.abs(wrapPi(run.angle)) * 180 / Math.PI;
  run.touchdown = sink; run.landTilt = tilt;
  run.peakG = Math.max(run.peakG, 1 + (sink / FT) / 0.3 / G);
  run.thrusting = false;
  if (sink <= SINK_LIMIT && tilt <= TILT_LIMIT) land(sink); else crash(sink, tilt);
}

function land(sink) {
  state = 'landed'; run.landed = true; landT = 0;
  run.vy = 0;
  burst(0.3, 0.5, 1200); tone(90, 0.25, 'sine', 0.4, 50);
  for (let i = 0; i < 24; i++) {
    spawn(run.x + rand(-1.5, 1.5), 0.2, rand(-0.8, 0.8), rand(-8, 8), rand(2, 9), rand(-3, 3), rand(0.3, 0.7), 0xffc860, 0.12, 1, true);
  }
  shake = Math.max(shake, 0.25);
  showMsg('Smooth landing!', 1800, 'good');
}

function crash(sink, tilt) {
  state = 'crashed'; run.landed = false; crashT = 0;
  car.visible = false;
  el.air.hidden = true;
  explode();
  burst(1.4, 0.9, 2400); tone(70, 0.6, 'sawtooth', 0.35, 28);
  const why = tilt > TILT_LIMIT ? 'Not upright' : 'Too fast';
  showMsg('CRASH<small>' + why + ' &middot; ' + sink.toFixed(0) + ' ft/s, ' + tilt.toFixed(0) + '&deg; tilt</small>', 2200, 'bad');
}

function finalScore() {
  const base = liveScore();
  if (run.landed) {
    const bonus = Math.round(run.airtime * 100 + Math.max(0, SINK_LIMIT - run.touchdown) * 40);
    return base + bonus;
  }
  return Math.round(base * 0.5);
}

function gradeFor(score) {
  if (!run.landed) return 'F';
  return score >= 12000 ? 'S' : score >= 9000 ? 'A' : score >= 6000 ? 'B' : score >= 3500 ? 'C' : 'D';
}

function showResults() {
  state = 'results';
  resultsAt = performance.now();
  run.score = finalScore();
  const isBest = run.score > best;
  if (isBest) {
    best = run.score;
    try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) { /* storage unavailable */ }
  }
  const g = gradeFor(run.score);
  $('rGrade').textContent = g; $('rGrade').className = 'grade g-' + g;
  $('rOutcome').textContent = run.landed ? 'Smooth landing' : 'Crashed';
  $('rScore').textContent = run.score.toLocaleString();
  $('rBadge').hidden = !isBest;
  $('rBest').textContent = best.toLocaleString();
  $('rReact').textContent = run.reaction.toFixed(2) + ' s';
  $('rRamp').textContent = run.rampMph.toFixed(0) + ' mph';
  $('rG').textContent = run.peakG.toFixed(1) + ' G';
  $('rAlt').textContent = Math.round(run.maxAlt * FT) + ' ft';
  $('rAir').textContent = run.airtime.toFixed(1) + ' s';
  $('rFlips').textContent = run.flips;
  $('rRings').textContent = run.rings + ' / ' + RING_COUNT;
  $('rTouch').textContent = run.touchdown.toFixed(0) + ' ft/s';
  $('titleBest').textContent = best.toLocaleString();
  el.results.hidden = false;
  el.lights.hidden = true;
}

/* ===================================================================
 * Input
 * =================================================================== */
function handlePress() {
  const now = performance.now();
  if (now < inputGuard) return;
  if (state === 'title') { startCountdown(); return; }
  if (state === 'count') {
    if (now < count.lockUntil) return;               // input lock after a false start
    if (!count.green) { falseStart(); return; }      // never launches before green
    launch((now - count.greenAt) / 1000);
  }
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) {
      if (state === 'results' && performance.now() - resultsAt > 600) startCountdown();
      else handlePress();
    }
    keys.space = true;
  } else if (e.code === 'ArrowLeft') { e.preventDefault(); keys.left = true; }
  else if (e.code === 'ArrowRight') { e.preventDefault(); keys.right = true; }
  else if (e.code === 'Enter') {
    if (state === 'results' && performance.now() - resultsAt > 600) startCountdown();
    else if (state === 'title') startCountdown();
  } else if (e.code === 'KeyM') setMuted(!muted);
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { e.preventDefault(); keys.space = false; }
  else if (e.code === 'ArrowLeft') keys.left = false;
  else if (e.code === 'ArrowRight') keys.right = false;
});
window.addEventListener('blur', () => { keys.left = keys.right = keys.space = false; });

$('stage').addEventListener('pointerdown', (e) => {
  if (e.target.closest('.overlay, button')) return;
  audio();
  handlePress(); keys.space = true;
});
window.addEventListener('pointerup', () => { keys.space = false; });
window.addEventListener('pointercancel', () => { keys.space = false; keys.left = keys.right = false; });
el.title.addEventListener('pointerdown', (e) => { e.stopPropagation(); startCountdown(); });
$('againBtn').addEventListener('click', (e) => { e.currentTarget.blur(); startCountdown(); });
$('muteBtn').addEventListener('click', (e) => { e.currentTarget.blur(); audio(); setMuted(!muted); });
$('muteBtn').addEventListener('pointerdown', (e) => e.stopPropagation());
function holdBtn(id, key) {
  const b = $(id);
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); audio(); keys[key] = true; b.classList.add('down'); if (key === 'space') handlePress(); });
  const up = () => { keys[key] = false; b.classList.remove('down'); };
  b.addEventListener('pointerup', up); b.addEventListener('pointerleave', up); b.addEventListener('pointercancel', up);
}
holdBtn('tLeft', 'left'); holdBtn('tRight', 'right'); holdBtn('tThrust', 'space');
window.addEventListener('contextmenu', (e) => e.preventDefault());

/* ===================================================================
 * Physics – fixed 1/120 s step
 * =================================================================== */
function stepDrive(dt) {
  run.v += run.accel * dt;
  run.x += run.v * dt;
  run.y = RIDE; run.angle = 0;
  run.peakG = Math.max(run.peakG, Math.hypot(1, run.accel / G));
  if (run.x >= 0) enterRamp();
}

function stepRamp(dt) {
  let p = pathAt(run.s);
  run.v -= G * Math.sin(p.h) * dt;
  if (run.v < 2) run.v = 2;
  run.s += run.v * dt;
  p = pathAt(run.s);
  const normal = (p.r > 0 ? run.v * run.v / p.r : 0) + G * Math.cos(p.h);
  run.peakG = Math.max(run.peakG, normal / G);
  run.x = p.x; run.y = p.y; run.angle = p.h;
  if (run.s >= PATH_LEN) enterAir();
}

function stepAir(dt) {
  const sa = Math.sin(run.angle), ca = Math.cos(run.angle);
  let ax = 0, ay = -G;
  run.thrusting = keys.space && run.gas > 0;
  if (run.thrusting) {
    // plume leaves along the car's down axis; the reaction pushes the car up its own axis
    ax += -sa * THRUST; ay += ca * THRUST;
    run.gas = Math.max(0, run.gas - GAS_DRAIN * dt);
    run.peakG = Math.max(run.peakG, THRUST / G);
  }
  run.vx += ax * dt; run.vy += ay * dt;
  run.x += run.vx * dt; run.y += run.vy * dt;

  const input = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
  run.omega = clamp(run.omega + (input * SPIN_ACC - SPIN_DAMP * run.omega) * dt, -6, 6);
  run.angle += run.omega * dt;

  run.airtime += dt;
  run.maxAlt = Math.max(run.maxAlt, run.y - RIDE);

  // flips: each time the car goes upside down (hysteresis avoids double counts)
  const upY = Math.cos(run.angle);
  if (!run.inv && upY < -0.7) { run.inv = true; run.flips++; tone(520, 0.12, 'triangle', 0.18, 780); showMsg('Flip x' + run.flips + '<small>+1500</small>', 900, 'ring'); }
  else if (run.inv && upY > 0.3) run.inv = false;

  // rings
  for (const r of rings) {
    if (r.got) continue;
    if (Math.hypot(run.x - r.x, run.y - r.y) < RING_R + 0.9) {
      r.got = true; r.t = 0; run.rings++;
      run.gas = Math.min(1, run.gas + RING_REFILL);
      tone(880, 0.2, 'sine', 0.25, 1760);
      showMsg('+500<small>gas +35%</small>', 700, 'ring');
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * Math.PI * 2, sp = rand(4, 14);
        spawn(r.x, r.y, 0, Math.cos(a) * sp, Math.sin(a) * sp, rand(-4, 4), rand(0.4, 0.8), 0x7ff6ff, 0.22, 0, true);
      }
    }
  }

  // ramp collision (landing back on the face of the quarter-pipe or hitting the wall)
  if (run.x > 0) {
    const arcY = run.x <= R1 ? RIDE + R1 - Math.sqrt(Math.max(0, R1 * R1 - run.x * run.x)) : 99;
    if (run.y < arcY + 0.4 && run.y < 40) { run.touchdown = Math.max(0, -run.vy) * FT; run.landTilt = Math.abs(wrapPi(run.angle)) * 180 / Math.PI; crash(run.touchdown, run.landTilt); return; }
  }

  // ground
  let minY = Infinity;
  for (const [px, py] of BODY_PTS) minY = Math.min(minY, run.y + px * sa + py * ca);
  if (minY <= 0 && run.vy < 0) touchdown();
}

function stepLanded(dt) {
  landT += dt;
  run.angle *= Math.exp(-14 * dt);
  run.y += (RIDE - run.y) * Math.min(1, dt * 22);
  const dec = 14 * dt;
  run.vx = Math.abs(run.vx) <= dec ? 0 : run.vx - Math.sign(run.vx) * dec;
  run.x += run.vx * dt;
  run.v = Math.abs(run.vx);
  if (landT > 1.9) showResults();
}

function fixedStep(dt) {
  switch (state) {
    case 'drive': stepDrive(dt); break;
    case 'ramp': stepRamp(dt); break;
    case 'air': stepAir(dt); break;
    case 'landed': stepLanded(dt); break;
    case 'crashed': crashT += dt; if (crashT > 2.4) showResults(); break;
    default: break;
  }
}

/* ===================================================================
 * Per-frame update: start lights, car pose, camera, HUD
 * =================================================================== */
function updateCount(dt) {
  count.t += dt;
  const lit = clamp(Math.floor(count.t / 0.6), 0, 4);
  const greenAtT = 2.4 + count.hold;
  lamps.forEach((l, i) => { l.className = 'lamp' + (i < lit ? ' red' : ''); });
  if (!count.green && count.t >= greenAtT) {
    count.green = true; count.greenAt = performance.now();
    showMsg('GO!', 3000, 'good');
    tone(880, 0.12, 'triangle', 0.18);
  }
  if (count.green) lamps[3].className = 'lamp green';
  if (count.green && performance.now() - count.greenAt > 3000) launch(3);
}

const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
const tgtPos = new THREE.Vector3(), tgtLook = new THREE.Vector3();
function updateCamera(dt, now) {
  const asp = camera.aspect, wide = Math.max(1, Math.pow(1.3 / asp, 0.8));
  const x0 = ROAD_START;
  let rate = 3.5;
  switch (state) {
    case 'title':
      titleT += dt;
      tgtPos.set(x0 + 6.5 + 2.5 * Math.sin(titleT * 0.35), 1.7 + 0.4 * Math.sin(titleT * 0.23), 8 + 2 * Math.cos(titleT * 0.3));
      tgtLook.set(x0 - 0.3, 0.7, 0); break;
    case 'count':
      tgtPos.set(x0 + 4.6, 1.5, 7.5); tgtLook.set(x0 + 0.4, 0.8, 0); break;
    case 'drive': {
      const t = clamp((run.x + 60) / 60, 0, 1), e = t * t * (3 - 2 * t);
      tgtPos.set(lerp(run.x + 3, 6, e), lerp(2.4, 19, e), lerp(14 + run.v * 0.1, 56 * wide, e));
      tgtLook.set(lerp(run.x + 5.5, 6, e), lerp(1.6, 19, e), 0); rate = 3; break;
    }
    case 'ramp':
      tgtPos.set(6, 19, 56 * wide); tgtLook.set(6, 19, 0); rate = 3; break;
    case 'air': {
      const d = clamp(36 + run.y * 0.95, 40, 100) * wide;
      tgtPos.set(run.x, run.y * 0.5 + 8, d); tgtLook.set(run.x, run.y * 0.5 + 3, 0); rate = 6; break;
    }
    case 'landed':
      tgtPos.set(run.x + 10, 3.4, 18 * wide); tgtLook.set(run.x, 1.4, 0); rate = 3; break;
    case 'crashed':
      tgtPos.set(run.x, Math.max(run.y * 0.5, 4) + 5, 34 * wide); tgtLook.set(run.x, Math.max(run.y * 0.5, 2), 0); rate = 2; break;
    default: break;
  }
  if (snapCam) { camPos.copy(tgtPos); camLook.copy(tgtLook); snapCam = false; }
  const k = 1 - Math.exp(-rate * dt);
  camPos.lerp(tgtPos, k); camLook.lerp(tgtLook, k);
  shake = Math.max(0, shake - dt * 1.4);
  const s = shake * shake * 1.2;
  camera.position.set(camPos.x + rand(-s, s), camPos.y + rand(-s, s), camPos.z);
  camera.lookAt(camLook);
}

function frameUpdate(dt) {
  const now = performance.now();

  if (state === 'count') updateCount(dt);
  if (state === 'crashed' || state === 'landed' || state === 'air') {
    // nothing extra
  }
  if (now > msgUntil) el.msg.classList.remove('on');

  // car pose
  car.position.set(run.x, run.y, 0);
  car.rotation.z = run.angle;
  let spinV = state === 'air' ? run.v * 0.6 : (state === 'landed' ? run.vx : run.v);
  if (state === 'air') spinV = Math.hypot(run.vx, run.vy) * 0.3;
  run.wheelSpin -= spinV * dt / 0.34;
  wheels.forEach((w) => { w.rotation.z = run.wheelSpin; });

  // plumes
  const on = state === 'air' && run.thrusting;
  plumes.forEach((p) => {
    p.visible = on;
    if (on) { const f = 1.7 + Math.random() * 0.9; p.scale.set(0.85 + Math.random() * 0.3, f, 0.85 + Math.random() * 0.3); }
  });
  thrustLight.intensity = on ? 1.6 + Math.random() * 0.6 : 0;
  if (on) {
    const sa = Math.sin(run.angle), ca = Math.cos(run.angle);
    for (const [px, pz] of PORTS) {
      if (Math.random() < 0.5) {
        const wx = run.x + px * ca + 0.34 * sa, wy = run.y + px * sa - 0.34 * ca;
        spawn(wx, wy, pz, sa * 12 + rand(-1, 1), -ca * 12 + rand(-1, 1), rand(-0.5, 0.5), 0.35, 0x7ec0ff, 0.14, 0, true);
      }
    }
  }
  if (hiss) hiss.gain.gain.setTargetAtTime(on ? 0.22 : 0, AC.currentTime, 0.04);
  if (whine) {
    const driving = state === 'drive' || state === 'ramp';
    const v = state === 'drive' || state === 'ramp' ? run.v : 0;
    whine.gain.gain.setTargetAtTime(driving ? 0.05 : 0, AC.currentTime, 0.08);
    whine.osc.frequency.setTargetAtTime(90 + v * 9, AC.currentTime, 0.05);
  }

  // rings
  for (const r of rings) {
    if (!r.got) {
      const pulse = 1 + 0.06 * Math.sin(now * 0.006 + r.ph);
      r.obj.scale.setScalar(pulse);
      r.core.material.color.setHex(Math.sin(now * 0.005 + r.ph) > 0 ? 0x3ff0ff : 0x9ffaff);
    } else {
      r.t += dt;
      const k = Math.min(1, r.t / 0.45);
      r.obj.scale.setScalar(1 + k * 1.2);
      r.core.material.opacity = 1 - k; r.halo.material.opacity = 0.22 * (1 - k);
      r.obj.visible = k < 1;
    }
  }

  // explosion light
  if (boomT > 0) { boomT = Math.max(0, boomT - dt * 1.6); boomLight.position.set(run.x, run.y + 2, 6); boomLight.intensity = boomT * 4; }
  else boomLight.intensity = 0;

  updateParts(dt);
  updateCamera(dt, now);

  // HUD
  let speed = 0;
  if (state === 'drive' || state === 'ramp') speed = run.v;
  else if (state === 'air') speed = Math.hypot(run.vx, run.vy);
  else if (state === 'landed') speed = Math.abs(run.vx);
  el.speed.textContent = Math.round(speed / MPH);
  el.alt.textContent = Math.round(Math.max(0, run.y - RIDE) * FT);
  el.score.textContent = liveScore().toLocaleString();
  el.gas.style.width = (run.gas * 100).toFixed(1) + '%';
  el.gas.className = run.gas < 0.2 ? 'low' : '';
  if (state === 'air') {
    const tilt = wrapPi(run.angle) * 180 / Math.PI, sink = -run.vy * FT;
    el.tilt.textContent = Math.abs(tilt).toFixed(0) + '°';
    el.tiltIcon.style.transform = 'rotate(' + (-tilt).toFixed(1) + 'deg)';
    const tOk = Math.abs(tilt) <= TILT_LIMIT, sOk = sink <= SINK_LIMIT;
    el.tilt.parentNode.className = 'readout ' + (tOk ? 'ok' : 'bad');
    el.tiltIcon.style.color = tOk ? '' : 'var(--red)';
    el.sink.textContent = sink > 0 ? sink.toFixed(0) : 'up';
    el.sink.parentNode.className = 'readout ' + (sOk ? 'ok' : 'bad');
    el.flips.textContent = run.flips;
    el.rings.textContent = run.rings + '/' + RING_COUNT;
  }
}

/* ===================================================================
 * Main loop
 * =================================================================== */
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

let last = performance.now(), acc = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (t - last) / 1000)); last = t;
  acc += dt;
  let n = 0;
  while (acc >= STEP && n < 24) { fixedStep(STEP); acc -= STEP; n++; }
  if (n >= 24) acc = 0;
  frameUpdate(dt);
  renderer.render(scene, camera);
}
$('titleBest').textContent = best.toLocaleString();
requestAnimationFrame(frame);

/* Debug / test hook */
window.RL = {
  get state() { return state; }, run, keys, count, press: handlePress, start: startCountdown,
  sim(seconds) { const n = Math.round(seconds / STEP); for (let i = 0; i < n; i++) fixedStep(STEP); },
  frame(dt) { frameUpdate(dt); }
};
})();
