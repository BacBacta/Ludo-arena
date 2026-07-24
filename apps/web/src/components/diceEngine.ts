/**
 * Premium 3D die engine (WebGL, real PBR materials + environment reflections).
 * Imported DYNAMICALLY by DiePremium3D so `three` is code-split into its own
 * chunk — it only loads when a player equips an ultra-premium dice skin, never
 * for the default CSS die. A single tiny canvas (52px) renders at most one die
 * on screen (my own die in 1v1), and only while it tumbles (render-on-demand),
 * so it stays light even on low-end phones. Materials mirror the cosmetics lab.
 */
// NAMED imports, and a size audit so nobody re-litigates this chunk blindly:
// Rollup already tree-shakes three's ESM (probing the built chunk finds no
// audio/curves/extra geometries/raycaster) — what remains (~117 KB gzip) is the
// WebGLRenderer's irreducible support graph + MeshPhysicalMaterial. Upgrading
// three makes it WORSE (0.185 builds 131.7 KB vs 0.160's 117.4). The chunk is
// also LAZY and GATED: DiePremium only imports it when a skin declares a
// `material` (ultra-premium dice) — the landing critical path never pays it.
// Real further reduction = swapping WebGL engines and re-creating the PBR look.
import {
  ACESFilmicToneMapping,
  AmbientLight,
  CanvasTexture,
  Color,
  DirectionalLight,
  Mesh,
  MeshPhysicalMaterial,
  PMREMGenerator,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
  type Euler,
  type Material,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { DiceSkin, DieMaterial } from '../lib/diceSkins';
import { DIE_TUMBLE_MS } from '../lib/pacing';

const PIPS: Record<number, Array<[number, number]>> = {
  1: [[0.5, 0.5]],
  2: [[0.3, 0.3], [0.7, 0.7]],
  3: [[0.28, 0.28], [0.5, 0.5], [0.72, 0.72]],
  4: [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]],
  5: [[0.3, 0.3], [0.7, 0.3], [0.5, 0.5], [0.3, 0.7], [0.7, 0.7]],
  6: [[0.3, 0.26], [0.7, 0.26], [0.3, 0.5], [0.7, 0.5], [0.3, 0.74], [0.7, 0.74]],
};
// BoxGeometry material order (+X,-X,+Y,-Y,+Z,-Z) → die values (opposite sum 7).
const FACE_VALS = [3, 4, 2, 5, 1, 6];
// Euler [rotX, rotY] that seats a given value facing the camera (+Z).
const REST: Record<number, [number, number]> = {
  1: [0, 0], 2: [Math.PI / 2, 0], 3: [0, -Math.PI / 2],
  4: [0, Math.PI / 2], 5: [-Math.PI / 2, 0], 6: [0, Math.PI],
};

function pipTexture(val: number, base: string, pip: string): CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d')!;
  x.fillStyle = base;
  x.fillRect(0, 0, S, S);
  for (const [px, py] of PIPS[val]!) {
    const cx = px * S, cy = py * S, r = S * 0.075;
    x.fillStyle = pip;
    x.beginPath();
    x.arc(cx, cy, r, 0, 7);
    x.fill();
    x.fillStyle = 'rgba(255,255,255,.4)';
    x.beginPath();
    x.arc(cx - r * 0.3, cy - r * 0.35, r * 0.35, 0, 7);
    x.fill();
  }
  const t = new CanvasTexture(c);
  t.anisotropy = 4;
  t.colorSpace = SRGBColorSpace;
  return t;
}
function emissiveTexture(val: number, color: string, edge?: string): CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d')!;
  x.fillStyle = '#000';
  x.fillRect(0, 0, S, S);
  if (edge) {
    x.strokeStyle = edge;
    x.lineWidth = S * 0.06;
    x.strokeRect(S * 0.1, S * 0.1, S * 0.8, S * 0.8);
  }
  for (const [px, py] of PIPS[val]!) {
    x.fillStyle = color;
    x.beginPath();
    x.arc(px * S, py * S, S * 0.075, 0, 7);
    x.fill();
  }
  const t = new CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

/** Face color spec (base + pip) per material, matching the validated lab look. */
const SPEC: Record<DieMaterial, { base: string; pip: string }> = {
  metal: { base: '#e8b23a', pip: '#7a5200' },
  glass: { base: '#14141b', pip: '#2a2a34' },
  gem: { base: '#dff1ff', pip: '#124a72' },
  irid: { base: '#8f7fe0', pip: '#221a55' },
  cyber: { base: '#0b1a24', pip: '#0b1a24' },
  molten: { base: '#2a0a06', pip: '#2a0a06' },
};

function buildMaterials(mat: DieMaterial): Material[] {
  const spec = SPEC[mat];
  return FACE_VALS.map((v) => {
    const m = new MeshPhysicalMaterial({ map: pipTexture(v, spec.base, spec.pip) });
    if (mat === 'metal') {
      m.metalness = 1; m.roughness = 0.22; m.envMapIntensity = 1.5; m.color.set('#ffd777');
    } else if (mat === 'glass') {
      m.metalness = 0.35; m.roughness = 0.12; m.clearcoat = 1; m.clearcoatRoughness = 0.08;
      m.color.set('#0d0d12'); m.emissive = new Color('#ff2d55'); m.emissiveMap = emissiveTexture(v, '#ff2d55'); m.emissiveIntensity = 2.2;
    } else if (mat === 'gem') {
      // Opaque icy diamond: a hint of translucency for depth, but readable pips
      // (was transmission 0.9 → too see-through). Clearcoat + reflections = sparkle.
      m.transmission = 0.15; m.thickness = 0.4; m.roughness = 0.06; m.ior = 1.7; m.metalness = 0;
      m.clearcoat = 1; m.clearcoatRoughness = 0.05; m.color.set('#bfe6ff'); m.envMapIntensity = 1.7;
    } else if (mat === 'irid') {
      m.metalness = 1; m.roughness = 0.25; m.iridescence = 1; m.iridescenceIOR = 1.6; m.envMapIntensity = 1.4; m.color.set('#9a8cff');
    } else if (mat === 'cyber') {
      m.metalness = 0.5; m.roughness = 0.3; m.color.set('#0a1620'); m.emissive = new Color('#39f6d2'); m.emissiveMap = emissiveTexture(v, '#39f6d2', '#39f6d2'); m.emissiveIntensity = 2.6;
    } else if (mat === 'molten') {
      m.metalness = 0.2; m.roughness = 0.55; m.color.set('#1a0603'); m.emissive = new Color('#ff5a1e'); m.emissiveMap = emissiveTexture(v, '#ff7a2e', '#ff7a2e'); m.emissiveIntensity = 2.4;
    }
    return m;
  });
}
function disposeMaterials(mats: Material[] | Material): void {
  const arr = Array.isArray(mats) ? mats : [mats];
  for (const m of arr) {
    const pm = m as MeshPhysicalMaterial;
    pm.map?.dispose();
    pm.emissiveMap?.dispose();
    m.dispose();
  }
}

export interface DieEngine {
  roll(value: number, tumble: boolean): void;
  /** Optimistic in-flight spin (online RTT): tumble continuously from the tap
   *  until the server value lands via roll(). Mirrors Die3D's `spinning` prop. */
  setSpinning(on: boolean): void;
  setSkin(skin: DiceSkin): void;
  dispose(): void;
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** Quick, decisive settle straight out of a spin — mirrors .die3d--landing
 *  (0.32s): the die already tumbled through the RTT, so the server value just
 *  snaps onto the face and the number reads almost at once. A full tumble
 *  stacked on top of the spin left the result visible for only ~150ms before
 *  the auto-move fired and the turn passed (the reported instability). */
const LAND_MS = 320;
/** Continuous spin rate (rad/s) — matched to the CSS die's optimistic spin
 *  (Die3D winds +4 X / +3 Y whole turns per 0.7s transition), so a premium
 *  WebGL die tumbles with the SAME energy as the default die. The first cut
 *  used 5.5/4.2 (~0.9 turns/s) — visibly sluggish next to the bot's die. */
const SPIN_X = (Math.PI * 2 * 4) / 0.7;
const SPIN_Y = (Math.PI * 2 * 3) / 0.7;

/** Build a WebGL die inside `host`. Throws if WebGL is unavailable (caller falls
 *  back to the CSS die). Renders on-demand: it draws while tumbling, then rests. */
export function createDieEngine(host: HTMLElement, skin: DiceSkin, value: number): DieEngine {
  const size = 96; // internal render size (device px handled by pixelRatio)
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  host.appendChild(canvas);

  // preserveDrawingBuffer keeps the last frame on screen when we render on-demand
  // (a die at rest is drawn once, then the loop stops) — without it the browser
  // clears the buffer after compositing and the die vanishes a frame later.
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(size, size, false);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new Scene();
  const camera = new PerspectiveCamera(32, 1, 0.1, 100);
  // Farther back so the die fills ~71% of the canvas: its resting face then
  // matches the default 52px die (host is ~140% of the stage) AND the spinning
  // diagonal still fits the canvas without clipping.
  camera.position.set(0, 0, 4.64);

  const pmrem = new PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;

  const key = new DirectionalLight(0xffffff, 1.5);
  key.position.set(3, 4, 5);
  scene.add(key);
  scene.add(new AmbientLight(0x99aaff, 0.4));

  const geo = new RoundedBoxGeometry(1.6, 1.6, 1.6, 6, 0.2);
  let materials = buildMaterials(skin.material ?? 'metal');
  const die = new Mesh(geo, materials);
  scene.add(die);

  const rest = (v: number): [number, number] => REST[v] ?? [0, 0];
  const seat = (v: number): void => { const [rx, ry] = rest(v); die.rotation.set(rx, ry, 0); };
  seat(value);

  let raf = 0;
  let anim: { from: Euler; toX: number; toY: number; toZ: number; end: [number, number]; start: number; dur: number } | null = null;
  let spinning = false; // optimistic in-flight spin (no value yet)
  let justSpun = false; // the next roll follows a spin → short landing, not a fresh tumble
  let lastSpinTs = 0;
  let lastValue = value; // last seated/landed value (fallback settle target)
  const renderOnce = (): void => renderer.render(scene, camera);
  renderOnce();

  const loop = (): void => {
    const now = performance.now();
    if (anim) {
      const p = Math.min((now - anim.start) / anim.dur, 1);
      const e = easeOutCubic(p);
      die.rotation.x = anim.from.x + (anim.toX - anim.from.x) * e;
      die.rotation.y = anim.from.y + (anim.toY - anim.from.y) * e;
      die.rotation.z = anim.from.z + (anim.toZ - anim.from.z) * e;
      renderOnce();
      if (p >= 1) {
        die.rotation.set(anim.end[0], anim.end[1], 0);
        renderOnce();
        anim = null;
        if (!spinning) { raf = 0; return; }
        lastSpinTs = now; // an in-flight spin resumes seamlessly after the anim
      }
    } else if (spinning) {
      // Constant forward winding through the RTT (clamped dt so a background
      // tab doesn't fast-forward into a violent jump on return).
      const dt = Math.min((now - lastSpinTs) / 1000, 0.05);
      lastSpinTs = now;
      die.rotation.x += SPIN_X * dt;
      die.rotation.y += SPIN_Y * dt;
      renderOnce();
    } else { raf = 0; return; }
    raf = requestAnimationFrame(loop);
  };
  const kick = (): void => { if (!raf) raf = requestAnimationFrame(loop); };

  /** Rest orientation FORWARD of the current rotation, one extra whole turn out
   *  (never rewinds — same rule as Die3D's wound-up settle, which lands with a
   *  full +1-turn somersault). A bare next-rest target made the landing a limp
   *  fraction-of-a-turn snap. */
  const forwardRest = (v: number): { toX: number; toY: number; end: [number, number] } => {
    const [rx, ry] = rest(v);
    const TAU = Math.PI * 2;
    const toX = rx + TAU * (Math.floor((die.rotation.x - rx) / TAU) + 2);
    const toY = ry + TAU * (Math.floor((die.rotation.y - ry) / TAU) + 2);
    return { toX, toY, end: [rx, ry] };
  };

  return {
    roll(v, tumble) {
      spinning = false; // a roll always resolves the in-flight spin
      lastValue = v;
      const [rx, ry] = rest(v);
      if (!tumble) { anim = null; seat(v); renderOnce(); return; }
      const from = die.rotation.clone();
      if (justSpun) {
        // Landing out of an optimistic spin: snap forward onto the face in
        // LAND_MS — the die already tumbled through the RTT (mirrors Die3D).
        justSpun = false;
        const f = forwardRest(v);
        anim = { from, toX: f.toX, toY: f.toY, toZ: 0, end: f.end, start: performance.now(), dur: LAND_MS };
      } else {
        // Same winding as the CSS die's fresh tumble (+4 X / +3 Y whole turns
        // over DIE_TUMBLE_MS) — the premium die rolls with the bot-die energy.
        anim = {
          from,
          toX: rx + Math.PI * 2 * 4,
          toY: ry + Math.PI * 2 * 3,
          toZ: Math.PI * (Math.random() * 1.2 - 0.6),
          end: [rx, ry],
          start: performance.now(),
          dur: DIE_TUMBLE_MS,
        };
      }
      kick();
    },
    setSpinning(on) {
      if (on === spinning) return;
      spinning = on;
      if (on) {
        justSpun = true;
        lastSpinTs = performance.now();
        kick();
        return;
      }
      // Spin ended WITHOUT a roll in the same commit (server error / cleared
      // intent): settle softly onto the last value instead of freezing mid-air.
      // The normal path (roll() in the same React commit) replaces this anim
      // immediately, so it never shows.
      if (justSpun && !anim) {
        justSpun = false;
        const f = forwardRest(lastValue);
        anim = { from: die.rotation.clone(), toX: f.toX, toY: f.toY, toZ: 0, end: f.end, start: performance.now(), dur: LAND_MS };
        kick();
      }
    },
    setSkin(next) {
      disposeMaterials(materials);
      materials = buildMaterials(next.material ?? 'metal');
      die.material = materials;
      renderOnce();
    },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      disposeMaterials(materials);
      geo.dispose();
      envRT.dispose?.();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss?.();
      canvas.remove();
    },
  };
}
