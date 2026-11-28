/**
 * line3d.js — ภาพ 3D สายพานเครื่องชั่ง (checkweigher) ที่ถุงวิ่งตามข้อมูลจริง
 *
 *   สายพานเข้า → สายพานชั่ง (จอแสดงน้ำหนัก + ไฟสัญญาณ) → สายพานออก (แขนผลักถุงหลุดสเปกลงถังคัดออก)
 *   ถุง 1 ใบ = 1 แถวจาก /api/weights ของเครื่องที่เลือก — สีตามโซนเดียวกับหน้า Dashboard
 *
 * ใช้ three.js ที่เก็บไว้ในโปรเจกต์ (assets/vendor/three) จึงไม่ต้องต่ออินเทอร์เน็ต
 * ถ้ามีไฟล์ assets/models/pouch.glb (เช่น "Sealed Food Pouch" โดย firstprospect, CC BY 4.0)
 * ระบบจะใช้แทนถุงแบบจำลองอย่างง่ายโดยอัตโนมัติ
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const T_ = (s) => (typeof window.t === 'function' ? window.t(String(s)) : String(s));
const $ = (id) => document.getElementById(id);

// ================= ข้อมูล / backend =================
const API_BASE = new URLSearchParams(location.search).get('api') || '';
let SCALE_ID = (() => { const n = Number.parseInt(new URLSearchParams(location.search).get('scale'), 10); return Number.isFinite(n) ? n : null; })();
const scaleQS = () => (SCALE_ID != null ? `&scaleId=${SCALE_ID}` : '');
const POLL_MS = 1000, STATUS_MS = 5000, STAT_N = 200, RECENT_N = 10;

const SPEC = { LSL: 80.5, TARGET: 82, USL: 85 };
let ZONE = { yellowPct: 60, redPct: 85 };
const ZC = { GREEN: '#0E9466', YELLOW: '#E3A008', RED: '#F0602B', OUT: '#D23A31', NONE: '#9AA6B8' };

async function api(path) {
  const res = await fetch(API_BASE + path, { cache: 'no-store', headers: { accept: 'application/json' } });
  let payload = null;
  try { payload = await res.json(); } catch (e) { /* ไม่ใช่ JSON */ }
  if (!res.ok) throw new Error((payload && payload.error) || `HTTP ${res.status}`);
  return payload || {};
}
/** โซนของน้ำหนัก (เหมือนหน้า Dashboard): GREEN | YELLOW | RED | OUT */
function zoneOf(v) {
  if (v > SPEC.USL || v < SPEC.LSL) return 'OUT';
  const d = v - SPEC.TARGET, lim = d >= 0 ? SPEC.USL - SPEC.TARGET : SPEC.TARGET - SPEC.LSL;
  if (!(lim > 0)) return 'GREEN';
  const r = Math.abs(d) / lim * 100;
  return r >= ZONE.redPct ? 'RED' : r >= ZONE.yellowPct ? 'YELLOW' : 'GREEN';
}
const fmt1 = (v) => Number(v).toFixed(1);
const fmtN = (v) => Number(v).toLocaleString('en-US');

// ================= ฉาก =================
const stage = $('l3Stage'), canvas = $('l3Canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const MAX_ANISO = renderer.capabilities.getMaxAnisotropy();

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.inset = '0';
$('l3Labels').appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.05, 80);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 0.8;
controls.maxDistance = 14;

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a94a6, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 2.1);
sun.position.set(-3, 7, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 4, bottom: -4, near: 1, far: 20 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);

// ---- ขนาด (หน่วยเมตร) ----
const BELT_Y = 0.80, BELT_W = 0.42;
const SEGS = [[-3.9, -1.04], [-0.96, 0.96], [1.04, 4.3]]; // เข้า / ชั่ง / ออก
const X_SPAWN = -3.72, X_WEIGH = 0, X_REJECT = 2.35, X_END = 4.22;
const GAP = 0.42;                                    // ระยะห่างระหว่างถุงตอนเครื่องเดินปกติ
const BIN = { x: X_REJECT, z: BELT_W / 2 + 0.36, floor: 0.2, top: 0.6, w: 0.56, d: 0.46 };

// ---- วัสดุ ----
const M = {
  steel: new THREE.MeshStandardMaterial({ color: 0xc8d0da, metalness: 0.85, roughness: 0.3 }),
  steelDark: new THREE.MeshStandardMaterial({ color: 0x8b96a6, metalness: 0.8, roughness: 0.42 }),
  roller: new THREE.MeshStandardMaterial({ color: 0xaab4c2, metalness: 0.9, roughness: 0.25 }),
  frameBlue: new THREE.MeshStandardMaterial({ color: 0x1d4ed8, metalness: 0.2, roughness: 0.45 }),
  black: new THREE.MeshStandardMaterial({ color: 0x1b212b, metalness: 0.2, roughness: 0.7 }),
  acrylic: new THREE.MeshPhysicalMaterial({ color: 0xe6eeff, metalness: 0, roughness: 0.06, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
  red: new THREE.MeshStandardMaterial({ color: 0xd23a31, metalness: 0.15, roughness: 0.55 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.95 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xf2b705, roughness: 0.6 }),
};

/** ลายสายพาน (ร่องขวาง) — เลื่อน offset ตามความเร็วสายพานทุกเฟรม */
function beltTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#2b313c'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#3b4352'; g.fillRect(0, 0, 10, 64);
  g.fillStyle = '#232831'; g.fillRect(10, 0, 3, 64);
  const tx = new THREE.CanvasTexture(c);
  tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
  tx.colorSpace = THREE.SRGBColorSpace;
  tx.anisotropy = MAX_ANISO;
  return tx;
}
const RIB = 0.09; // ระยะร่องสายพาน (ม.)
const beltTextures = [];

function box(w, h, d, mat, x, y, z, parent, shadow = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = shadow; m.receiveShadow = true;
  (parent || scene).add(m);
  return m;
}
function cyl(r, h, mat, parent, seg = 24) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
  m.castShadow = true; m.receiveShadow = true;
  (parent || scene).add(m);
  return m;
}

/** สายพาน 1 ช่วง: ผิวสายพาน + ลูกกลิ้งหัวท้าย + โครงข้าง + ขา */
function conveyor(x0, x1, frameMat, legs = true) {
  const len = x1 - x0, cx = (x0 + x1) / 2;
  const tex = beltTexture(); tex.repeat.set(len / RIB, 1);
  beltTextures.push(tex);
  const beltMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 });
  box(len, 0.012, BELT_W, beltMat, cx, BELT_Y - 0.006, 0).castShadow = false;
  box(len - 0.04, 0.05, BELT_W - 0.02, M.rubber, cx, BELT_Y - 0.04, 0);
  for (const x of [x0 + 0.02, x1 - 0.02]) {
    const r = cyl(0.03, BELT_W + 0.02, M.roller); r.rotation.x = Math.PI / 2; r.position.set(x, BELT_Y - 0.032, 0);
  }
  for (const s of [-1, 1]) box(len, 0.07, 0.025, frameMat, cx, BELT_Y - 0.05, s * (BELT_W / 2 + 0.018));
  if (!legs) return;
  const lh = BELT_Y - 0.085;
  for (const x of [x0 + 0.12, x1 - 0.12]) {
    for (const s of [-1, 1]) {
      box(0.04, lh, 0.04, M.steel, x, lh / 2, s * (BELT_W / 2 - 0.02));
      const f = cyl(0.035, 0.02, M.black); f.position.set(x, 0.01, s * (BELT_W / 2 - 0.02));
    }
    box(0.035, 0.035, BELT_W - 0.04, M.steel, x, 0.22, 0);
  }
  box(len - 0.24, 0.035, 0.035, M.steel, cx, 0.22, -(BELT_W / 2 - 0.02));
}

// ---- พื้นโรงงาน ----
const floorMat = new THREE.MeshStandardMaterial({ color: 0xdfe5ee, roughness: 0.85, metalness: 0 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), floorMat);
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
const zoneMat = new THREE.MeshStandardMaterial({ color: 0xcfd8e4, roughness: 0.8 });
const zonePlane = new THREE.Mesh(new THREE.PlaneGeometry(10.2, 2.6), zoneMat);
zonePlane.rotation.x = -Math.PI / 2; zonePlane.position.set(0.25, 0.001, 0.15); zonePlane.receiveShadow = true; scene.add(zonePlane);
for (const z of [-1.15, 1.45]) { const s = new THREE.Mesh(new THREE.PlaneGeometry(10.2, 0.07), M.yellow); s.rotation.x = -Math.PI / 2; s.position.set(0.25, 0.002, z); scene.add(s); }
for (const x of [-4.85, 5.35]) { const s = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 2.67), M.yellow); s.rotation.x = -Math.PI / 2; s.position.set(x, 0.002, 0.15); scene.add(s); }

// ---- สายพาน 3 ช่วง ----
conveyor(SEGS[0][0], SEGS[0][1], M.steelDark);
conveyor(SEGS[1][0], SEGS[1][1], M.frameBlue, false);
conveyor(SEGS[2][0], SEGS[2][1], M.steelDark);
// รางกั้นข้างของสายพานเข้า
for (const s of [-1, 1]) {
  box(SEGS[0][1] - SEGS[0][0] - 0.2, 0.03, 0.012, M.steel, (SEGS[0][0] + SEGS[0][1]) / 2, BELT_Y + 0.05, s * (BELT_W / 2 + 0.005));
  for (const x of [-3.5, -2.4, -1.3]) box(0.012, 0.07, 0.012, M.steel, x, BELT_Y + 0.0, s * (BELT_W / 2 + 0.005));
}

// ---- เครื่องชั่ง: ตู้ด้านล่าง + ฝาครอบอะคริลิก + เซนเซอร์ + จอ + ไฟสัญญาณ ----
box(1.78, BELT_Y - 0.12, 0.6, M.steel, 0, (BELT_Y - 0.12) / 2, 0);
box(1.7, 0.4, 0.008, M.steelDark, 0, 0.36, 0.302, null, false);           // ฝาตู้ด้านหน้า
box(0.14, 0.03, 0.01, M.black, 0.6, 0.48, 0.308, null, false);             // มือจับ
box(0.14, 0.03, 0.01, M.black, -0.6, 0.48, 0.308, null, false);
const hood = new THREE.Group(); scene.add(hood);
box(1.84, 0.32, 0.6, M.acrylic, 0, BELT_Y + 0.17, 0, hood, false).castShadow = false;
for (const [x, z] of [[-0.92, -0.3], [0.92, -0.3], [-0.92, 0.3], [0.92, 0.3]]) box(0.025, 0.34, 0.025, M.steel, x, BELT_Y + 0.17, z, hood);
for (const z of [-0.3, 0.3]) box(1.86, 0.025, 0.025, M.steel, 0, BELT_Y + 0.335, z, hood);
for (const x of [-0.92, 0.92]) box(0.025, 0.025, 0.62, M.steel, x, BELT_Y + 0.335, 0, hood);
// เซนเซอร์ตาแมว (photo eye) ตรงทางเข้า
for (const s of [-1, 1]) box(0.04, 0.06, 0.04, M.black, -0.9, BELT_Y + 0.04, s * (BELT_W / 2 + 0.04));
const beamMat = new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.55 });
const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, BELT_W + 0.06, 6), beamMat);
beam.rotation.x = Math.PI / 2; beam.position.set(-0.9, BELT_Y + 0.04, 0); scene.add(beam);

// จอแสดงผล (HMI) บนเสา
const hmi = new THREE.Group(); hmi.position.set(-0.45, 0, -0.42); scene.add(hmi);
cyl(0.025, 1.4, M.steel, hmi).position.set(0, 0.7, 0);
cyl(0.09, 0.02, M.steelDark, hmi).position.set(0, 0.01, 0);
const scrHousing = box(0.52, 0.36, 0.06, M.black, 0, 1.52, 0, hmi);
scrHousing.rotation.x = -0.12;
const scrCanvas = document.createElement('canvas'); scrCanvas.width = 1024; scrCanvas.height = 688;
const scrTex = new THREE.CanvasTexture(scrCanvas); scrTex.colorSpace = THREE.SRGBColorSpace; scrTex.anisotropy = MAX_ANISO;
const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.322), new THREE.MeshBasicMaterial({ map: scrTex, toneMapped: false }));
screen.position.set(0, 0, 0.031); scrHousing.add(screen);
hmi.rotation.y = 0.18;

// ไฟสัญญาณ 3 สี บนฝาครอบ
const tower = new THREE.Group(); tower.position.set(0.78, BELT_Y + 0.35, -0.24); scene.add(tower);
cyl(0.012, 0.18, M.steel, tower).position.y = 0.09;
const lampDefs = [['red', 0xff3b30], ['amber', 0xffb020], ['green', 0x22c55e]];
const lamps = {};
lampDefs.forEach(([k, col], i) => {
  const mat = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.05, roughness: 0.35, transparent: true, opacity: 0.92 });
  const l = cyl(0.036, 0.062, mat, tower); l.position.y = 0.33 - i * 0.066;
  mat.userData.base = new THREE.Color(col);
  lamps[k] = mat;
});
cyl(0.038, 0.012, M.black, tower).position.y = 0.37;
cyl(0.038, 0.02, M.black, tower).position.y = 0.19;

// ---- จุดคัดออก: แขนผลัก (กระบอกลม) + ถังคัดออก ----
const pusher = new THREE.Group(); pusher.position.set(X_REJECT, BELT_Y + 0.05, 0); scene.add(pusher);
const PUSH_REST = -(BELT_W / 2 + 0.03), PUSH_OUT = BELT_W / 2 - 0.02;
const cylBody = cyl(0.04, 0.3, M.steel, pusher); cylBody.rotation.x = Math.PI / 2; cylBody.position.z = -(BELT_W / 2 + 0.27);
box(0.06, 0.08, 0.06, M.frameBlue, 0, 0, -(BELT_W / 2 + 0.44), pusher);
const post = box(0.05, BELT_Y + 0.05, 0.05, M.steelDark, 0, -(BELT_Y + 0.05) / 2, -(BELT_W / 2 + 0.36), pusher);
post.castShadow = true;
const rod = cyl(0.012, 1, M.roller, pusher); rod.rotation.x = Math.PI / 2;
const paddle = box(0.26, 0.09, 0.016, M.frameBlue, 0, 0, PUSH_REST, pusher);
let pushT = -1; // เวลาเริ่มผลัก (วินาที) — -1 = อยู่กับที่
function placePusher(z) {
  paddle.position.z = z;
  const back = -(BELT_W / 2 + 0.12);
  rod.scale.y = Math.max(0.01, z - back);
  rod.position.z = (z + back) / 2;
}
placePusher(PUSH_REST);
// ถังคัดออก (เปิดด้านบน)
const bin = new THREE.Group(); bin.position.set(BIN.x, 0, BIN.z); scene.add(bin);
const binH = BIN.top;
box(BIN.w, 0.02, BIN.d, M.red, 0, 0.17, 0, bin);
box(BIN.w, binH - 0.16, 0.02, M.red, 0, (binH + 0.16) / 2, BIN.d / 2, bin);
box(BIN.w, binH - 0.16, 0.02, M.red, 0, (binH + 0.16) / 2, -BIN.d / 2, bin);
for (const s of [-1, 1]) box(0.02, binH - 0.16, BIN.d, M.red, s * BIN.w / 2, (binH + 0.16) / 2, 0, bin);
for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const w = cyl(0.03, 0.04, M.black, bin); w.rotation.z = Math.PI / 2; w.position.set(x * (BIN.w / 2 - 0.06), 0.03, z * (BIN.d / 2 - 0.06)); }
for (const s of [-1, 1]) box(0.03, 0.14, 0.03, M.steelDark, s * (BIN.w / 2 - 0.06), 0.1, 0, bin);
const binLabelCanvas = document.createElement('canvas'); binLabelCanvas.width = 512; binLabelCanvas.height = 160;
const binLabelTex = new THREE.CanvasTexture(binLabelCanvas); binLabelTex.colorSpace = THREE.SRGBColorSpace;
const binLabel = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.137), new THREE.MeshStandardMaterial({ map: binLabelTex, roughness: 0.6 }));
binLabel.position.set(0, 0.42, BIN.d / 2 + 0.012); bin.add(binLabel);
function drawBinLabel() {
  const g = binLabelCanvas.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 512, 160);
  g.fillStyle = '#d23a31'; g.fillRect(10, 10, 492, 140);
  g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `700 64px ${fontFamily()}`; g.fillText('REJECT', 256, 62);
  g.font = `600 34px ${fontFamily()}`; g.fillText(T_('ถังคัดออก'), 256, 118);
  binLabelTex.needsUpdate = true;
}
// รางลาดจากขอบสายพานลงถัง
const chute = box(0.34, 0.012, 0.3, M.steel, X_REJECT, BELT_Y - 0.08, BELT_W / 2 + 0.14);
chute.rotation.x = 0.55;

// ================= ถุง (pouch) =================
const POUCH = { L: 0.2, W: 0.135, T: 0.036 };
/** ถุงแบบจำลอง: กล่องแบ่งละเอียดแล้วดัดให้พองตรงกลาง แบนที่ขอบ มีแถบซีลด้านหนึ่ง (นอนบนสายพาน) */
function pouchGeometry() {
  const { L, W, T } = POUCH;
  const g = new THREE.BoxGeometry(L, T, W, 40, 2, 28);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const u = x / (L / 2), v = z / (W / 2);
    let puff = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(u), 5)), 0.55) * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(v), 4)), 0.5);
    const seal = THREE.MathUtils.smoothstep(u, 0.7, 0.78);
    puff = Math.max(0.05, puff * (1 - seal) + 0.07 * seal);
    p.setY(i, y > 1e-6 ? T * 0.8 * puff : y < -1e-6 ? -T * 0.2 * puff : 0);
  }
  g.computeVertexNormals();
  return g;
}
let pouchGeo = null;
const labelMats = new Map(); // ลายฉลากต่อชื่อสินค้า

function fontFamily() { return getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'sans-serif'; }
function hashHue(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; }

/** ฉลากบนหน้าถุง: สีตามชื่อสินค้า (โปรแกรมบนเครื่อง) + น้ำหนักสุทธิ */
function labelMaterial(name) {
  const key = `${name}|${SPEC.TARGET}`;
  if (labelMats.has(key)) return labelMats.get(key);
  const c = document.createElement('canvas'); c.width = 600; c.height = 404;
  const g = c.getContext('2d'), hue = hashHue(name || 'pouch');
  const bg = g.createLinearGradient(0, 0, 600, 404);
  bg.addColorStop(0, '#f1f4f8'); bg.addColorStop(1, '#d9dfe7');
  g.fillStyle = bg; g.fillRect(0, 0, 600, 404);
  g.fillStyle = `hsl(${hue},55%,42%)`; g.fillRect(0, 0, 600, 58);              // แถบสีสินค้า
  // แถบซีล (ปลายถุงด้าน +x)
  const sx = 600 * 0.885;
  const sg = g.createLinearGradient(sx, 0, 600, 0); sg.addColorStop(0, '#cfd6df'); sg.addColorStop(1, '#f4f7fa');
  g.fillStyle = sg; g.fillRect(sx, 0, 600 - sx, 404);
  g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 2;
  for (let x = sx + 8; x < 600; x += 9) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 404); g.stroke(); }
  // หน้าต่างฉลาก
  g.fillStyle = 'rgba(255,255,255,.96)';
  g.beginPath(); g.roundRect(46, 84, 420, 250, 30); g.fill();
  g.fillStyle = `hsl(${hue},60%,28%)`; g.textAlign = 'center'; g.textBaseline = 'middle';
  const words = String(name || 'Pet food pouch').replace(/^No\.\S+\s*/, '').trim() || 'Pet food pouch';
  let fs = 54; g.font = `700 ${fs}px ${fontFamily()}`;
  while (g.measureText(words).width > 380 && fs > 26) { fs -= 2; g.font = `700 ${fs}px ${fontFamily()}`; }
  g.fillText(words, 256, 178);
  g.font = `600 34px ${fontFamily()}`; g.fillStyle = `hsl(${hue},40%,35%)`;
  g.fillText(`NET WT ${SPEC.TARGET} g`, 256, 262);
  g.fillStyle = 'rgba(255,255,255,.85)'; g.font = `700 30px ${fontFamily()}`; g.textAlign = 'left';
  g.fillText('AutoWeight', 48, 30);
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace; tx.anisotropy = MAX_ANISO; tx.flipY = false;
  const mat = new THREE.MeshStandardMaterial({ map: tx, roughness: 0.38, metalness: 0.15 });
  labelMats.set(key, mat);
  return mat;
}
const foilMat = new THREE.MeshStandardMaterial({ color: 0xd9dee6, roughness: 0.3, metalness: 0.55 });

// ไฟล์ .glb (ถ้ามี) — แทนถุงแบบจำลอง
let glbPouch = null;
async function tryLoadPouchGlb() {
  try {
    const head = await fetch('assets/models/pouch.glb', { method: 'HEAD', cache: 'no-store' });
    if (!head.ok) return;
    const gltf = await new GLTFLoader().loadAsync('assets/models/pouch.glb');
    const root = gltf.scene;
    const bb = new THREE.Box3().setFromObject(root), size = bb.getSize(new THREE.Vector3());
    // วางให้ด้านที่ยาวที่สุดตามแนวสายพาน (x) และด้านที่บางที่สุดเป็นความหนา (y)
    const dims = [['x', size.x], ['y', size.y], ['z', size.z]].sort((a, b) => b[1] - a[1]);
    const holder = new THREE.Group(); holder.add(root);
    if (dims[2][0] === 'z') root.rotation.x = Math.PI / 2; else if (dims[2][0] === 'x') root.rotation.z = Math.PI / 2;
    root.updateMatrixWorld(true);
    let bb2 = new THREE.Box3().setFromObject(holder), s2 = bb2.getSize(new THREE.Vector3());
    if (s2.z > s2.x) { root.rotation.y += Math.PI / 2; root.updateMatrixWorld(true); bb2 = new THREE.Box3().setFromObject(holder); s2 = bb2.getSize(new THREE.Vector3()); }
    const k = POUCH.L / s2.x;
    holder.scale.setScalar(k);
    holder.updateMatrixWorld(true);
    bb2 = new THREE.Box3().setFromObject(holder);
    const c = bb2.getCenter(new THREE.Vector3());
    root.position.sub(new THREE.Vector3(c.x / k, bb2.min.y / k, c.z / k));
    holder.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    glbPouch = holder;
    $('l3PouchCredit').innerHTML = 'ถุงในฉาก: <a href="https://sketchfab.com/3d-models/sealed-food-pouch-1e639d03d97045f6a3b6ca1954e762bf" target="_blank" rel="nofollow noopener">Sealed Food Pouch</a> โดย firstprospect · CC BY 4.0';
  } catch (err) {
    console.error('โหลด pouch.glb ไม่ได้ — ใช้ถุงแบบจำลองแทน:', err);
  }
}

const glowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 8, 64, 64, 62);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.55, 'rgba(255,255,255,.55)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
const glowGeo = new THREE.PlaneGeometry(0.34, 0.25);

const pouches = [];
const pouchLayer = new THREE.Group(); scene.add(pouchLayer);

/** สร้างถุง 1 ใบจากแถวข้อมูล rec = {id, value, zone} */
function makePouch(rec) {
  const g = new THREE.Group();
  let mats = [];
  if (glbPouch) {
    const m = glbPouch.clone(true);
    m.traverse((o) => { if (o.isMesh) { o.material = Array.isArray(o.material) ? o.material.map((x) => x.clone()) : o.material.clone(); mats.push(...(Array.isArray(o.material) ? o.material : [o.material])); } });
    g.add(m);
  } else {
    if (!pouchGeo) pouchGeo = pouchGeometry();
    const foil = foilMat.clone(), label = labelMaterial(machine.program || '').clone();
    const mesh = new THREE.Mesh(pouchGeo, [foil, foil, label, foil, foil, foil]);
    mesh.position.y = POUCH.T * 0.2;
    mesh.castShadow = true; mesh.receiveShadow = true;
    g.add(mesh);
    mats = [foil, label];
  }
  const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, opacity: 0, color: ZC.NONE }));
  glow.rotation.x = -Math.PI / 2; glow.position.y = 0.003;
  g.add(glow);
  pouchLayer.add(g);
  const p = { rec, g, mats, glow, x: X_SPAWN, state: 'in', tag: null, t0: 0, from: null, to: null };
  g.position.set(p.x, BELT_Y, 0);
  pouches.push(p);
  return p;
}
function removePouch(p) {
  pouchLayer.remove(p.g);
  if (p.tag) { p.tag.element.remove(); p.tag.removeFromParent(); }
  p.glow.material.dispose();
  for (const m of new Set(p.mats)) m.dispose();
  const i = pouches.indexOf(p); if (i >= 0) pouches.splice(i, 1);
}
/** ระบายสีถุงตามโซนหลังชั่ง + ป้ายน้ำหนักลอยเหนือถุง */
function tintPouch(p) {
  const col = new THREE.Color(ZC[p.rec.zone]);
  const tint = col.clone().lerp(new THREE.Color(0xffffff), 0.22);
  for (const m of new Set(p.mats)) {                     // ทั้งใบเปลี่ยนเป็นสีโซน (ลายฉลากยังเห็น)
    if (m.color) m.color.copy(tint);
    if (m.emissive) { m.emissive.copy(col); m.emissiveIntensity = 0.14; }
  }
  p.glow.material.color.copy(col); p.glow.material.opacity = 0.85;
  const el = document.createElement('div');
  el.className = 'l3-tag';
  el.style.background = ZC[p.rec.zone];
  el.innerHTML = `${fmt1(p.rec.value)} g<small>${statusWord(p.rec)}</small>`;
  const tag = new CSS2DObject(el); tag.position.set(0, 0.1, 0);
  p.g.add(tag); p.tag = tag;
}
function statusWord(rec) {
  if (rec.zone === 'OUT') return rec.value > SPEC.USL ? 'เกิน' : 'ขาด';
  return 'ผ่าน';
}

// ================= สถานะ / ข้อมูลที่ได้มา =================
const machine = { state: { cls: 'warn', text: 'กำลังเชื่อมต่อ…' }, program: '', speed: null, running: false, opc: false, name: '' };
let lastId = 0, serverStatus = null;
const queue = [];          // แถวที่ได้มาแต่ยังไม่ได้ปล่อยถุงลงสายพาน
const tsHist = [];         // เวลาของชิ้นล่าสุด (ไว้ประมาณอัตราการผลิต)
let lastArrival = 0;       // performance.now() ตอนที่ได้แถวใหม่ล่าสุด
const statWin = [];        // โซนของชิ้นล่าสุด (สูงสุด STAT_N)
const recent = [];         // ชิ้นที่เพิ่งชั่ง (สูงสุด RECENT_N)
let lastWeighed = null;

function toRec(r) {
  const value = Number(r.weight);
  return { id: Number(r.id), value, zone: zoneOf(value), ts: new Date(r.time_stamp).getTime() };
}
function pushStat(rec) {
  statWin.push({ zone: rec.zone, over: rec.value > SPEC.USL });
  if (statWin.length > STAT_N) statWin.shift();
}

async function loadScales() {
  const picker = $('scalePicker');
  try {
    const data = await api('/api/scales');
    const scales = data.scales || [];
    if (!scales.length) { picker.innerHTML = '<option value="">ไม่มีเครื่องชั่ง</option>'; return; }
    if (SCALE_ID == null) SCALE_ID = scales[0].scale_id;
    const label = (s) => `${s.line || s.name || s.ip}${s.name && s.line && s.name !== s.line ? ' · ' + s.name : ''}${s.device_type === 'opcua' ? ' (CW)' : ''}`;
    picker.innerHTML = scales.filter((s) => s.enabled !== false || s.scale_id === SCALE_ID)
      .map((s) => `<option value="${s.scale_id}"${s.scale_id === SCALE_ID ? ' selected' : ''}>${label(s)}</option>`).join('');
    const cur = scales.find((s) => s.scale_id === SCALE_ID); machine.name = cur ? (cur.line || cur.name || '') : '';
    picker.addEventListener('change', () => { const u = new URL(location.href); u.searchParams.set('scale', picker.value); location.href = u.toString(); });
  } catch (err) {
    console.error('loadScales:', err);
    picker.innerHTML = '<option value="">โหลดรายชื่อเครื่องไม่ได้</option>';
  }
}
async function loadZone() {
  try {
    const s = (await api('/api/settings')).settings || {};
    const n = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };
    ZONE = { yellowPct: n(s['zone.yellowPct'], 60), redPct: n(s['zone.redPct'], 85) };
    if (ZONE.redPct <= ZONE.yellowPct) ZONE.redPct = Math.min(99, ZONE.yellowPct + 1);
  } catch (err) { console.error('loadZone:', err); }
}
/** สเปก: เอกสารที่กำลังรัน (ถ้าไม่ได้เลือกใช้สเปกเครื่องไว้ในหน้า Dashboard) → โปรแกรมบนเครื่อง → ค่าเดิม */
async function loadSpec() {
  const sc = currentScale();
  const L = sc && sc.device_type === 'opcua' && sc.cw && sc.cw.limits;
  const mach = L && L.target != null && L.lo != null && L.hi != null ? { TARGET: +L.target, LSL: +L.lo, USL: +L.hi } : null;
  let doc = null;
  try {
    const s = ((await api(`/api/sessions?scaleId=${SCALE_ID}&status=running&pageSize=1`)).rows || [])[0];
    if (s && s.nw_target != null) doc = { TARGET: +s.nw_target, LSL: +(s.nw_lcl ?? s.nw_target), USL: +(s.nw_ucl ?? s.nw_target) };
  } catch (err) { console.error('loadSpec:', err); }
  let pref = 'doc'; try { pref = localStorage.getItem(`spec_src_${SCALE_ID}`) === 'machine' ? 'machine' : 'doc'; } catch (e) { /* ignore */ }
  const half = mach ? Math.max(0.5, (mach.USL - mach.LSL) / 2) : 0;
  const mismatch = doc && mach && (Math.abs(doc.TARGET - mach.TARGET) > half || doc.USL < mach.LSL || doc.LSL > mach.USL);
  const use = doc && !(mismatch && pref === 'machine') ? doc : mach;
  if (use) Object.assign(SPEC, use);
  $('l3Spec').textContent = `Target ${SPEC.TARGET} g · ผ่าน ${SPEC.LSL}–${SPEC.USL} g`;
}
function currentScale() {
  if (!serverStatus || !Array.isArray(serverStatus.scales)) return null;
  return serverStatus.scales.find((s) => s.scale_id === SCALE_ID) || serverStatus.scales[0] || null;
}
let statusTick = 0;
async function refreshStatus() {
  try {
    serverStatus = await api('/api/status');
    const sc = currentScale();
    machine.opc = !!(sc && sc.device_type === 'opcua');
    if (!sc) machine.state = { cls: 'warn', text: 'ยังไม่มีเครื่องชั่งในระบบ' };
    else if (sc.enabled === false) machine.state = { cls: 'idle', text: 'ปิดใช้งาน' };
    else if (machine.opc) {
      const c = sc.cw || {}, cs = sc.connection_status;
      machine.running = cs === 'connected' && c.run_state === 'running';
      machine.state = cs !== 'connected' ? { cls: cs === 'error' || cs === 'stopped' ? 'down' : 'warn', text: { connecting: 'กำลังเชื่อมต่อ', reconnecting: 'กำลังเชื่อมต่อใหม่', error: 'เชื่อมต่อไม่ได้', stopped: 'หยุดอยู่' }[cs] || cs }
        : machine.running ? { cls: 'ok', text: 'กำลังผลิต' } : { cls: 'idle', text: 'ว่าง / หยุดเดิน' };
      machine.program = c.program_no != null || c.program_name ? `No.${c.program_no ?? '-'} ${c.program_name || ''}`.trim() : '';
      const sp = c.pass_speed ?? c.infeed_speed;
      machine.speed = sp != null ? { v: sp, set: c.speed_setting } : null;
    } else {
      const ok = sc.connection_status === 'connected' || sc.connection_status === 'simulating';
      machine.state = { cls: ok ? 'ok' : 'down', text: ok ? 'รับค่าอยู่' : String(sc.connection_status) };
      machine.program = ''; machine.speed = null;
    }
    if (statusTick++ % 3 === 0) await loadSpec();
  } catch (err) {
    console.error('refreshStatus:', err);
    serverStatus = null;
    machine.state = { cls: 'down', text: 'ต่อ backend ไม่ได้' };
  }
  paintHud();
}
let pollBusy = false;
async function poll() {
  if (pollBusy || SCALE_ID == null) return;
  pollBusy = true;
  try {
    const rows = (await api(`/api/weights?sinceId=${lastId}&limit=500${scaleQS()}`)).rows || [];
    for (const r of rows) {
      const rec = toRec(r);
      if (!Number.isFinite(rec.value) || !(rec.id > lastId)) continue;
      lastId = rec.id;
      queue.push(rec);
      tsHist.push(Number.isFinite(rec.ts) ? rec.ts : Date.now());
      if (tsHist.length > 24) tsHist.shift();
      lastArrival = performance.now();
    }
    // ค้างมากเกินไป (เช่น สลับแท็บไปนาน) — ชิ้นเก่านับเข้าสถิติเลยโดยไม่วาด
    while (queue.length > 30) { const r = queue.shift(); pushStat(r); pushRecent(r); }
  } catch (err) {
    console.error('poll:', err);
    machine.state = { cls: 'down', text: 'ต่อ backend ไม่ได้' };
    paintHud();
  } finally { pollBusy = false; }
}
/** โหลดชิ้นล่าสุดตอนเปิดหน้า: สถิติ 200 ชิ้น + วางถุงที่ชั่งแล้วบนสายพานออก ให้ฉากไม่ว่างตั้งแต่แรก */
async function loadInitial() {
  try {
    const rows = ((await api(`/api/weights/history?limit=${STAT_N}${scaleQS()}`)).rows || []).map(toRec).filter((r) => Number.isFinite(r.value));
    rows.sort((a, b) => a.id - b.id);
    for (const r of rows) { pushStat(r); lastId = Math.max(lastId, r.id); tsHist.push(r.ts); if (tsHist.length > 24) tsHist.shift(); }
    for (const r of rows.slice(-RECENT_N)) pushRecent(r, true);
    lastWeighed = rows[rows.length - 1] || null;
    const recentAge = rows.length ? Date.now() - rows[rows.length - 1].ts : Infinity;
    if (recentAge < 120000) lastArrival = performance.now() - recentAge;
    const lastK = rows.slice(-12).reverse();
    lastK.forEach((r, k) => {
      const x = X_WEIGH + 0.25 + k * GAP;
      if (x > X_END - 0.05) return;
      const p = makePouch(r); p.x = x; p.g.position.x = x; p.state = 'weighed'; tintPouch(p);
      if (r.zone === 'OUT' && x > X_REJECT) dropInBin(p, true);
    });
    limitTags();
  } catch (err) { console.error('loadInitial:', err); }
  paintStats(); paintRecent(); drawScreen();
}

// ================= HUD =================
function paintHud() {
  const s = machine.state;
  $('l3StateDot').className = `l3-dot ${s.cls}`;
  $('l3State').textContent = s.text;
  $('l3ProgPill').hidden = !machine.program; $('l3Prog').textContent = machine.program;
  $('l3SpeedPill').hidden = !machine.speed;
  if (machine.speed) $('l3Speed').textContent = `${machine.speed.v} ชิ้น/นาที${machine.speed.set != null ? ` (ตั้งไว้ ${machine.speed.set})` : ''}`;
}
function pushRecent(rec, silent) {
  recent.push(rec); if (recent.length > RECENT_N) recent.shift();
  if (!silent) paintRecent();
}
function paintRecent() {
  $('l3Recent').innerHTML = recent.map((r) => `<i style="background:${ZC[r.zone]}" title="${fmt1(r.value)} g">${fmt1(r.value)}</i>`).join('');
  const r = lastWeighed;
  $('l3Last').textContent = r ? fmt1(r.value) : '–';
  const b = $('l3LastBadge');
  if (r) {
    b.hidden = false; b.style.background = ZC[r.zone];
    b.textContent = r.zone === 'OUT' ? (r.value > SPEC.USL ? 'เกิน — คัดออก' : 'ขาด — คัดออก') : r.zone === 'RED' ? 'ผ่าน · ใกล้ขอบ' : r.zone === 'YELLOW' ? 'ผ่าน · เริ่มห่าง' : 'ผ่าน';
  } else b.hidden = true;
}
function paintStats() {
  const n = statWin.length, rej = statWin.filter((s) => s.zone === 'OUT'), over = rej.filter((s) => s.over).length;
  const pct = (k) => (n ? `${(k / n * 100).toFixed(1)}%` : '');
  $('l3StatTitle').textContent = `${fmtN(n)} ชิ้นล่าสุด`;
  $('l3Pass').textContent = n ? fmtN(n - rej.length) : '–'; $('l3PassPct').textContent = pct(n - rej.length);
  $('l3Rej').textContent = n ? fmtN(rej.length) : '–'; $('l3RejPct').textContent = pct(rej.length);
  $('l3Over').textContent = n ? fmtN(over) : '–'; $('l3Under').textContent = n ? fmtN(rej.length - over) : '–';
}

/** จอบนเครื่อง: น้ำหนักชิ้นล่าสุด + ผล + สเปก */
function drawScreen() {
  const g = scrCanvas.getContext('2d'), W = 1024, H = 688, r = lastWeighed, f = fontFamily();
  g.fillStyle = '#0b1220'; g.fillRect(0, 0, W, H);
  const col = r ? ZC[r.zone] : '#475569';
  g.fillStyle = '#111c2e'; g.fillRect(0, 0, W, 92);
  g.fillStyle = col; g.fillRect(0, 88, W, 8);
  g.fillStyle = '#e2e8f0'; g.font = `700 40px ${f}`; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText('AutoWeight CW', 32, 46);
  g.textAlign = 'right'; g.fillStyle = '#94a3b8'; g.font = `600 34px ${f}`;
  g.fillText(machine.name || '', W - 32, 46);
  g.textAlign = 'right'; g.fillStyle = '#f8fafc'; g.font = `700 230px ${f}`;
  g.fillText(r ? fmt1(r.value) : '--.-', W - 150, 268);
  g.fillStyle = '#94a3b8'; g.font = `700 80px ${f}`; g.textAlign = 'left';
  g.fillText('g', W - 130, 290);
  const word = !r ? T_('รอชิ้นงาน') : r.zone === 'OUT' ? T_(r.value > SPEC.USL ? 'เกิน → คัดออก' : 'ขาด → คัดออก') : T_(r.zone === 'GREEN' ? 'ผ่าน' : 'ผ่าน · ใกล้ขอบ');
  g.fillStyle = col; g.beginPath(); g.roundRect(32, 440, W - 64, 104, 22); g.fill();
  g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.font = `700 60px ${f}`; g.fillText(word, W / 2, 494);
  g.fillStyle = '#cbd5e1'; g.font = `600 36px ${f}`;
  g.fillText(`Target ${SPEC.TARGET} g   ·   LSL ${SPEC.LSL}   ·   USL ${SPEC.USL}`, W / 2, 606);
  g.fillStyle = '#64748b'; g.font = `500 30px ${f}`;
  g.fillText(machine.program || '', W / 2, 652);
  scrTex.needsUpdate = true;
}
function setLamps() {
  const r = lastWeighed, live = performance.now() - lastArrival < 8000 || machine.running;
  const on = !live ? null : !r ? 'green' : r.zone === 'OUT' ? 'red' : r.zone === 'GREEN' ? 'green' : 'amber';
  for (const k of ['red', 'amber', 'green']) {
    const m = lamps[k], lit = k === on;               // ดวงที่ดับให้สีหม่น จะได้เห็นชัดว่าดวงไหนติด
    m.color.copy(m.userData.base).multiplyScalar(lit ? 1 : 0.22);
    m.emissiveIntensity = lit ? 2.4 : 0;
  }
}

// ================= การเคลื่อนที่ =================
let beltV = 0;
function targetSpeed() {
  const recentData = performance.now() - lastArrival < 6000;
  if (!recentData && !machine.running && !queue.length) return 0;
  let rate = 0; // ชิ้น/วินาที
  if (tsHist.length >= 3) {
    const span = (tsHist[tsHist.length - 1] - tsHist[0]) / 1000;
    if (span > 0) rate = (tsHist.length - 1) / span;
  }
  if (!(rate > 0) && machine.speed && Number(machine.speed.v) > 0) rate = Number(machine.speed.v) / 60;
  let v = rate > 0 ? THREE.MathUtils.clamp(rate * GAP, 0.45, 2.0) : 0.6;
  if (queue.length > 4) v *= Math.min(1.6, 1 + (queue.length - 4) * 0.08); // เร่งตามให้ทันข้อมูล
  return v;
}
function weigh(p) {
  p.state = 'weighed';
  lastWeighed = p.rec;
  tintPouch(p);
  pushStat(p.rec); pushRecent(p.rec); paintStats(); drawScreen(); setLamps();
  limitTags();
}
/** ป้ายน้ำหนักแสดงเฉพาะ 4 ใบล่าสุด + ใบที่หลุดสเปก (กันป้ายซ้อนกันเต็มจอ) */
function limitTags() {
  const tagged = pouches.filter((q) => q.tag && q.state !== 'bin').sort((a, b) => b.rec.id - a.rec.id);
  const keep = stage.clientWidth < 700 ? 2 : 4;          // จอเล็กเหลือ 2 ป้าย
  tagged.forEach((q, i) => { q.tag.visible = i < keep || q.rec.zone === 'OUT'; });
}
function startPush(p) {
  p.state = 'push'; p.t0 = clock.elapsedTime; pushT = clock.elapsedTime;
}
/** ส่งถุงลงถัง (ถ้า instant = วางทันทีตอนเปิดหน้า) */
const binned = [];
function dropInBin(p, instant) {
  const i = binned.length;
  const to = new THREE.Vector3(BIN.x + (Math.random() - 0.5) * 0.24, BIN.floor + 0.012 * Math.min(i, 8), BIN.z + (Math.random() - 0.5) * 0.18);
  p.state = instant ? 'bin' : 'fall';
  p.t0 = clock.elapsedTime; p.from = p.g.position.clone(); p.to = to;
  p.rot = (Math.random() - 0.5) * 1.4;
  if (instant) { p.g.position.copy(to); p.g.rotation.y = p.rot; p.binAt = clock.elapsedTime - 10; }
  binned.push(p);
  while (binned.length > 9) removePouch(binned.shift());
}

const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(0.25, clock.getDelta()), now = clock.elapsedTime;   // เครื่องช้า (fps ต่ำ) ก็ยังเดินทันเวลาจริง
  beltV += (targetSpeed() - beltV) * Math.min(1, dt * 1.8);
  const dx = beltV * dt;
  for (const tx of beltTextures) tx.offset.x -= dx / RIB;

  // ปล่อยถุงใหม่ที่หัวสายพานเมื่อมีที่ว่างพอ
  const lastOnBelt = pouches.filter((p) => p.state === 'in').reduce((m, p) => Math.min(m, p.x), Infinity);
  if (queue.length && beltV > 0.05 && (lastOnBelt === Infinity || lastOnBelt - X_SPAWN >= GAP * 0.9)) makePouch(queue.shift());

  for (const p of pouches.slice()) {
    if (p.state === 'in' || p.state === 'weighed') {
      p.x += dx; p.g.position.x = p.x;
      if (p.state === 'in' && p.x >= X_WEIGH) weigh(p);
      else if (p.state === 'weighed' && p.rec.zone === 'OUT' && p.x >= X_REJECT && p.x < X_REJECT + 0.3) startPush(p);
      else if (p.x >= X_END) { p.state = 'drop'; p.t0 = now; }
    } else if (p.state === 'push') {
      const k = Math.min(1, (now - p.t0) / 0.2);
      p.g.position.z = THREE.MathUtils.lerp(0, PUSH_OUT + 0.16, k * k);
      if (k >= 1) dropInBin(p, false);
    } else if (p.state === 'fall') {
      const k = Math.min(1, (now - p.t0) / 0.5);
      p.g.position.lerpVectors(p.from, p.to, k);
      p.g.position.y = THREE.MathUtils.lerp(p.from.y, p.to.y, k * k) + Math.sin(k * Math.PI) * 0.06;
      p.g.rotation.y = p.rot * k; p.g.rotation.x = Math.sin(k * Math.PI) * 0.5;
      if (k >= 1) { p.state = 'bin'; p.binAt = now; p.g.rotation.x = 0; }
    } else if (p.state === 'bin') {
      if (p.tag && now - p.binAt > 3) { p.tag.element.remove(); p.tag.removeFromParent(); p.tag = null; }
    } else if (p.state === 'drop') {
      const k = (now - p.t0) / 0.6;
      p.x += dx; p.g.position.x = p.x;
      p.g.position.y = BELT_Y - 2.2 * k * k;
      p.g.rotation.z = -k * 1.2;
      if (k >= 1 || p.g.position.y < 0.05) removePouch(p);
    }
  }
  // แขนผลัก: ยื่นออก 0.2 วิ แล้วหดกลับ 0.35 วิ
  if (pushT >= 0) {
    const e = now - pushT;
    if (e < 0.2) placePusher(THREE.MathUtils.lerp(PUSH_REST, PUSH_OUT, e / 0.2));
    else if (e < 0.55) placePusher(THREE.MathUtils.lerp(PUSH_OUT, PUSH_REST, (e - 0.2) / 0.35));
    else { placePusher(PUSH_REST); pushT = -1; }
  }
  beamMat.opacity = 0.35 + 0.25 * Math.abs(Math.sin(now * 3));
  if (camAnim) stepCamera(now);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// ================= กล้อง =================
const VIEWS = {
  overview: { pos: [-1.6, 2.6, 5.2], tgt: [0.35, 0.7, 0.1] },
  scale: { pos: [-1.2, 1.55, 1.75], tgt: [-0.1, 0.98, -0.05] },
  reject: { pos: [3.3, 1.75, 2.3], tgt: [2.3, 0.62, 0.3] },
  top: { pos: [0.3, 7.2, 1.2], tgt: [0.3, 0.6, 0.1] },
};
let camAnim = null;
function viewPose(name) {
  const v = VIEWS[name], tgt = new THREE.Vector3(...v.tgt), pos = new THREE.Vector3(...v.pos);
  const aspect = camera.aspect || 1.6, need = name === 'top' || name === 'overview' ? 1.75 : 1.2;
  if (aspect < need) pos.sub(tgt).multiplyScalar(Math.min(2.6, need / aspect)).add(tgt);  // จอแคบ: ถอยกล้องให้เห็นทั้งไลน์
  return { pos, tgt };
}
function goView(name, instant) {
  const { pos, tgt } = viewPose(name);
  if (instant) { camera.position.copy(pos); controls.target.copy(tgt); controls.update(); camAnim = null; return; }
  camAnim = { t0: clock.elapsedTime, p0: camera.position.clone(), t0v: controls.target.clone(), pos, tgt };
}
function stepCamera(now) {
  const k = Math.min(1, (now - camAnim.t0) / 0.9), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  camera.position.lerpVectors(camAnim.p0, camAnim.pos, e);
  controls.target.lerpVectors(camAnim.t0v, camAnim.tgt, e);
  if (k >= 1) camAnim = null;
}
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('active', x === b));
  goView(b.dataset.view);
}));
controls.addEventListener('start', () => { camAnim = null; });

// ================= ขนาดจอ / ธีม =================
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
function applyTheme() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const bg = new THREE.Color(dark ? 0x0c1320 : 0xeef2f7);
  scene.background = bg;
  scene.fog = new THREE.Fog(bg, 11, 26);
  floorMat.color.set(dark ? 0x141d2c : 0xdfe5ee);
  zoneMat.color.set(dark ? 0x1a2638 : 0xcfd8e4);
  scene.environmentIntensity = dark ? 0.4 : 0.55;
}
window.addEventListener('themechange', applyTheme);

// ================= Sketchfab (กดโหลดเอง — ไม่โหลดตอนเปิดหน้า เพราะหนักและต้องใช้อินเทอร์เน็ต) =================
$('l3SfLoad').addEventListener('click', () => {
  const f = document.createElement('iframe');
  f.title = 'SM_CheckWeigher';
  f.allow = 'autoplay; fullscreen; xr-spatial-tracking';
  f.setAttribute('allowfullscreen', '');
  f.src = 'https://sketchfab.com/models/08d39b5ac3e5488895ecb8307bdbe56b/embed?autostart=1&ui_hint=0';
  $('l3SfFrame').replaceChildren(f);
});

// ================= เริ่ม =================
async function start() {
  applyTheme(); resize(); goView('overview', true);
  drawBinLabel(); drawScreen(); paintHud();
  requestAnimationFrame(tick);
  await Promise.all([loadScales(), loadZone(), tryLoadPouchGlb()]);
  await refreshStatus();
  await loadInitial();
  setLamps();
  setInterval(poll, POLL_MS);
  setInterval(() => { refreshStatus(); setLamps(); }, STATUS_MS);
  // ฟอนต์/พจนานุกรมโหลดเสร็จทีหลัง — วาดข้อความบนจอและป้ายถังใหม่
  window.addEventListener('load', () => { drawScreen(); drawBinLabel(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { drawScreen(); drawBinLabel(); });
}
start();
// ให้สคริปต์ทดสอบเรียกดูสถานะได้
window.__l3 = { pouches, queue, machine, SPEC, get beltV() { return beltV; }, goView };
