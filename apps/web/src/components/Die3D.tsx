/**
 * Premium 3D dice — a real CSS cube (6 pip faces in preserve-3d) that tumbles
 * over multiple axes and lands with the rolled value facing the camera, upright.
 * Replaces the flat SVG spin. Purely CSS/transform, zero assets.
 *
 * Face layout (opposite faces sum to 7):
 *   front 1 · back 6 · top 2 · bottom 5 · right 3 · left 4
 * Rest orientation that brings value V to the front:
 *   1→(0,0) 6→(0,180) 3→(0,-90) 4→(0,90) 2→(-90,0) 5→(90,0)  [rotX, rotY]
 */
import { useEffect, useRef, useState } from 'react';
import { DieFace } from './Die';
import type { DiceSkin } from '../lib/diceSkins';

const CUBE = 52; // px edge of the cube
const HALF = CUBE / 2;

/** [rotateX, rotateY] (deg) that seats a given die value facing the viewer. */
const REST: Record<number, [number, number]> = {
  1: [0, 0],
  2: [-90, 0],
  3: [0, -90],
  4: [0, 90],
  5: [90, 0],
  6: [0, 180],
};

/** Face placement transforms (value → transform), each pushed out by HALF. */
const FACES: Array<{ v: number; t: string }> = [
  { v: 1, t: `translateZ(${HALF}px)` },
  { v: 6, t: `rotateY(180deg) translateZ(${HALF}px)` },
  { v: 3, t: `rotateY(90deg) translateZ(${HALF}px)` },
  { v: 4, t: `rotateY(-90deg) translateZ(${HALF}px)` },
  { v: 2, t: `rotateX(90deg) translateZ(${HALF}px)` },
  { v: 5, t: `rotateX(-90deg) translateZ(${HALF}px)` },
];

export interface Die3DProps {
  value: number;
  /** Bumps on every fresh roll to trigger a new tumble; 0 = never rolled. */
  rollKey: number;
  skin: DiceSkin;
  /** A roll intent is in flight (online RTT) with no value yet: spin continuously
   *  from the click and land on `value` when the server's roll arrives (rollKey
   *  bumps). Purely visual — the local bot resolves instantly so it never spins. */
  spinning?: boolean;
}

/**
 * The cube accumulates whole extra turns per roll so the transform always winds
 * forward (never rewinds), landing on REST[value]. Unequal X/Y turn counts make
 * the somersault read as "all directions", not a single-axis spin.
 */
export function Die3D({ value, rollKey, skin, spinning }: Die3DProps) {
  const turns = useRef({ x: 0, y: 0 });
  const lastKey = useRef<number | null>(null);
  const [rolling, setRolling] = useState(false);
  const [rot, setRot] = useState<[number, number]>(() => REST[value] ?? [0, 0]);

  useEffect(() => {
    const base = REST[value] ?? [0, 0];
    // Settle on the value WITHOUT unwinding. The cube keeps every turn it has
    // wound on, so the rest angle must be expressed in the same wound-up frame:
    // dropping back to bare `base` is the identical orientation mod 360, but it
    // is a huge transform delta, and .die3d transitions transform ALWAYS — so the
    // die spun all its turns back off. That is what made the opponent's die
    // tumble at the exact moment the OTHER player rolled: their roll sets this
    // die's rollKey to 0, which lands here.
    const snap = (): void => {
      setRolling(false);
      setRot([base[0] + 360 * turns.current.x, base[1] + 360 * turns.current.y]);
    };
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    // no roll yet, reduced motion, or the very first mount → just show the value
    if (rollKey === 0 || reduce || lastKey.current === null) {
      lastKey.current = rollKey;
      snap();
      return;
    }
    if (rollKey === lastKey.current) return; // same roll, nothing new
    lastKey.current = rollKey;
    // wind forward by unequal whole turns, then land on the value's rest angle
    turns.current.x += 4;
    turns.current.y += 3;
    setRolling(true);
    setRot([base[0] + 360 * turns.current.x, base[1] + 360 * turns.current.y]);
    const id = setTimeout(() => setRolling(false), 700);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rollKey]);

  // The cube is ALWAYS mounted so the CSS transition can animate the tumble (a
  // freshly-mounted element can't transition — that broke the roll). Perspective
  // is applied ONLY while rolling; at rest there is none, so the face-on cube
  // projects orthographically and shows ONLY the flat result face. No tilt, so
  // there's no lean-back-to-flat settle that would flash the side faces/corners.
  return (
    <div className="die3d-stage">
      <div className={`die3d-lift${rolling || spinning ? ' die3d-lift--rolling' : ''}`}>
        <div className={`die3d${spinning ? ' die3d--spinning' : ''}`} style={{ transform: `rotateX(${rot[0]}deg) rotateY(${rot[1]}deg)` }}>
          {FACES.map((f) => (
            <div key={f.v} className="die3d__face" style={{ transform: f.t }}>
              <DieFace value={f.v} skin={skin} />
            </div>
          ))}
        </div>
      </div>
      <span className={`die3d__shadow${rolling ? ' die3d__shadow--rolling' : ''}`} aria-hidden="true" />
    </div>
  );
}
