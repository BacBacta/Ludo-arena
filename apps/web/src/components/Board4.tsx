/**
 * 4-player Ludo board (practice mode) — renders all four seats: blue (you,
 * bottom-left), red (top-left), green (top-right), yellow (bottom-right).
 * Same candy visual language as the 2-player <Board>, driven by ludo4 geometry.
 */
import { useEffect, useRef, useState } from 'react';
import { SAFE_CELLS, TRACK } from '@ludo/game-engine';
import { BASE_SPOTS4, HOME_COLUMNS4, SEAT_START4, tokenXY4, type Game4 } from '../lib/ludo4';
import { WALK_STEP_MS, WALK_TWEEN_MS } from '../lib/pacing';

const RED = ['#FF8A7E', '#E23B3B', '#AE2A2F'] as const;
const GREEN = ['#66C972', '#2FA84F', '#1F7C38'] as const;
const YELLOW = ['#FFDD66', '#F5C21B', '#C08F00'] as const;
const BLUE = ['#7DD6F7', '#1CA0E6', '#1478B0'] as const;

/** seat → colour triple (matches ludo4 seat order). */
const SEAT_COLORS = [BLUE, RED, GREEN, YELLOW] as const;
/** seat → quadrant origin. */
const SEAT_QUAD: ReadonlyArray<readonly [number, number]> = [
  [0, 9],
  [0, 0],
  [9, 0],
  [9, 9],
];
/** quadrant origin → colour (for drawing the four panels). */
const QUADS: Array<{ o: readonly [number, number]; c: readonly [string, string, string] }> = [
  { o: [0, 0], c: RED },
  { o: [9, 0], c: GREEN },
  { o: [0, 9], c: BLUE },
  { o: [9, 9], c: YELLOW },
];

export interface PlayerBanner4 {
  seat: number;
  name: string;
  flag: string;
  active: boolean;
}

function homeCenter(qx: number, qy: number): [number, number] {
  const isTop = qy === 0;
  const hy = isTop ? qy + 1.35 : qy + 0.25;
  return [qx + 3, hy + 2.2];
}
function quadSlots(qx: number, qy: number): Array<[number, number]> {
  const [cx, cy] = homeCenter(qx, qy);
  return [
    [cx - 0.8, cy - 0.8],
    [cx + 0.8, cy - 0.8],
    [cx - 0.8, cy + 0.8],
    [cx + 0.8, cy + 0.8],
  ];
}
function starPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.46;
    pts.push(`${(cx + Math.cos(a) * rr).toFixed(3)},${(cy + Math.sin(a) * rr).toFixed(3)}`);
  }
  return pts.join(' ');
}
function baseSlotXY(seat: number, token: number): [number, number] {
  const s = BASE_SPOTS4[seat]?.[token];
  return s ? [s[0], s[1]] : [7.5, 7.5];
}

/** Chunky injection-moulded glossy peg with hot-spot, Fresnel rim + soft shadow. */
function Pawn({ seat }: { seat: number }) {
  const c = SEAT_COLORS[seat] ?? BLUE;
  const dark = c[2];
  const rim = c[0];
  const gid = `peg4-${seat}`;
  const hid = `peghead4-${seat}`;
  return (
    <>
      <defs>
        {/* body: light → base → deep terminator */}
        <linearGradient id={gid} x1="0" y1="0" x2="0.18" y2="1">
          <stop offset="0%" stopColor={c[0]} />
          <stop offset="46%" stopColor={c[1]} />
          <stop offset="100%" stopColor={c[2]} />
        </linearGradient>
        {/* head: radial glossy sphere, hot-spot upper-left */}
        <radialGradient id={hid} cx="35%" cy="28%" r="85%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="22%" stopColor={c[0]} />
          <stop offset="62%" stopColor={c[1]} />
          <stop offset="100%" stopColor={c[2]} />
        </radialGradient>
      </defs>
      {/* soft contact shadow */}
      <ellipse cx={0.03} cy={0.46} rx={0.36} ry={0.1} fill="url(#pawnCast4)" />
      {/* tall glossy skittle body: wide round foot → pinched waist → neck */}
      <path
        d="M -0.36 0.42 C -0.38 0.18 -0.14 0.14 -0.1 -0.1 C -0.09 -0.2 -0.085 -0.24 0 -0.24 C 0.085 -0.24 0.09 -0.2 0.1 -0.1 C 0.14 0.14 0.38 0.18 0.36 0.42 Q 0.36 0.51 0 0.51 Q -0.36 0.51 -0.36 0.42 Z"
        fill={`url(#${gid})`}
        stroke={dark}
        strokeWidth={0.026}
      />
      {/* broad lengthwise gloss down the flare + bright edge */}
      <path d="M -0.11 0.44 C -0.2 0.18 -0.09 0.0 -0.06 -0.12" fill="none" stroke="#ffffff" strokeWidth={0.09} strokeLinecap="round" opacity={0.3} />
      <path d="M 0.14 0.42 C 0.2 0.2 0.12 0.04 0.09 -0.1" fill="none" stroke={c[0]} strokeWidth={0.04} strokeLinecap="round" opacity={0.6} />
      {/* neck occlusion */}
      <ellipse cx={0} cy={-0.2} rx={0.11} ry={0.04} fill={dark} opacity={0.4} />
      {/* glossy spherical head */}
      <circle cx={0} cy={-0.37} r={0.2} fill={`url(#${hid})`} stroke={dark} strokeWidth={0.026} />
      <path d="M 0.17 -0.44 A 0.2 0.2 0 0 1 0.05 -0.19" fill="none" stroke={rim} strokeWidth={0.032} strokeLinecap="round" opacity={0.9} />
      <ellipse cx={-0.075} cy={-0.45} rx={0.08} ry={0.06} fill="#ffffff" opacity={0.98} />
      <ellipse cx={0.02} cy={-0.3} rx={0.05} ry={0.08} fill="#ffffff" opacity={0.2} />
    </>
  );
}

function Quadrant({ x, y, colors }: { x: number; y: number; colors: readonly [string, string, string] }) {
  const isTop = y === 0;
  const hy = isTop ? y + 1.35 : y + 0.25;
  const slots = quadSlots(x, y);
  return (
    <g>
      {/* flat solid quadrant (Ludo Club is matte, not glossy) + faint top sheen */}
      <rect x={x} y={y} width={6} height={6} rx={0.5} fill={colors[1]} />
      <rect x={x + 0.82} y={hy + 0.08} width={4.4} height={4.4} rx={0.5} fill="rgba(16,24,48,.14)" />
      <rect x={x + 0.8} y={hy} width={4.4} height={4.4} rx={0.5} fill="#ffffff" />
      <rect x={x + 0.8} y={hy} width={4.4} height={4.4} rx={0.5} fill="none" stroke={colors[2]} strokeWidth={0.05} opacity={0.14} />
      {/* flat grey shadow coasters (pawns rest on these) */}
      {slots.map(([sx, sy], i) => (
        <ellipse key={i} cx={sx} cy={sy + 0.06} rx={0.46} ry={0.3} fill="#dfe4ee" />
      ))}
    </g>
  );
}

interface Burst {
  key: number;
  x: number;
  y: number;
  seat: number;
}

function useAnimated4(positions: number[][]): number[][] {
  const [display, setDisplay] = useState(positions);
  const ref = useRef(display);
  ref.current = display;
  useEffect(() => {
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const differs = positions.some((row, s) => row.some((t, k) => t !== ref.current[s]?.[k]));
    if (!differs) return;
    if (reduce) {
      setDisplay(positions.map((r) => [...r]));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      let changed = false;
      const next = ref.current.map((row, seat) =>
        row.map((d, token) => {
          const tgt = positions[seat]?.[token] ?? d;
          if (d === tgt) return d;
          changed = true;
          return tgt > d && d >= 0 ? d + 1 : tgt;
        }),
      );
      if (changed) {
        setDisplay(next);
        timer = setTimeout(tick, WALK_STEP_MS);
      }
    };
    tick();
    return () => clearTimeout(timer);
  }, [positions]);
  return display;
}

export interface Board4Props {
  game: Game4;
  mySeat: number;
  onTokenTap(token: number): void;
  banners?: PlayerBanner4[];
}

export function Board4({ game, mySeat, onTokenTap, banners }: Board4Props) {
  const movable = game.turn === mySeat && game.phase === 'awaiting-move' ? game.legal : [];
  const positions = useAnimated4(game.positions);

  const prevRef = useRef(game.positions);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [shake, setShake] = useState(false);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = game.positions;
    game.positions.forEach((row, seat) =>
      row.forEach((pos, token) => {
        const before = prev[seat]?.[token];
        if (before !== undefined && before >= 0 && pos === -1) {
          const [x, y] = tokenXY4(seat, token, before);
          const key = Date.now() + seat * 100 + token;
          setBursts((b) => [...b, { key, x, y, seat }]);
          setShake(true);
          setTimeout(() => setShake(false), 320);
          setTimeout(() => setBursts((b) => b.filter((bb) => bb.key !== key)), 650);
        }
      }),
    );
  }, [game.positions]);

  const edgeChevron = (cx: number, cy: number, deg: number, color: string, key: string) => (
    <g key={key} transform={`rotate(${deg} ${cx} ${cy})`}>
      <path
        d={`M ${cx - 0.17} ${cy - 0.3} L ${cx + 0.2} ${cy} L ${cx - 0.17} ${cy + 0.3}`}
        fill="none"
        stroke={color}
        strokeWidth={0.22}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );

  return (
    <div className={`boardwrap${shake ? ' boardwrap--shake' : ''}`}>
      <svg viewBox="0 0 15 15" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Ludo board" shapeRendering="geometricPrecision">
        <defs>
          <radialGradient id="pawnCast4" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#0f1f4d" stopOpacity="0.42" />
            <stop offset="58%" stopColor="#0f1f4d" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#0f1f4d" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="socket4" cx="50%" cy="36%" r="66%">
            <stop offset="0%" stopColor="#c4cddc" />
            <stop offset="60%" stopColor="#d9dfea" />
            <stop offset="100%" stopColor="#eef2f9" />
          </radialGradient>
        </defs>
        <rect x={0} y={0} width={15} height={15} rx={0.4} fill="#ffffff" />

        {QUADS.map((q) => (
          <Quadrant key={`${q.o[0]}-${q.o[1]}`} x={q.o[0]} y={q.o[1]} colors={q.c} />
        ))}

        {/* track cells */}
        {TRACK.map(([x, y], i) => (
          <rect key={i} x={x + 0.015} y={y + 0.015} width={0.97} height={0.97} rx={0.06} fill="#ffffff" stroke="#d4dbe8" strokeWidth={0.03} />
        ))}

        {/* safe stars — neutral grey (Ludo Club) */}
        {[...SAFE_CELLS].map((i) => {
          const cell = TRACK[i];
          if (!cell) return null;
          const cx = cell[0] + 0.5;
          const cy = cell[1] + 0.5;
          return (
            <polygon
              key={`s${i}`}
              points={starPoints(cx, cy, 0.36)}
              fill="#eef1f7"
              stroke="#b7c1d2"
              strokeWidth={0.05}
              strokeLinejoin="round"
            />
          );
        })}

        {/* home-run columns for all four seats — flat solid (Ludo Club matte) */}
        {HOME_COLUMNS4.map((col, seat) =>
          col.map(([x, y], i) => (
            <rect
              key={`h${seat}-${i}`}
              x={x + 0.02}
              y={y + 0.02}
              width={0.96}
              height={0.96}
              rx={0.08}
              fill={SEAT_COLORS[seat]![1]}
              stroke={SEAT_COLORS[seat]![2]}
              strokeWidth={0.035}
            />
          )),
        )}

        {/* coloured start cells for all four seats — flat solid */}
        {SEAT_START4.map((idx, seat) => {
          const cell = TRACK[idx];
          if (!cell) return null;
          return (
            <rect
              key={`d${seat}`}
              x={cell[0] + 0.02}
              y={cell[1] + 0.02}
              width={0.96}
              height={0.96}
              rx={0.08}
              fill={SEAT_COLORS[seat]![1]}
              stroke={SEAT_COLORS[seat]![2]}
              strokeWidth={0.035}
            />
          );
        })}

        {/* home-run entry chevrons (each arm coloured for the seat that enters there) */}
        {edgeChevron(0.5, 7.5, 0, RED[1], 'er')}
        {edgeChevron(7.5, 0.5, 90, GREEN[1], 'eg')}
        {edgeChevron(14.5, 7.5, 180, YELLOW[1], 'ey')}
        {edgeChevron(7.5, 14.5, 270, BLUE[1], 'eb')}

        {/* centre pinwheel — each triangle matches its adjacent arm:
            top=green, left=red, right=yellow, bottom=blue (Ludo Club) */}
        <polygon points="6,6 9,6 7.5,7.5" fill={GREEN[1]} />
        <polygon points="9,6 9,9 7.5,7.5" fill={YELLOW[1]} />
        <polygon points="6,9 9,9 7.5,7.5" fill={BLUE[1]} />
        <polygon points="6,6 6,9 7.5,7.5" fill={RED[1]} />

        {/* pieces */}
        {positions.map((row, seat) =>
          row.map((pos, token) => {
            let x: number;
            let y: number;
            if (pos === -1) {
              [x, y] = baseSlotXY(seat, token);
            } else {
              [x, y] = tokenXY4(seat, token, pos);
              // fan out co-located tokens of the same seat a touch
              const dupes = row.filter((p, k) => k < token && p === pos && p >= 0).length;
              x += dupes * 0.22;
            }
            const isMine = seat === mySeat;
            const isMovable = isMine && movable.includes(token);
            return (
              <g
                key={`t${seat}-${token}`}
                className={`token${isMovable ? ' token--movable' : ''}`}
                style={{ transform: `translate(${x}px, ${y}px)`, transition: `transform ${WALK_TWEEN_MS}ms cubic-bezier(0.35,0,0.25,1)` }}
                onClick={isMovable ? () => onTokenTap(token) : undefined}
              >
                {isMovable && (
                  <circle cx={0} cy={0} r={0.58} fill="none" stroke="#F5B301" strokeWidth={0.09}>
                    <animate attributeName="r" values=".52;.64;.52" dur="1s" repeatCount="indefinite" />
                  </circle>
                )}
                <g transform="scale(1.18)">
                  <Pawn seat={seat} />
                </g>
              </g>
            );
          }),
        )}

        {bursts.map((b) => (
          <g key={b.key} transform={`translate(${b.x} ${b.y})`}>
            {Array.from({ length: 8 }, (_, i) => {
              const a = (i / 8) * Math.PI * 2;
              return (
                <circle
                  key={i}
                  r={0.1}
                  className="burst__p"
                  fill={SEAT_COLORS[b.seat]![1]}
                  style={{ ['--dx' as string]: `${(Math.cos(a) * 0.95).toFixed(2)}px`, ['--dy' as string]: `${(Math.sin(a) * 0.95).toFixed(2)}px` }}
                />
              );
            })}
          </g>
        ))}
      </svg>

      {/* plain white name labels painted on each quadrant (Ludo Club style) */}
      {banners?.map((b) => (
        <div key={b.seat} className={`plabel plabel--q${b.seat}${b.active ? ' plabel--active' : ''}`}>
          {b.name}
        </div>
      ))}
    </div>
  );
}

/** Re-exported so screens can map seat → colour without duplicating the palette. */
export const SEAT_HEX = SEAT_COLORS.map((c) => c[1]);
export { SEAT_QUAD };
