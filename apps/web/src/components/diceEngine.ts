/**
 * Premium 3D die engine (WebGL, real PBR materials + environment reflections).
 * Imported DYNAMICALLY by DiePremium3D so `three` is code-split into its own
 * chunk — it only loads when a player equips an ultra-premium dice skin, never
 * for the default CSS die. A single tiny canvas (52px) renders at most one die
 * on screen (my own die in 1v1), and only while it tumbles (render-on-demand),
 * so it stays light even on low-end phones. Materials mirror the cosmetics lab.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { DiceSkin, DieMaterial } from '../lib/diceSkins';

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

function pipTexture(val: number, base: string, pip: string): THREE.CanvasTexture {
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
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function emissiveTexture(val: number, color: string, edge?: string): THREE.CanvasTexture {
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
  const t = new THREE.CanvasTexture(c);
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

function buildMaterials(mat: DieMaterial): THREE.Material[] {
  const spec = SPEC[mat];
  return FACE_VALS.map((v) => {
    const m = new THREE.MeshPhysicalMaterial({ map: pipTexture(v, spec.base, spec.pip) });
    if (mat === 'metal') {
      m.metalness = 1; m.roughness = 0.22; m.envMapIntensity = 1.5; m.color.set('#ffd777');
    } else if (mat === 'glass') {
      m.metalness = 0.35; m.roughness = 0.12; m.clearcoat = 1; m.clearcoatRoughness = 0.08;
      m.color.set('#0d0d12'); m.emissive = new THREE.Color('#ff2d55'); m.emissiveMap = emissiveTexture(v, '#ff2d55'); m.emissiveIntensity = 2.2;
    } else if (mat === 'gem') {
      // Opaque icy diamond: a hint of translucency for depth, but readable pips
      // (was transmission 0.9 → too see-through). Clearcoat + reflections = sparkle.
      m.transmission = 0.15; m.thickness = 0.4; m.roughness = 0.06; m.ior = 1.7; m.metalness = 0;
      m.clearcoat = 1; m.clearcoatRoughness = 0.05; m.color.set('#bfe6ff'); m.envMapIntensity = 1.7;
    } else if (mat === 'irid') {
      m.metalness = 1; m.roughness = 0.25; m.iridescence = 1; m.iridescenceIOR = 1.6; m.envMapIntensity = 1.4; m.color.set('#9a8cff');
    } else if (mat === 'cyber') {
      m.metalness = 0.5; m.roughness = 0.3; m.color.set('#0a1620'); m.emissive = new THREE.Color('#39f6d2'); m.emissiveMap = emissiveTexture(v, '#39f6d2', '#39f6d2'); m.emissiveIntensity = 2.6;
    } else if (mat === 'molten') {
      m.metalness = 0.2; m.roughness = 0.55; m.color.set('#1a0603'); m.emissive = new THREE.Color('#ff5a1e'); m.emissiveMap = emissiveTexture(v, '#ff7a2e', '#ff7a2e'); m.emissiveIntensity = 2.4;
    }
    return m;
  });
}
function disposeMaterials(mats: THREE.Material[] | THREE.Material): void {
  const arr = Array.isArray(mats) ? mats : [mats];
  for (const m of arr) {
    const pm = m as THREE.MeshPhysicalMaterial;
    pm.map?.dispose();
    pm.emissiveMap?.dispose();
    m.dispose();
  }
}

export interface DieEngine {
  roll(value: number, tumble: boolean): void;
  setSkin(skin: DiceSkin): void;
  dispose(): void;
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(size, size, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  // Farther back so the die fills ~71% of the canvas: its resting face then
  // matches the default 52px die (host is ~140% of the stage) AND the spinning
  // diagonal still fits the canvas without clipping.
  camera.position.set(0, 0, 4.64);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;

  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(3, 4, 5);
  scene.add(key);
  scene.add(new THREE.AmbientLight(0x99aaff, 0.4));

  const geo = new RoundedBoxGeometry(1.6, 1.6, 1.6, 6, 0.2);
  let materials = buildMaterials(skin.material ?? 'metal');
  const die = new THREE.Mesh(geo, materials);
  scene.add(die);

  const rest = (v: number): [number, number] => REST[v] ?? [0, 0];
  const seat = (v: number): void => { const [rx, ry] = rest(v); die.rotation.set(rx, ry, 0); };
  seat(value);

  let raf = 0;
  let anim: { from: THREE.Euler; toX: number; toY: number; toZ: number; end: [number, number]; start: number } | null = null;
  const renderOnce = (): void => renderer.render(scene, camera);
  renderOnce();

  const loop = (): void => {
    if (!anim) { raf = 0; return; }
    const p = Math.min((performance.now() - anim.start) / 850, 1);
    const e = easeOutCubic(p);
    die.rotation.x = anim.from.x + (anim.toX - anim.from.x) * e;
    die.rotation.y = anim.from.y + (anim.toY - anim.from.y) * e;
    die.rotation.z = anim.from.z + (anim.toZ - anim.from.z) * e;
    renderOnce();
    if (p >= 1) { die.rotation.set(anim.end[0], anim.end[1], 0); renderOnce(); anim = null; raf = 0; return; }
    raf = requestAnimationFrame(loop);
  };

  return {
    roll(v, tumble) {
      const [rx, ry] = rest(v);
      if (!tumble) { seat(v); renderOnce(); return; }
      const from = die.rotation.clone();
      anim = {
        from,
        toX: rx + Math.PI * 2 * (2 + Math.floor(Math.random() * 2)),
        toY: ry + Math.PI * 2 * (3 + Math.floor(Math.random() * 2)),
        toZ: Math.PI * (Math.random() * 1.2 - 0.6),
        end: [rx, ry],
        start: performance.now(),
      };
      if (!raf) raf = requestAnimationFrame(loop);
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
