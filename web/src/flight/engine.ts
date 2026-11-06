import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { ObstacleKind, Scenario } from './scenarios';
import type { HitKind } from './game';

/**
 * Free-flight renderer. The ship has a real position and orientation in world
 * space: steering changes its heading (turn rate), the heading persists, and
 * hazards/enemies spawn ahead of wherever it is pointing now.
 */
export interface FrameInput {
  /** Turn request (-1..1): +x = yaw right, +y = pitch up. 0 = hold heading. */
  turn: { x: number; y: number };
  speed: number;
  /** Seconds between hazards (spawned one at a time). Infinity = none. */
  spawnGap: number;
  sizeScale: number;
  hazardSpeed: number;
  kinds: ObstacleKind[];
  enemyGap: number;
  maxEnemies: number;
  enemyFireGap: number;
  navBroken: boolean;
  sensorsBroken: boolean;
  durable: boolean;
  autopilot: boolean;
  warp: number; // 0..1 extra streak (countdown / Temporal deploy)
}

export interface EngineEvents {
  onHit: (kind: HitKind) => void;
  onRing: () => void;
  /** A blaster bolt destroyed a hazard of radius `radius`, `range` units away. */
  onDestroy: (kind: ObstacleKind, radius: number, range: number) => void;
  onEnemyDestroyed: (range: number) => void;
  /** A hazard passed close without hitting: closeness 0 (2.5 units clear) .. 1 (grazed). */
  onNearMiss: (closeness: number) => void;
  /** A player bolt expired without hitting anything. */
  onMiss: () => void;
}

interface Obstacle {
  obj: THREE.Object3D;
  kind: ObstacleKind;
  r: number;
  active: boolean;
  spin: THREE.Vector3;
  vel: THREE.Vector3;
  /** Bolts: the axis the lightning bar lies along. */
  axis?: THREE.Vector3;
  prevAhead: number;
}

interface Enemy {
  obj: THREE.Group;
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number;
  side: number;
  phase: number;
  fireAcc: number;
}

interface Bolt { mesh: THREE.Mesh; active: boolean; vel: THREE.Vector3; life: number; enemy: boolean; origin: THREE.Vector3 }

/** Hazards appear ~this many seconds ahead of the ship (so turning can't dodge them by accident). */
const ARRIVE_S = 2.8;
const SHIP_R = 0.8;
const STAR_COUNT = 2200;
const STAR_BOX = 170; // stars wrap within ±STAR_BOX of the ship
const MAX_YAW = 1.5; // rad/s
const MAX_PITCH = 1.2;
const AIM_CONE = Math.cos(THREE.MathUtils.degToRad(8));

// ---------- procedural helpers ----------
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  let n = 0;
  for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) {
    const wt = (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
    n += wt * hash3(xi + dx, yi + dy, zi + dz);
  }
  return n;
}

function asteroidGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 4);
  const p = g.attributes.position as THREE.BufferAttribute;
  const colors: number[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n1 = noise3(v.x * 1.6 + seed, v.y * 1.6, v.z * 1.6);
    const n2 = noise3(v.x * 4.5, v.y * 4.5 + seed, v.z * 4.5);
    const crater = Math.max(0, noise3(v.x * 2.4 - seed, v.y * 2.4, v.z * 2.4) - 0.62) * 1.6;
    v.multiplyScalar(0.72 + n1 * 0.5 + n2 * 0.14 - crater);
    v.x *= 1 + (seed % 3) * 0.12;
    p.setXYZ(i, v.x, v.y, v.z);
    const shade = 0.22 + n2 * 0.26;
    colors.push(shade * 1.05, shade * 0.92, shade * 0.82);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

/** Distance from point p to segment ab. */
function segDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  _v.subVectors(b, a);
  const len2 = _v.lengthSq() || 1e-9;
  const t = THREE.MathUtils.clamp(_w.subVectors(p, a).dot(_v) / len2, 0, 1);
  return _w.copy(a).addScaledVector(_v, t).distanceTo(p);
}

export class FlightEngine {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private stars!: THREE.LineSegments;
  private starPos!: Float32Array;
  private starBase!: Float32Array;
  private nebula!: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private fog: THREE.FogExp2;
  private accentLight: THREE.PointLight;
  private shieldBubble: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;

  private pools = new Map<ObstacleKind, Obstacle[]>();
  private active: Obstacle[] = [];
  private enemies: Enemy[] = [];
  private bolts: Bolt[] = [];
  private spawnAcc = 0;
  private enemyAcc = 0;
  private t = 0;
  private shake = 0;
  private gunSide = 1;
  private sparks: THREE.Points;
  private sparkVel: Float32Array;
  private sparkLife: Float32Array;
  private sparkCursor = 0;

  private mats: Record<string, THREE.Material> = {};
  private rockGeos: THREE.BufferGeometry[] = [];
  private targetFog = new THREE.Color(0x0a0c24);
  private targetAccent = new THREE.Color(0x6a5cff);

  /** Ship state (world space). */
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly forward = new THREE.Vector3(0, 0, -1);
  readonly right = new THREE.Vector3(1, 0, 0);
  readonly up = new THREE.Vector3(0, 1, 0);
  private yawRate = 0;
  private pitchRate = 0;
  private speed = 40;
  /** Visual roll into turns (radians); main.ts also tilts the cockpit frame with it. */
  bank = 0;
  /** Smoothed turn rates, exposed for cockpit parallax. */
  get turnRates(): { yaw: number; pitch: number } { return { yaw: this.yawRate / MAX_YAW, pitch: this.pitchRate / MAX_PITCH }; }
  /** 0..1 skill of the autopilot (attract mode = 1; scripted test pilots lower). */
  autopilotSkill = 1;
  /** How much the autopilot meanders (attract mode looks nicer with more). */
  autopilotWander = 0.3;

  constructor(private container: HTMLElement, private events: EngineEvents) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    container.prepend(this.renderer.domElement); // behind the HUD overlays

    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 1600);
    this.fog = new THREE.FogExp2(0x0a0c24, 0.0045);
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(0x020308);

    this.scene.add(new THREE.HemisphereLight(0x9aa8ff, 0x2a1408, 0.5));
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    sun.position.set(3, 4, 2);
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x6a8cff, 1.4);
    rim.position.set(-4, -2, -3);
    this.scene.add(rim);
    this.accentLight = new THREE.PointLight(0x6a5cff, 25, 60, 1.5);
    this.accentLight.position.set(0, 0, -12);
    this.camera.add(this.accentLight);
    this.scene.add(this.camera);

    this.buildNebula();
    this.buildStars();
    this.buildMaterials();
    this.buildPools();

    this.shieldBubble = new THREE.Mesh(
      new THREE.SphereGeometry(3.2, 32, 16),
      new THREE.MeshBasicMaterial({ color: 0x8a6cff, transparent: true, opacity: 0, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
    );
    this.camera.add(this.shieldBubble);

    const sparkCount = 900;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(sparkCount * 3).fill(1e6), 3));
    sg.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(sparkCount * 3), 3));
    this.sparks = new THREE.Points(sg, new THREE.PointsMaterial({ size: 0.45, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.sparks.frustumCulled = false;
    this.sparkVel = new Float32Array(sparkCount * 3);
    this.sparkLife = new Float32Array(sparkCount);
    this.scene.add(this.sparks);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.95, 0.55, 0.62);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 1 ? 84 : 66;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
  }

  // ---------- scene building ----------
  private buildNebula(): void {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { uTime: { value: 0 }, uA: { value: new THREE.Color(0x0a0c24) }, uB: { value: new THREE.Color(0x6a5cff) } },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uA; uniform vec3 uB; varying vec3 vDir;
        float h(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7)))*43758.5453); }
        float n(vec3 p){ vec3 i=floor(p); vec3 f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),
                     mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }
        float fbm(vec3 p){ float v=0.0; float a=0.5; for(int i=0;i<5;i++){ v+=a*n(p); p*=2.03; a*=0.5; } return v; }
        void main(){
          vec3 d = vDir * 2.4 + vec3(0.0, 0.0, uTime * 0.02);
          float c = fbm(d + fbm(d * 1.7));
          float glow = smoothstep(0.35, 0.95, c);
          vec3 col = mix(vec3(0.004,0.006,0.02), uA * 1.8, smoothstep(0.2, 0.8, c));
          col += uB * pow(glow, 3.0) * 0.55;
          // A few bright landmark clouds so turning is obvious against the sky.
          float land = smoothstep(0.62, 0.9, fbm(vDir * 1.1 + 7.0));
          col += uB * land * 0.35;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.nebula = new THREE.Mesh(new THREE.SphereGeometry(1200, 48, 24), mat);
    this.scene.add(this.nebula);
  }

  private buildStars(): void {
    this.starBase = new Float32Array(STAR_COUNT * 3);
    this.starPos = new Float32Array(STAR_COUNT * 6);
    const colors = new Float32Array(STAR_COUNT * 6);
    for (let i = 0; i < STAR_COUNT; i++) {
      for (let k = 0; k < 3; k++) this.starBase[i * 3 + k] = (Math.random() * 2 - 1) * STAR_BOX;
      const b = 0.6 + Math.random() * 0.9;
      const tint = Math.random();
      const c = tint < 0.15 ? [1, 0.8, 0.6] : tint < 0.4 ? [0.7, 0.8, 1] : [1, 1, 1];
      colors.set([c[0] * b, c[1] * b, c[2] * b], i * 6);
      colors.set([c[0] * b * 0.12, c[1] * b * 0.12, c[2] * b * 0.12], i * 6 + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.starPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.stars = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, fog: false, depthWrite: false }));
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  private buildMaterials(): void {
    this.mats.rock = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.05, flatShading: true });
    this.mats.metal = new THREE.MeshStandardMaterial({ color: 0x8894a4, roughness: 0.35, metalness: 0.85, flatShading: true });
    this.mats.hull = new THREE.MeshStandardMaterial({ color: 0x2b313d, roughness: 0.5, metalness: 0.7 });
    this.mats.enemyHull = new THREE.MeshStandardMaterial({ color: 0x3a2330, roughness: 0.35, metalness: 0.8, flatShading: true });
    this.mats.cyanGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x7fd4ff).multiplyScalar(2.2), toneMapped: false });
    this.mats.redGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2a4a).multiplyScalar(3), toneMapped: false });
    this.mats.greenGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x5bff8a).multiplyScalar(2.8), toneMapped: false });
    this.mats.ringGlow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xc38bff).multiplyScalar(2.4), toneMapped: false });
    this.mats.bolt = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x9ff8ff).multiplyScalar(4), toneMapped: false, transparent: true });
    this.mats.boltWarn = new THREE.MeshBasicMaterial({ color: 0x5ef6ff, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    this.mats.shot = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xbff6ff).multiplyScalar(5), toneMapped: false, fog: false });
    this.mats.enemyShot = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x6bff6b).multiplyScalar(5), toneMapped: false, fog: false });
  }

  private makeObstacle(kind: ObstacleKind, variant: number): Obstacle {
    let obj: THREE.Object3D;
    let r = 1;
    switch (kind) {
      case 'asteroid':
        obj = new THREE.Mesh(this.rockGeos[variant % this.rockGeos.length], this.mats.rock);
        break;
      case 'debris': {
        const g = new THREE.Group();
        const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.35, 0.9), this.mats.metal);
        const panel = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.05, 0.6), this.mats.hull);
        panel.position.set(0.9, 0.2, 0.2); panel.rotation.z = 0.5;
        const strip = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 0.06), this.mats.cyanGlow);
        strip.position.set(0, 0.2, 0.46);
        g.add(body, panel, strip);
        obj = g;
        break;
      }
      case 'mine': {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.8, 1), this.mats.hull));
        g.add(new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 8), this.mats.redGlow));
        const spikeGeo = new THREE.ConeGeometry(0.14, 0.7, 6);
        for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0.7, 0.7, 0], [-0.7, -0.7, 0]]) {
          const s = new THREE.Mesh(spikeGeo, this.mats.metal);
          const dir = new THREE.Vector3(...d).normalize();
          s.position.copy(dir).multiplyScalar(0.95);
          s.quaternion.setFromUnitVectors(Y, dir);
          g.add(s);
        }
        obj = g; r = 1.3;
        break;
      }
      case 'ring':
        obj = new THREE.Mesh(new THREE.TorusGeometry(2.8, 0.16, 8, 48), this.mats.ringGlow);
        r = 2.6;
        break;
      case 'bolt': {
        const g = new THREE.Group();
        const pts: THREE.Vector3[] = [];
        const L = 60;
        for (let i = 0; i <= 24; i++) pts.push(new THREE.Vector3(-L / 2 + (L * i) / 24, (Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 0.6));
        const path = new THREE.CurvePath<THREE.Vector3>();
        for (let i = 0; i < pts.length - 1; i++) path.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
        g.add(new THREE.Mesh(new THREE.TubeGeometry(path, 96, 0.1, 4, false), this.mats.bolt));
        g.add(new THREE.Mesh(new THREE.PlaneGeometry(L, 1.8), this.mats.boltWarn));
        obj = g; r = 0.9;
        break;
      }
    }
    obj.visible = false;
    this.scene.add(obj);
    return { obj, kind, r, active: false, spin: new THREE.Vector3(), vel: new THREE.Vector3(), prevAhead: 1e9 };
  }

  private makeEnemy(): Enemy {
    // Original fighter design: dart body, swept wings, green engine glow.
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.55, 3, 6), this.mats.enemyHull);
    body.rotation.x = -Math.PI / 2; // nose along -Z (lookAt convention)
    const wingGeo = new THREE.BoxGeometry(3.6, 0.08, 1.1);
    const wing = new THREE.Mesh(wingGeo, this.mats.enemyHull);
    wing.position.z = 0.6;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.9, 1), this.mats.enemyHull);
    fin.position.set(0, 0.4, 0.8);
    const glowL = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), this.mats.greenGlow);
    glowL.position.set(-0.9, 0, 1.2);
    const glowR = glowL.clone(); glowR.position.x = 0.9;
    const tipL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.8), this.mats.redGlow);
    tipL.position.set(-1.8, 0, 0.6);
    const tipR = tipL.clone(); tipR.position.x = 1.8;
    g.add(body, wing, fin, glowL, glowR, tipL, tipR);
    g.visible = false;
    this.scene.add(g);
    return { obj: g, active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), age: 0, life: 8, side: 1, phase: 0, fireAcc: 0 };
  }

  private buildPools(): void {
    for (let i = 0; i < 6; i++) this.rockGeos.push(asteroidGeometry(i * 13.7 + 2));
    const sizes: Record<ObstacleKind, number> = { asteroid: 40, debris: 25, mine: 14, ring: 10, bolt: 6 };
    for (const [kind, n] of Object.entries(sizes) as [ObstacleKind, number][]) {
      const arr: Obstacle[] = [];
      for (let i = 0; i < n; i++) arr.push(this.makeObstacle(kind, i));
      this.pools.set(kind, arr);
    }
    for (let i = 0; i < 3; i++) this.enemies.push(this.makeEnemy());
    const shotGeo = new THREE.CylinderGeometry(0.07, 0.07, 3.2, 6);
    for (let i = 0; i < 40; i++) {
      const enemy = i >= 24;
      const mesh = new THREE.Mesh(shotGeo, enemy ? this.mats.enemyShot : this.mats.shot);
      mesh.visible = false;
      this.scene.add(mesh);
      this.bolts.push({ mesh, active: false, vel: new THREE.Vector3(), life: 0, enemy, origin: new THREE.Vector3() });
    }
  }

  // ---------- runtime ----------
  setScenario(s: Scenario): void {
    this.targetFog.setHex(s.color);
    this.targetAccent.setHex(s.accent);
  }

  reset(): void {
    for (const o of this.active) { o.active = false; o.obj.visible = false; }
    this.active = [];
    for (const e of this.enemies) { e.active = false; e.obj.visible = false; }
    for (const b of this.bolts) { b.active = false; b.mesh.visible = false; }
    this.yawRate = this.pitchRate = this.bank = 0;
    this.spawnAcc = 0;
    this.enemyAcc = 0;
  }

  /** Position in the ship's frame: x right, y up, z ahead. */
  private local(p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    _v.subVectors(p, this.pos);
    return out.set(_v.dot(this.right), _v.dot(this.up), _v.dot(this.forward));
  }

  private spawn(kind: ObstacleKind, f: FrameInput): void {
    const o = this.pools.get(kind)!.find((p) => !p.active);
    if (!o) return;
    o.active = true;
    o.obj.visible = true;
    // Aim most hazards near the current heading so the player must react.
    const aimed = kind !== 'ring' && Math.random() < 0.65;
    // Aimed = on your line; the rest pass close by (near-miss bonus territory) or wide.
    const rad = kind === 'ring' ? 1.5 + Math.random() * 4 : aimed ? Math.random() * 1.6 : 1.8 + Math.random() * 6;
    const ang = Math.random() * Math.PI * 2;
    const dist = THREE.MathUtils.clamp((f.speed + f.hazardSpeed) * ARRIVE_S, 55, 240) + Math.random() * 12;
    o.obj.position.copy(this.pos).addScaledVector(this.forward, dist)
      .addScaledVector(this.right, Math.cos(ang) * rad).addScaledVector(this.up, Math.sin(ang) * rad);
    o.prevAhead = dist;
    o.vel.copy(this.forward).multiplyScalar(-f.hazardSpeed);
    o.spin.set((Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 1.2);
    o.obj.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    const s = f.sizeScale * (0.8 + Math.random() * 0.45);
    if (kind === 'asteroid') { o.obj.scale.setScalar(s); o.r = s * 0.9; }
    if (kind === 'debris') { const d = 0.7 + 0.5 * Math.sqrt(f.sizeScale); o.obj.scale.setScalar(d); o.r = d; o.spin.multiplyScalar(2.5); }
    if (kind === 'mine') { o.obj.scale.setScalar(1.1); o.vel.multiplyScalar(0.3); }
    if (kind === 'ring') {
      o.obj.quaternion.copy(this.quat); // faces the ship
      o.spin.set(0, 0, 0); o.vel.set(0, 0, 0);
    }
    if (kind === 'bolt') {
      const horizontal = Math.random() < 0.5;
      o.axis = (horizontal ? this.right : this.up).clone();
      o.obj.quaternion.copy(this.quat).multiply(_q.setFromAxisAngle(Z, horizontal ? 0 : Math.PI / 2));
      // Bolts are aimed at the heading so you must steer off the line.
      o.obj.position.copy(this.pos).addScaledVector(this.forward, dist)
        .addScaledVector(horizontal ? this.up : this.right, (Math.random() - 0.5) * 2);
      o.spin.set(0, 0, 0); o.vel.set(0, 0, 0);
    }
    this.active.push(o);
  }

  private spawnEnemy(): void {
    const e = this.enemies.find((x) => !x.active);
    if (!e) return;
    e.active = true; e.obj.visible = true;
    e.age = 0; e.life = 7 + Math.random() * 4; e.fireAcc = 0.8;
    e.side = Math.random() < 0.5 ? -1 : 1;
    e.phase = Math.random() * 6;
    // Swoop in from off to one side, well ahead.
    e.pos.copy(this.pos).addScaledVector(this.forward, 140).addScaledVector(this.right, e.side * 55).addScaledVector(this.up, (Math.random() - 0.5) * 30);
    e.vel.copy(this.forward).multiplyScalar(this.speed * 0.4).addScaledVector(this.right, -e.side * 30);
  }

  /** Fire the blaster from alternating wing guns, with a little aim assist. */
  fire(): void {
    const b = this.bolts.find((x) => !x.active && !x.enemy);
    if (!b) return;
    this.gunSide *= -1;
    const origin = _w.copy(this.pos).addScaledVector(this.right, this.gunSide * 0.9).addScaledVector(this.up, -0.6).addScaledVector(this.forward, 1.5);
    const dir = this.aimDir(origin);
    b.active = true; b.mesh.visible = true; b.life = 1.3; b.enemy = false;
    b.mesh.position.copy(origin);
    b.origin.copy(origin);
    b.vel.copy(dir).multiplyScalar(300).addScaledVector(this.forward, this.speed);
    b.mesh.quaternion.setFromUnitVectors(Y, dir);
  }

  /** Something shootable inside the aim cone? (autopilot fires on this) */
  hasTarget(): boolean { return this.findTarget() !== null; }

  private findTarget(): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null;
    let bestDist = 260;
    const consider = (p: THREE.Vector3) => {
      _v.subVectors(p, this.pos);
      const d = _v.length();
      if (d < 4 || d > bestDist) return;
      if (_v.dot(this.forward) / d > AIM_CONE) { best = p; bestDist = d; }
    };
    for (const e of this.enemies) if (e.active) consider(e.pos);
    for (const o of this.active) if (o.kind !== 'ring' && o.kind !== 'bolt') consider(o.obj.position);
    return best;
  }

  private aimDir(origin: THREE.Vector3): THREE.Vector3 {
    const t = this.findTarget();
    if (!t) return this.forward.clone();
    return new THREE.Vector3().subVectors(t, origin).normalize();
  }

  private fireEnemy(e: Enemy): void {
    const b = this.bolts.find((x) => !x.active && x.enemy);
    if (!b) return;
    // Lead the ship a little, with some spread so it's dodgeable.
    const target = new THREE.Vector3().copy(this.pos).addScaledVector(this.forward, this.speed * 0.4)
      .addScaledVector(this.right, (Math.random() - 0.5) * 3).addScaledVector(this.up, (Math.random() - 0.5) * 3);
    const dir = target.sub(e.pos).normalize();
    b.active = true; b.mesh.visible = true; b.life = 3; b.enemy = true;
    b.mesh.position.copy(e.pos);
    b.vel.copy(dir).multiplyScalar(85).addScaledVector(this.forward, this.speed);
    b.mesh.quaternion.setFromUnitVectors(Y, dir);
  }

  burst(pos: THREE.Vector3, color: THREE.Color, n = 60, speed = 12): void {
    const p = this.sparks.geometry.attributes.position as THREE.BufferAttribute;
    const c = this.sparks.geometry.attributes.color as THREE.BufferAttribute;
    const total = this.sparkLife.length;
    for (let i = 0; i < n; i++) {
      const k = this.sparkCursor = (this.sparkCursor + 1) % total;
      p.setXYZ(k, pos.x, pos.y, pos.z);
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.3 + Math.random()));
      this.sparkVel.set([d.x, d.y, d.z], k * 3);
      this.sparkLife[k] = 0.6 + Math.random() * 0.7;
      c.setXYZ(k, color.r * 3, color.g * 3, color.b * 3);
    }
    p.needsUpdate = true; c.needsUpdate = true;
  }

  kick(amount: number): void { this.shake = Math.min(1.2, this.shake + amount); }

  private kill(o: Obstacle, i: number): void {
    o.active = false; o.obj.visible = false; this.active.splice(i, 1);
  }

  update(dt: number, f: FrameInput): void {
    this.t += dt;
    this.speed = f.speed;

    // --- steering: turn rates change the heading; nothing re-centres it ---
    let tx = f.turn.x, ty = f.turn.y;
    if (f.autopilot) ({ x: tx, y: ty } = this.autopilot());
    if (f.navBroken) {
      tx = tx * 0.6 + Math.sin(this.t * 1.7) * 0.35 + (Math.random() - 0.5) * 0.4;
      ty = ty * 0.6 + Math.cos(this.t * 1.3) * 0.3 + (Math.random() - 0.5) * 0.4;
    }
    const k = Math.min(1, dt * 5);
    this.yawRate += (-tx * MAX_YAW - this.yawRate) * k;
    this.pitchRate += (ty * MAX_PITCH - this.pitchRate) * k;
    this.quat.multiply(_q.setFromAxisAngle(Y, this.yawRate * dt)).multiply(_q.setFromAxisAngle(X, this.pitchRate * dt)).normalize();
    this.forward.set(0, 0, -1).applyQuaternion(this.quat);
    this.right.set(1, 0, 0).applyQuaternion(this.quat);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.pos.addScaledVector(this.forward, f.speed * dt);

    // Bank into turns (visual only) plus a little shake on hits.
    this.bank += (this.yawRate * 0.45 - this.bank) * Math.min(1, dt * 4);
    this.shake *= Math.pow(0.02, dt);
    const sh = this.shake * 0.3;
    this.camera.position.copy(this.pos).addScaledVector(this.right, (Math.random() - 0.5) * sh).addScaledVector(this.up, (Math.random() - 0.5) * sh);
    this.camera.quaternion.copy(this.quat).multiply(_q.setFromAxisAngle(Z, this.bank + (Math.random() - 0.5) * sh * 0.05));

    // --- sector colours ---
    const c = Math.min(1, dt * 1.2);
    this.fog.color.lerp(this.targetFog, c);
    this.nebula.material.uniforms.uA.value.lerp(this.targetFog, c);
    this.nebula.material.uniforms.uB.value.lerp(this.targetAccent, c);
    this.nebula.material.uniforms.uTime.value = this.t;
    this.accentLight.color.lerp(this.targetAccent, Math.min(1, dt * 2));
    this.nebula.position.copy(this.camera.position);

    // --- stars: world-space, wrapped around the ship; streaks along our motion ---
    const streak = 0.5 + f.speed * 0.045 + f.warp * 30;
    const fx = this.forward.x * streak, fy = this.forward.y * streak, fz = this.forward.z * streak;
    const px = this.pos.x, py = this.pos.y, pz = this.pos.z, B = STAR_BOX, B2 = STAR_BOX * 2;
    for (let i = 0; i < STAR_COUNT; i++) {
      const j = i * 3;
      let x = this.starBase[j], y = this.starBase[j + 1], z = this.starBase[j + 2];
      if (x - px > B) x -= B2; else if (x - px < -B) x += B2;
      if (y - py > B) y -= B2; else if (y - py < -B) y += B2;
      if (z - pz > B) z -= B2; else if (z - pz < -B) z += B2;
      this.starBase[j] = x; this.starBase[j + 1] = y; this.starBase[j + 2] = z;
      const o = i * 6;
      this.starPos[o] = x; this.starPos[o + 1] = y; this.starPos[o + 2] = z;
      this.starPos[o + 3] = x + fx; this.starPos[o + 4] = y + fy; this.starPos[o + 5] = z + fz;
    }
    (this.stars.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;

    // --- spawning: one hazard at a time, never clustered ---
    if (Number.isFinite(f.spawnGap) && f.kinds.length) {
      this.spawnAcc += dt;
      if (this.spawnAcc >= f.spawnGap) {
        this.spawnAcc = 0;
        this.spawn(f.kinds[Math.floor(Math.random() * f.kinds.length)], f);
      }
    }
    if (Number.isFinite(f.enemyGap)) {
      this.enemyAcc += dt;
      const live = this.enemies.filter((e) => e.active).length;
      if (this.enemyAcc >= f.enemyGap && live < f.maxEnemies) { this.enemyAcc = 0; this.spawnEnemy(); }
    }

    // --- hazards ---
    const pulse = 0.6 + 0.4 * Math.sin(this.t * 10);
    (this.mats.redGlow as THREE.MeshBasicMaterial).color.setRGB(3 * pulse + 0.4, 0.2 * pulse, 0.4 * pulse);
    (this.mats.bolt as THREE.MeshBasicMaterial).opacity = Math.random() < 0.25 ? 0.25 : 1;
    const loc = new THREE.Vector3();
    for (let i = this.active.length - 1; i >= 0; i--) {
      const o = this.active[i];
      const pos = o.obj.position;
      pos.addScaledVector(o.vel, dt);
      o.obj.rotation.x += o.spin.x * dt;
      o.obj.rotation.y += o.spin.y * dt;
      o.obj.rotation.z += o.spin.z * dt;
      this.local(pos, loc);
      o.obj.visible = !(f.sensorsBroken && o.kind !== 'ring') || loc.z < 70 || Math.random() < 0.08;

      let hit = false;
      if (o.prevAhead > 0 && loc.z <= 0) {
        // Crossed the ship's plane this frame: swept check against the lateral offset.
        const lateral = Math.hypot(loc.x, loc.y);
        if (o.kind === 'ring') {
          if (lateral < o.r - 0.4) { this.events.onRing(); this.burst(pos.clone(), new THREE.Color(0xc38bff), 50, 8); }
        } else if (o.kind === 'bolt') {
          _w.subVectors(pos, this.pos);
          const along = _w.dot(o.axis!);
          const off = _w.addScaledVector(o.axis!, -along).length();
          hit = off < o.r + SHIP_R * 0.5;
        } else {
          hit = lateral < o.r + SHIP_R;
          const clear = lateral - (o.r + SHIP_R);
          if (!hit && clear < 2.5) this.events.onNearMiss(1 - clear / 2.5);
        }
      } else if (o.kind !== 'ring' && o.kind !== 'bolt' && loc.length() < o.r + SHIP_R) hit = true;
      o.prevAhead = loc.z;

      if (hit) {
        this.events.onHit(o.kind);
        const col = o.kind === 'mine' ? 0xff5a3a : o.kind === 'bolt' ? 0x9ff8ff : 0xffb070;
        this.burst(_w.copy(this.pos).addScaledVector(this.forward, 3), new THREE.Color(col), o.kind === 'mine' ? 140 : 70, o.kind === 'mine' ? 18 : 11);
        this.kick(o.kind === 'mine' ? 1 : 0.6);
        if (o.kind !== 'bolt') { this.kill(o, i); continue; }
      }
      if (loc.z < -20 || loc.lengthSq() > 450 * 450) this.kill(o, i);
    }

    // --- enemy fighters: curved swoops that keep pace, then peel off ---
    for (const e of this.enemies) {
      if (!e.active) continue;
      e.age += dt;
      const leaving = e.age > e.life;
      const desired = new THREE.Vector3().copy(this.pos);
      if (!leaving) {
        desired.addScaledVector(this.forward, 34 + 10 * Math.sin(e.age * 0.8 + e.phase))
          .addScaledVector(this.right, e.side * 9 * Math.sin(e.age * 1.1 + e.phase))
          .addScaledVector(this.up, 5 * Math.cos(e.age * 1.4 + e.phase));
      } else {
        desired.addScaledVector(this.forward, -60).addScaledVector(this.right, e.side * 70).addScaledVector(this.up, 25);
      }
      const shipVel = _w.copy(this.forward).multiplyScalar(f.speed);
      const acc = new THREE.Vector3().subVectors(desired, e.pos).multiplyScalar(2.6).addScaledVector(new THREE.Vector3().subVectors(e.vel, shipVel), -2.2);
      e.vel.addScaledVector(acc, dt);
      e.pos.addScaledVector(e.vel, dt);
      e.obj.position.copy(e.pos);
      const relVel = new THREE.Vector3().subVectors(e.vel, shipVel);
      // lookAt() points +Z at the target and the fighter's nose is -Z, so aim the
      // tail away: nose toward the ship while attacking, along its motion when leaving.
      const noseDir = leaving ? relVel.clone().normalize() : new THREE.Vector3().subVectors(this.pos, e.pos).normalize();
      e.obj.lookAt(new THREE.Vector3().copy(e.pos).sub(noseDir));
      // Bank the fighter into its sideways motion.
      e.obj.rotateZ(THREE.MathUtils.clamp(-relVel.dot(this.right) * 0.05, -0.8, 0.8));
      this.local(e.pos, loc);
      if (!leaving && e.age > 1.2 && loc.z > 12) {
        e.fireAcc -= dt;
        if (e.fireAcc <= 0) { e.fireAcc = f.enemyFireGap * (0.7 + Math.random() * 0.6); this.fireEnemy(e); }
      }
      if (loc.length() < 2.2) {
        this.events.onHit('enemy');
        this.explodeEnemy(e);
        continue;
      }
      if (e.age > e.life + 6 || loc.lengthSq() > 500 * 500) { e.active = false; e.obj.visible = false; }
    }

    // --- blaster bolts ---
    const prev = new THREE.Vector3();
    for (const b of this.bolts) {
      if (!b.active) continue;
      b.life -= dt;
      prev.copy(b.mesh.position);
      b.mesh.position.addScaledVector(b.vel, dt);
      if (b.life <= 0) { b.active = false; b.mesh.visible = false; if (!b.enemy) this.events.onMiss(); continue; }
      if (b.enemy) {
        if (segDist(this.pos, prev, b.mesh.position) < 1.1) {
          b.active = false; b.mesh.visible = false;
          this.events.onHit('laser');
          this.burst(_w.copy(this.pos).addScaledVector(this.forward, 2.5), new THREE.Color(0x6bff6b), 50, 8);
          this.kick(0.5);
        }
        continue;
      }
      for (const e of this.enemies) {
        if (e.active && segDist(e.pos, prev, b.mesh.position) < 2.4) {
          b.active = false; b.mesh.visible = false;
          const range = e.pos.distanceTo(b.origin);
          this.explodeEnemy(e);
          this.events.onEnemyDestroyed(range);
          break;
        }
      }
      if (!b.active) continue;
      for (let i = this.active.length - 1; i >= 0; i--) {
        const o = this.active[i];
        if (o.kind === 'ring' || o.kind === 'bolt') continue;
        if (segDist(o.obj.position, prev, b.mesh.position) < o.r + 0.5) {
          b.active = false; b.mesh.visible = false;
          this.burst(o.obj.position.clone(), new THREE.Color(o.kind === 'mine' ? 0xff5a3a : 0xffc080), o.kind === 'mine' ? 120 : 60, o.kind === 'mine' ? 16 : 10);
          this.events.onDestroy(o.kind, o.r, o.obj.position.distanceTo(b.origin));
          this.kill(o, i);
          break;
        }
      }
    }

    // --- sparks ---
    const sp = this.sparks.geometry.attributes.position as THREE.BufferAttribute;
    const sc = this.sparks.geometry.attributes.color as THREE.BufferAttribute;
    const fade = Math.max(0, 1 - dt * 2.2);
    for (let q = 0; q < this.sparkLife.length; q++) {
      if (this.sparkLife[q] <= 0) continue;
      this.sparkLife[q] -= dt;
      sp.setXYZ(q, sp.getX(q) + this.sparkVel[q * 3] * dt, sp.getY(q) + this.sparkVel[q * 3 + 1] * dt, sp.getZ(q) + this.sparkVel[q * 3 + 2] * dt);
      sc.setXYZ(q, sc.getX(q) * fade, sc.getY(q) * fade, sc.getZ(q) * fade);
      if (this.sparkLife[q] <= 0) sp.setXYZ(q, 1e6, 1e6, 1e6);
    }
    sp.needsUpdate = true; sc.needsUpdate = true;

    // --- Temporal shield ---
    const m = this.shieldBubble.material;
    m.opacity += ((f.durable ? 0.16 + 0.05 * Math.sin(this.t * 6) : 0) - m.opacity) * Math.min(1, dt * 5);
    this.shieldBubble.visible = m.opacity > 0.005;
    this.bloom.strength = 0.9 + f.warp * 0.8 + (f.durable ? 0.25 : 0);
  }

  private explodeEnemy(e: Enemy): void {
    this.burst(e.pos.clone(), new THREE.Color(0x6bff8f), 160, 20);
    this.burst(e.pos.clone(), new THREE.Color(0xffd070), 90, 12);
    e.active = false; e.obj.visible = false;
  }

  /** Obstacle avoidance + gentle wandering for attract mode and scripted test pilots. */
  private autopilot(): { x: number; y: number } {
    const skill = this.autopilotSkill;
    const range = 40 + 100 * skill;
    let ax = Math.sin(this.t * 0.35) * this.autopilotWander;
    let ay = Math.cos(this.t * 0.27) * this.autopilotWander * 0.66;
    const loc = new THREE.Vector3();
    const avoid = (p: THREE.Vector3, r: number) => {
      this.local(p, loc);
      if (loc.z < 0 || loc.z > range) return;
      const lat = Math.hypot(loc.x, loc.y);
      if (lat > r + 3) return;
      const w = (1 - loc.z / range) * 3 * skill;
      ax -= (loc.x >= 0 ? 1 : -1) * w;
      ay -= (loc.y >= 0 ? 1 : -1) * w;
    };
    for (const o of this.active) if (o.kind !== 'ring') avoid(o.obj.position, o.r);
    // Turn gently toward the nearest enemy so the blaster has something to hit.
    for (const e of this.enemies) {
      if (!e.active) continue;
      this.local(e.pos, loc);
      if (loc.z > 5) { ax += THREE.MathUtils.clamp(loc.x / loc.z, -1, 1) * 0.8 * skill; ay += THREE.MathUtils.clamp(loc.y / loc.z, -1, 1) * 0.8 * skill; }
    }
    return { x: THREE.MathUtils.clamp(ax, -1, 1), y: THREE.MathUtils.clamp(ay, -1, 1) };
  }

  render(): void { this.composer.render(); }
}
