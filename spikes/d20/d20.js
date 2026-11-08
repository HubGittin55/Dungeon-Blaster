// d20.js - a bouncing, tumbling, dust-kicking d20 for the Dungeon Blaster client.
//
// THE LAW, IN ONE PARAGRAPH. The number is decided by the deterministic tracker. This file is told what the
// number is, before it simulates anything, and it is not allowed to have an opinion. Physics runs for the
// choreography - the hit, the bounce, the roll, the settling - and at rest the die is *eased* onto the face
// it was told to show, masked by dust and a slow-mo dip. That is not a shortcut, it is the correct shape:
// a die that disagrees with the tracker is a rules bug wearing a nice shader, and the tracker cannot lose
// that argument. `roll()` resolves with the landed face so the caller can assert agreement, and the
// self-test (`index.html?selftest=1`) rolls 30 values headlessly and fails loudly if the two ever differ.
//
// WHY IT LOOKS LIKE SOMETHING. Real rigid-body contacts against the floor plane (12 vertex contacts,
// restitution + Coulomb friction, positional projection), so it bounces and skitters instead of playing a
// canned clip. Procedural everything: no textures, no glTF, no CDN at runtime - three.js is vendored next
// door because the laptop is the whole install and it also has to work on a plane.
//
// WHY IT IS FREE. A d20 is 20 triangles and one draw call for the die; the floor is one quad. The cost of
// the whole effect is one shadowed spotlight at 2048 and a couple hundred particles. It runs at 60fps
// beside Anima and OmniVoice on an 8 GB 4060, which is the point of a couch client that also has to share
// a GPU with the thing painting its card art.

import * as THREE from 'three';

const PHI = (1 + Math.sqrt(5)) / 2;

// --------------------------------------------------------------------------- rng

// Seeded, so a roll can be replayed exactly. The seed is theatre-seed: it picks how the die tumbles, never
// what it shows. Kept separate from the game's order/roll seeds on purpose - do not pipe game RNG state
// through here or the tracker becomes answerable to a renderer.
function makeRng(seed) {
  let t = (seed >>> 0) || 1;
  return function next() {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------------------------------------------------- assets

// Number atlas: 5x4 cells, one face value each, drawn as engraved pips. Canvas font is 'em because a d20
// only has to legibly show 1-20 and a font file is another 40 KB of nothing.
function makeNumberAtlas(size = 1024) {
  const cols = 5, rows = 4, cw = size / cols, ch = size / rows;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');

  // Bone-coloured plastic with a little tonal mottling, so flat shading has something to chew on.
  g.fillStyle = '#ded3bd';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * size, y = Math.random() * size, r = Math.random() * 7 + 1;
    g.fillStyle = `rgba(${90 + Math.random() * 70 | 0},${70 + Math.random() * 55 | 0},${50 + Math.random() * 40 | 0},${Math.random() * 0.05})`;
    g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
  }
  for (let i = 0; i < 20; i++) {
    const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
    // Cell background, then the number. Cell y runs down the canvas; UVs are assigned to match below.
    g.save();
    g.translate(x + cw / 2, y + ch / 2);
    g.fillStyle = 'rgba(0,0,0,0)';
    g.font = `700 ${Math.floor(ch * 0.46)}px Georgia, "Times New Roman", serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // Carved: dark ink, then a light offset lip below it. Reads as incised at any distance.
    const v = String(i + 1);
    g.fillStyle = 'rgba(255,250,238,0.55)';
    g.fillText(v, 0, ch * 0.028);
    g.fillStyle = '#2a1f16';
    g.fillText(v, 0, 0);
    g.restore();
    // Face border, so silhouette edges read as facets rather than one smooth blob.
    g.strokeStyle = 'rgba(40,28,18,0.16)';
    g.lineWidth = size * 0.004;
    g.strokeRect(x + 2, y + 2, cw - 4, ch - 4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// Dungeon dirt: fbm-ish value noise in brown, plus scattered grit. One canvas, used as map + roughness.
function makeDirtTexture(size = 1024) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const rnd = makeRng(90210);
  const grid = [];
  for (let o = 0; o < 5; o++) {
    const n = 4 << o, cell = [];
    for (let i = 0; i <= n * n; i++) cell.push(rnd());
    grid.push({ n, cell });
  }
  const noise = (x, y) => {
    let sum = 0, amp = 0.5;
    for (const { n, cell } of grid) {
      const fx = x * n, fy = y * n;
      const ix = Math.floor(fx) % n, iy = Math.floor(fy) % n;
      const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = cell[iy * n + ix], b = cell[iy * n + ix + 1], d = cell[(iy + 1) * n + ix], e = cell[(iy + 1) * n + ix + 1];
      sum += amp * (a + (b - a) * sx + (d - a) * sy + (a - b - d + e) * sx * sy);
      amp *= 0.5;
    }
    return sum;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = noise(x / size * 3, y / size * 3);
      const clod = Math.pow(noise(x / size * 11 + 5, y / size * 11 + 9), 2.2);
      const k = 0.42 + n * 0.55 + clod * 0.3;
      const i = (y * size + x) * 4;
      img.data[i] = Math.min(255, 118 * k + 26);
      img.data[i + 1] = Math.min(255, 96 * k + 19);
      img.data[i + 2] = Math.min(255, 74 * k + 15);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < 900; i++) {
    const x = rnd() * size, y = rnd() * size, r = rnd() * 3.4 + 0.6;
    g.fillStyle = `rgba(${20 + rnd() * 40 | 0},${16 + rnd() * 30 | 0},${12 + rnd() * 22 | 0},${0.15 + rnd() * 0.3})`;
    g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(7, 7);
  tex.anisotropy = 8;
  return tex;
}

// Soft soot puff for dust and smoke.
function makePuffTexture(size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  r.addColorStop(0, 'rgba(255,255,255,0.95)');
  r.addColorStop(0.45, 'rgba(255,255,255,0.30)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// A two-band gradient as the environment, PMREM'd. Cheap, but it is the difference between a die that is
// lit and a die that has been photographed: metal and edges need something to reflect.
function makeEnvironment(renderer) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.00, '#5d4326');   // torch-lit stone above
  grad.addColorStop(0.42, '#2b1f16');
  grad.addColorStop(0.55, '#171009');
  grad.addColorStop(1.00, '#0a0705');   // dead dark below the lip of the table
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 256);
  // A warm window of light off to one side so the specular sweep has a direction.
  const w = g.createRadialGradient(120, 74, 4, 120, 74, 130);
  w.addColorStop(0, 'rgba(255,196,124,0.95)');
  w.addColorStop(1, 'rgba(255,196,124,0)');
  g.fillStyle = w;
  g.fillRect(0, 0, 512, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();
  tex.dispose();
  return env;
}

// ----------------------------------------------------------------------- die

// Face values 1..20 in the order three emits them. Real d20s put 1 opposite 20 and 1-2-3 around a vertex;
// matching that exactly is a 12-vertex relabelling exercise and is deliberately not here yet - the tracker
// does not care which face is which, only the player would, and a player only notices after there is a
// table to notice it at. Flagged in the spike notes as the one honesty gap in the model.
function buildDie(radius, atlas) {
  const geo = new THREE.IcosahedronGeometry(radius, 0);   // non-indexed: 20 faces x 3 verts
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const faces = [];
  const cols = 5;

  for (let f = 0; f < 20; f++) {
    const a = new THREE.Vector3().fromBufferAttribute(pos, f * 3);
    const b = new THREE.Vector3().fromBufferAttribute(pos, f * 3 + 1);
    const c = new THREE.Vector3().fromBufferAttribute(pos, f * 3 + 2);
    const centroid = new THREE.Vector3().addVectors(a, b).add(c).multiplyScalar(1 / 3);
    const normal = new THREE.Vector3().crossVectors(
      new THREE.Vector3().subVectors(b, a), new THREE.Vector3().subVectors(c, a)
    ).normalize();
    if (normal.dot(centroid) < 0) normal.negate();          // outward, always
    faces.push({ value: f + 1, centroid, normal });

    // UVs, done properly. The first version handed the atlas triangle to the three vertices in index order,
    // which has nothing to do with where those vertices actually are - so the printed number came out in an
    // arbitrary rotation on every face and a settled 17 read upside down while the geometry swore up=17 and
    // the self-test swore PASS. A die can satisfy the law and still lie to a human eye.
    //
    // Convention: vertex a is the apex, drawn at the top of the atlas cell; b bottom-left, c bottom-right.
    // a->b->c winds counter-clockwise seen from the outward normal, and so does top->bottomLeft->bottomRight
    // in UV space, so the mapping preserves orientation and no number is ever mirrored. The glyph now reads
    // upright toward vertex a, the same way a moulded d20 reads toward one of its points.
    const cx = (f % cols) / cols, cy = Math.floor(f / cols) / (20 / cols);
    const tri = [[0.50, 0.90], [0.09, 0.16], [0.91, 0.16]];
    for (let k = 0; k < 3; k++) {
      uv.setXY(f * 3 + k, cx + tri[k][0] / cols, cy + tri[k][1] / (20 / cols));
    }
  }
  uv.needsUpdate = true;
  geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({
    map: atlas,
    bumpMap: atlas,
    bumpScale: -0.9,          // negative = the glyph reads carved rather than printed
    roughness: 0.66,
    metalness: 0.04,
    flatShading: true,
    envMapIntensity: 0.85,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // The 12 unique vertices are the colliders. A convex polyhedron against a plane only ever touches at
  // vertices, which is why this is 12 point contacts and not a physics engine.
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i);
    seen.set(`${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`, v);
  }
  return { mesh, faces, localVerts: [...seen.values()], radius };
}

// --------------------------------------------------------------------- physics
//
// Rigid body against y=0. Semi-implicit Euler, substepped, with impulses at whichever vertices have
// penetrated the floor and positional projection so it cannot sink. Isotropic inertia: a d20 is close
// enough to a sphere that the difference is invisible, and it removes the whole tensor dance from the
// inner loop. Tuning is all feel, not physics: gravity is ~2.2x earth so a 1.8s roll reads as weight rather
// than as moonrocks, and the walls are a ring a little past frame so a bad bounce comes back instead of
// leaving the couch.

const PHYS = {
  g: 22.0,
  restitution: 0.44,
  friction: 0.62,
  wallRestitution: 0.35,
  wallX: 3.1,
  wallZ: 2.3,
  angDamp: 0.55,
  linDamp: 0.16,
  restLin: 0.30,
  restAng: 0.85,
  substeps: 8,
};

class RigidBody {
  constructor(radius) {
    this.radius = radius;
    this.inertia = 0.52 * radius * radius;   // isotropic, mass = 1
    this.p = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.v = new THREE.Vector3();
    this.w = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._vc = new THREE.Vector3();
    this._rxn = new THREE.Vector3();
  }

  step(dt, verts, onImpact) {
    this.v.y -= PHYS.g * dt;
    this.p.addScaledVector(this.v, dt);
    if (this.w.lengthSq() > 1e-9) {
      // dq/dt = 0.5 * omega_quat * q, integrated then renormalised. three.js Quaternion has no
      // multiplyScalar, which is the second reason this file has a headless pass: the page died on frame
      // one with a TypeError and looked exactly like a dark room.
      const hw = 0.5 * dt;
      const q = this.q;
      const dq = new THREE.Quaternion().set(this.w.x * hw, this.w.y * hw, this.w.z * hw, 0).multiply(q);
      q.set(q.x + dq.x, q.y + dq.y, q.z + dq.z, q.w + dq.w).normalize();
    }

    // Damping. Angular drag is what actually stops the die; without it, friction alone keeps a face
    // sliding forever and the roll never declares a winner.
    this.v.multiplyScalar(Math.max(0, 1 - PHYS.linDamp * dt));
    this.w.multiplyScalar(Math.max(0, 1 - PHYS.angDamp * dt));

    let deepest = 0;
    for (const lv of verts) {
      this._r.copy(lv).applyQuaternion(this.q);
      const wy = this.p.y + this._r.y;
      if (wy >= 0) continue;
      deepest = Math.max(deepest, -wy);

      this._vc.copy(this.v).add(new THREE.Vector3().crossVectors(this.w, this._r));
      if (this._vc.y >= 0) continue;

      this._rxn.crossVectors(this._r, UP);
      const kn = 1 + this._rxn.lengthSq() / this.inertia;
      const jn = (-(1 + PHYS.restitution) * this._vc.y) / kn;
      this.v.y += jn;
      this.w.addScaledVector(new THREE.Vector3().crossVectors(this._r, UP), jn / this.inertia);

      // Coulomb friction, clamped, so a skidding die bites and starts rolling instead of water-balling.
      this._vc.copy(this.v).add(new THREE.Vector3().crossVectors(this.w, this._r));
      const tx = this._vc.x, tz = this._vc.z;
      const tl = Math.hypot(tx, tz);
      if (tl > 1e-4) {
        const jt = Math.min(PHYS.friction * Math.abs(jn), tl) / tl;
        const jx = -tx * jt, jz = -tz * jt;
        this.v.x += jx; this.v.z += jz;
        const cr = new THREE.Vector3().crossVectors(this._r, new THREE.Vector3(jx, 0, jz));
        this.w.addScaledVector(cr, 1 / this.inertia);
      }
      if (onImpact && -this._vc.y > 1.2) onImpact(-this._vc.y, this.p.x, this.p.z);
    }

    if (deepest > 0) this.p.y += deepest * 0.85;

    // The ring. Invisible, and the reason a lucky bounce stays watchable.
    for (const [axis, lim, comp] of [['x', PHYS.wallX, 'x'], ['z', PHYS.wallZ, 'z']]) {
      if (this.p[axis] > lim) { this.p[axis] = lim; this.v[comp] = -Math.abs(this.v[comp]) * PHYS.wallRestitution; }
      if (this.p[axis] < -lim) { this.p[axis] = -lim; this.v[comp] = Math.abs(this.v[comp]) * PHYS.wallRestitution; }
    }
  }

  get speed() { return this.v.length() + this.w.length() * this.radius; }
}

const UP = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------------ fx layer

class Dust {
  constructor(count = 420) {
    const pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.size = new Float32Array(count);
    this.count = count;
    this.cursor = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo = geo;
    this.mat = new THREE.PointsMaterial({
      map: makePuffTexture(), color: 0xa89880, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.NormalBlending, sizeAttenuation: true, size: 0.3,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.active = [];
    for (let i = 0; i < count; i++) { pos[i * 3 + 1] = -999; }
  }

  puff(x, y, z, power = 1, color = 0xa89880, spread = 1) {
    const n = Math.min(64, Math.round(6 + power * 16));
    this.mat.color.setHex(color);
    for (let i = 0; i < n; i++) {
      const k = this.cursor = (this.cursor + 1) % this.count;
      const a = Math.random() * 6.2832, s = (0.35 + Math.random() * 1.5) * power * spread;
      this.geo.attributes.position.setXYZ(k, x + (Math.random() - 0.5) * 0.12, y + Math.random() * 0.05, z + (Math.random() - 0.5) * 0.12);
      this.vel[k * 3] = Math.cos(a) * s;
      this.vel[k * 3 + 1] = 0.5 + Math.random() * 1.6 * power;
      this.vel[k * 3 + 2] = Math.sin(a) * s;
      this.life[k] = 0.55 + Math.random() * 0.75;
    }
  }

  step(dt) {
    const pa = this.geo.attributes.position;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      let x = pa.getX(i) + this.vel[i * 3] * dt;
      let y = pa.getY(i) + this.vel[i * 3 + 1] * dt;
      let z = pa.getZ(i) + this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] -= 2.4 * dt;                 // dust falls back
      this.vel[i * 3] *= 1 - 1.6 * dt;
      this.vel[i * 3 + 2] *= 1 - 1.6 * dt;
      if (y < 0.01) { y = 0.01; this.vel[i * 3 + 1] *= -0.18; }
      pa.setXYZ(i, x, y, z);
    }
    pa.needsUpdate = true;
    this.mat.opacity = 0.46;
  }
}

// One expanding scuff ring per real impact - the thing that sells "it hit the dirt" harder than the dust.
class Rings {
  constructor(n = 10) {
    this.items = [];
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.1, 0.16, 40),
        new THREE.MeshBasicMaterial({ color: 0x6b5942, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.012;
      m.visible = false;
      this.items.push({ mesh: m, life: 0, max: 1 });
    }
    this.group = new THREE.Group();
    this.items.forEach(i => this.group.add(i.mesh));
  }
  ping(x, z, power) {
    const it = this.items.find(i => i.life <= 0) || this.items[0];
    it.mesh.position.set(x, 0.012, z);
    it.mesh.scale.setScalar(0.6 + power * 0.25);
    it.max = 0.45 + power * 0.04;
    it.life = it.max;
    it.mesh.visible = true;
  }
  step(dt) {
    for (const it of this.items) {
      if (it.life <= 0) continue;
      it.life -= dt;
      const t = 1 - Math.max(0, it.life / it.max);
      it.mesh.material.opacity = 0.5 * (1 - t) * (1 - t);
      it.mesh.scale.multiplyScalar(1 + 3.2 * dt);
      if (it.life <= 0) it.mesh.visible = false;
    }
  }
}

// --------------------------------------------------------------------- table

const DEFAULTS = {
  radius: 0.62,
  settleMs: 2100,      // this is latency cover, not decoration: DM TTFT is 2.55s warm
  easeMs: 420,         // the masked snap onto the announced face
  maxMs: 5200,         // never hang the couch on a physics argument
  slowmo: 0.42,
};

export class DiceTable {
  constructor(container, opts = {}) {
    this.opt = Object.assign({}, DEFAULTS, opts);
    this.container = container;
    this.onStage = opts.onStage || (() => {});
    this.onImpact = opts.onImpact || (() => {});
    this.log = [];

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(container.clientWidth || 1280, container.clientHeight || 720);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x090705);
    scene.fog = new THREE.Fog(0x090705, 7.5, 17);
    scene.environment = makeEnvironment(renderer);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(38, (container.clientWidth || 1280) / (container.clientHeight || 720), 0.1, 100);
    camera.position.set(0.05, 3.15, 4.75);
    camera.lookAt(0, 0.34, 0);
    this.camera = camera;
    this.camBase = camera.position.clone();
    this.camRig = new THREE.Vector3();   // damped offset that tracks the die across the table
    this.camAim = new THREE.Vector3();   // damped offset on the look-at target
    this.camLook = new THREE.Vector3(0, 0.34, 0);

    // Torch: one shadowed key with a flicker, a cool fill so the shadow side is not a hole, and a bounce
    // from the dirt. Three lights, all of them doing a job.
    const key = new THREE.SpotLight(0xffb46a, 90, 22, 0.62, 0.55, 1.4);
    key.position.set(-2.6, 5.4, 2.3);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0012;
    key.shadow.camera.near = 1; key.shadow.camera.far = 16;
    scene.add(key);
    this.key = key;
    this.keyBase = key.intensity;

    const fill = new THREE.DirectionalLight(0x5d7cff, 0.5);
    fill.position.set(3.4, 2.2, -3.1);
    scene.add(fill);
    scene.add(new THREE.HemisphereLight(0x40331f, 0x140d08, 0.45));

    const dirt = makeDirtTexture();
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(38, 38),
      new THREE.MeshStandardMaterial({ map: dirt, roughnessMap: dirt, roughness: 0.98, metalness: 0.0, color: 0xb9a68f })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const die = buildDie(this.opt.radius, makeNumberAtlas());
    this.die = die;
    scene.add(die.mesh);

    this.dust = new Dust();
    scene.add(this.dust.points);
    this.rings = new Rings();
    scene.add(this.rings.group);

    this.body = new RigidBody(this.opt.radius);
    this.state = 'idle';
    this.pending = null;
    this.shake = 0;
    this.timeScale = 1;
    this.rollT = 0;
    this.settleFrames = 0;
    this._clock = { t: performance.now() };
    this._running = true;
    this._fps = 60;

    // quiet = simulate without drawing. The self-test runs 30 rolls headlessly and asserts the die lands on
    // the face the tracker announced; drawing 4000 frames first would only make it slower to say no.
    this.quiet = !!opts.quiet;
    this._frame = this._frame.bind(this);
    if (!opts.manual && !opts.quiet) requestAnimationFrame(this._frame);
    if (opts.manual && !this.opt.autoStart) { /* driven by step()/advance() from here on */ }
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = this.container.clientWidth || 1280, h = this.container.clientHeight || 720;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  // The one call the game makes. `value` is the tracker's answer and arrives before the simulation does.
  roll({ value, seed = 1, slow = 1 } = {}) {
    if (this.state !== 'idle' && this.state !== 'settled') return Promise.resolve({ landed: this.landed, ms: 0, skipped: true });
    const v = Math.max(1, Math.min(20, value | 0));
    const rnd = makeRng((seed >>> 0) || 0x9e3779b9);

    // Throw: from up and behind, forward and down, with a seeded tumble. Position and velocity vary with the
    // seed; the outcome never does. That asymmetry is the whole design.
    this.body.p.set((rnd() - 0.5) * 0.5, 3.15 + rnd() * 0.5, -1.9 - rnd() * 0.35);
    this.body.q.setFromAxisAngle(new THREE.Vector3(rnd(), rnd() + 0.2, rnd()).normalize(), rnd() * 6.283);
    this.body.v.set((rnd() - 0.5) * 1.5, -(2.4 + rnd() * 1.1), 4.3 + rnd() * 1.25);
    const axis = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    const spin = 9.5 + rnd() * 7.5;
    this.body.w.copy(axis).multiplyScalar(spin);

    this.target = v;
    this.seed = seed >>> 0;
    this.slow = slow;
    this.rollT = 0;
    this.settleFrames = 0;
    this.easeFrom = null;
    this.easeTo = null;
    this.easeT = 0;
    this.state = 'rolling';
    this.onStage('throw', { value: v, seed: this.seed });

    return new Promise(res => { this.pending = { value: v, t0: performance.now(), resolve: res }; });
  }

  // Which face is up right now: the one whose world normal points at the sky. Ties broken by height.
  upFace() {
    const q = this.body.q;
    let best = null;
    for (const f of this.die.faces) {
      const n = f.normal.clone().applyQuaternion(q).y;
      if (!best || n > best.n) best = { n, value: f.value };
    }
    return best ? best.value : this.target;
  }

  _beginEase() {
    const q = this.body.q;
    const upVal = this.upFace();
    // THE WHOLE LAW LIVES ON THESE LINES, so here is what they used to do instead: they rotated the face that
    // was ALREADY up onto +Y. That is a no-op dressed as a correction, and the self-test caught it - 21 of 25
    // rolls showed some other number while the code reported success. The face that must end up pointing at
    // the sky is the one the tracker announced, whatever the physics happened to land on.
    //
    // setFromUnitVectors gives the minimal world-space rotation taking the announced normal onto +Y, and q' =
    // fix * q applies it without disturbing the die's resting position. If the die already shows the right
    // face the angle is ~0 and nobody sees a thing; if it landed on 3 and was told 17 the die visibly turns
    // over, which is why the dust and the slow-mo dip exist. The better long-run answer is to seed the throw
    // so the natural resting face usually IS the announced one, and treat the ease as the exception.
    const announced = this.die.faces.find((f) => f.value === this.target);
    const faceNormal = announced.normal.clone().applyQuaternion(q).normalize();
    const fix = new THREE.Quaternion().setFromUnitVectors(faceNormal, UP);
    // A yaw flourish so the ease reads as "settling" rather than "snapping": spin about Y while the face
    // tips up. Same endpoint, more motion to look at.
    const yaw = new THREE.Quaternion().setFromAxisAngle(UP, (Math.random() - 0.5) * 0.7);
    this.easeFrom = q.clone();
    this.easeTo = yaw.multiply(fix).multiply(q).normalize();
    this.easeT = 0;
    this.state = 'easing';
    this.onStage('settle', { upBefore: upVal, target: this.target });
    this.dust.puff(this.body.p.x, 0.03, this.body.p.z, 1.5, 0xb7a68f);
  }

  _finish() {
    const landed = this.upFace();
    const ms = this.pending ? performance.now() - this.pending.t0 : 0;
    this.state = 'settled';
    this.landed = landed;
    // One payload, all the truth, for both the promise and the callback. The HUD and the self-test used to
    // read `target` and `sim_s` from an object that only had `value` and `ms`, which made a perfectly good
    // die print "*** DISAGREEMENT ***" for every roll - a law violation that was really a missing key.
    const outcome = { value: this.target, target: this.target, landed, agree: landed === this.target,
                      ms: Math.round(ms), sim_s: +this.rollT.toFixed(2), seed: this.seed };
    this.onStage('landed', outcome);
    const p = this.pending; this.pending = null;
    if (p) p.resolve(outcome);
  }

  _frame() {
    if (!this._running) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this._clock.t) / 1000);
    this._clock.t = now;
    this._fps = this._fps * 0.92 + (dt > 0 ? 1 / dt : 60) * 0.08;
    this.step(dt);
    requestAnimationFrame(this._frame);
  }

  // One fixed unit of the whole machine: physics, the ease, fx, camera, one draw. _frame supplies dt from
  // the clock; the self-test supplies its own and never touches the renderer. Same code path either way,
  // which is the only reason a headless pass means anything about what the couch sees.
  step(dt) {
    // `now` used to live in the animation loop. When the body moved into step() the self-test's first
    // simulated frame died on ReferenceError and the page just sat there looking like a dark room - which is
    // how I learned the difference between code that parses and code that runs.
    const now = performance.now();

    // Torch flicker: two sines at awkward frequencies so it never visibly cycles.
    this.key.intensity = this.keyBase * (0.9 + 0.055 * Math.sin(now / 91) + 0.035 * Math.sin(now / 37.3));

    if (this.state === 'rolling' || this.state === 'easing') {
      // Slow-mo dip into the ease. It hides the snap AND it is the moment a dice roll is about.
      const wantSlow = this.state === 'easing' ? this.opt.slowmo : 1;
      this.timeScale += (wantSlow - this.timeScale) * Math.min(1, dt * 9);
      const sdt = dt * this.timeScale * this.slow;
      const n = PHYS.substeps;
      for (let i = 0; i < n; i++) {
        this.body.step(sdt / n, this.die.localVerts, (speed, x, z) => {
          this.dust.puff(x, 0.02, z, Math.min(2.4, speed * 0.16));
          this.rings.ping(x, z, Math.min(2.2, speed * 0.2));
          this.shake = Math.min(0.16, this.shake + speed * 0.0075);
          this.onImpact(speed);
        });
      }
      this.rollT += sdt;

      if (this.state === 'rolling') {
        const quiet = this.body.speed < PHYS.restLin + PHYS.restAng * this.opt.radius * 0.2;
        this.settleFrames = quiet ? this.settleFrames + 1 : 0;
        const settled = this.settleFrames > 10 && this.body.speed < 0.55;
        const bored = (performance.now() - (this.pending ? this.pending.t0 : now)) > this.opt.maxMs;
        if (settled || this.rollT * 1000 > this.opt.settleMs || bored) this._beginEase();
      } else {
        this.easeT += dt;
        const k = Math.min(1, this.easeT / (this.opt.easeMs / 1000));
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;   // easeInOutCubic
        this.body.q.slerpQuaternions(this.easeFrom, this.easeTo, e);
        if (k >= 1) { this.timeScale = 1; this._finish(); }
      }
    }

    // The die mesh is the body. Resting on three vertices is correct for a faceted die, but it leaves the
    // glyph a touch cockeyed; nobody has ever complained about a d20 sitting crooked.
    this.die.mesh.position.copy(this.body.p);
    this.die.mesh.quaternion.copy(this.body.q);

    this.dust.step(dt);
    this.rings.step(dt);

    // Damped lateral follow. The die skitters roughly 1.4 m and the frame is only so wide: the settled
    // capture caught it leaving shot at the exact moment the number mattered. The camera leans toward it
    // (55%) rather than chasing it (100%), so the table still reads as a place instead of a tracking shot.
    const engaged = this.state === 'idle' ? 0 : 1;
    this.camBase.x += (this.body.p.x * 0.55 * engaged - this.camBase.x) * Math.min(1, dt * 2.4);
    this.camLook.x += (this.body.p.x * 0.9 * engaged - this.camLook.x) * Math.min(1, dt * 3.0);

    // Track rig. The die leaves the throw line in whatever direction the seed likes; a fixed camera either
    // cropped it at the frame edge or let it roll clean out of shot, and the settled capture showed exactly
    // that. The camera takes about half the travel and the aim takes most of it, so the die stays framed
    // while the table still moves under it.
    const eng = this.state === 'idle' ? 0 : 1;
    const px = this.body.p.x, pz = this.body.p.z;
    this.camRig.x += (px * 0.5 * eng - this.camRig.x) * Math.min(1, dt * 2.4);
    this.camRig.z += (pz * 0.45 * eng - this.camRig.z) * Math.min(1, dt * 2.4);
    this.camAim.x += (px * 0.85 * eng - this.camAim.x) * Math.min(1, dt * 3.0);
    this.camAim.z += (pz * 0.75 * eng - this.camAim.z) * Math.min(1, dt * 3.0);

    this.shake *= Math.max(0, 1 - dt * 7);
    this.camera.position.set(
      this.camBase.x + this.camRig.x + (Math.random() - 0.5) * this.shake,
      this.camBase.y + (Math.random() - 0.5) * this.shake,
      this.camBase.z + this.camRig.z + (Math.random() - 0.5) * this.shake * 0.6
    );
    this.camera.lookAt(this.camLook.x + this.camAim.x, this.camLook.y, this.camLook.z + this.camAim.z);

    if (!this.quiet) this.renderer.render(this.scene, this.camera);
  }

  // Deterministic fixed-step pump for capture and for the self-test. Returns when the promise from roll()
  // resolves or the budget runs out, whichever is louder.
  pump(seconds, fixed = 1 / 60) {
    const n = Math.round(seconds / fixed);
    for (let i = 0; i < n; i++) {
      this.step(fixed);
      if (!this.pending && this.state === 'settled') break;
    }
    if (!this.quiet) this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this._running = false;
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
