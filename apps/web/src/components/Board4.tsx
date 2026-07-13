/**
 * 4-player Ludo board (practice mode) — renders all four seats: blue (you,
 * bottom-left), red (top-left), green (top-right), yellow (bottom-right).
 * Same candy visual language as the 2-player <Board>, driven by ludo4 geometry.
 */
import { useEffect, useRef, useState } from 'react';
import { LAST_TRACK_REL, SAFE_CELLS, TRACK } from '@ludo/game-engine';
import { HOME_COLUMNS4, SEAT_START4, tokenXY4, type Game4 } from '@ludo/game-engine';
import { WALK_STEP_MS, WALK_TWEEN_MS } from '../lib/pacing';
import { playHop } from '../lib/sound';

/* True vivid Ludo-Club palette [highlight, TRUE base, deep shade] — saturated,
   not washed. The base [1] is the real flat panel colour. */
const RED = ['#FF7B6E', '#E62E2A', '#AC1C1A'] as const;
const GREEN = ['#5FCE79', '#25A544', '#16792E'] as const;
const YELLOW = ['#FFDD4A', '#F6C200', '#C08A00'] as const;
const BLUE = ['#63C4EC', '#1F8FD4', '#105F97'] as const;

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
  const hy = isTop ? qy + 1.05 : qy + 0.45; // label band sits on the OUTER edge
  return [qx + 3, hy + 2.25];
}
function quadSlots(qx: number, qy: number): Array<[number, number]> {
  const [cx, cy] = homeCenter(qx, qy);
  return [
    [cx - 0.85, cy - 0.85],
    [cx + 0.85, cy - 0.85],
    [cx - 0.85, cy + 0.85],
    [cx + 0.85, cy + 0.85],
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
/** How far the peg's foot-bulb sits below its drawing origin (local units, post
 *  the 1.16 body scale + the -0.04 wrapper nudge). Lifting a base peg by this
 *  much lands its foot exactly on the grey resting circle. */
const BASE_FOOT_LIFT = 0.15;

/** Base resting position = the SAME grey circle the socket is drawn on, so the
 *  peg is perfectly centred on its slot (single source of truth: quadSlots). */
function baseSlotXY(seat: number, token: number): [number, number] {
  const q = SEAT_QUAD[seat] ?? [0, 9];
  const slots = quadSlots(q[0], q[1]);
  const s = slots[token] ?? [7.5, 7.5];
  return [s[0], s[1]];
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
        {/* body: thin light rim at the very top, then the TRUE colour dominates
            (compressed highlight so the peg reads saturated, not washed) */}
        <linearGradient id={gid} x1="0" y1="0" x2="0.12" y2="1">
          <stop offset="0%" stopColor={c[0]} />
          <stop offset="20%" stopColor={c[1]} />
          <stop offset="100%" stopColor={c[2]} />
        </linearGradient>
        {/* head: radial glossy sphere, hot-spot upper-left, true colour body */}
        <radialGradient id={hid} cx="34%" cy="27%" r="82%">
          <stop offset="0%" stopColor={c[0]} />
          <stop offset="34%" stopColor={c[1]} />
          <stop offset="100%" stopColor={c[2]} />
        </radialGradient>
      </defs>
      {/* soft contact shadow, directly under the foot */}
      <ellipse cx={0.02} cy={0.36} rx={0.3} ry={0.08} fill="url(#pawnCast4)" />
      {/* Ludo-Club teardrop: ball top blending smoothly into a flared cone foot */}
      <path
        d="M -0.3 0.28 C -0.3 0.06 -0.17 -0.06 -0.13 -0.24 C -0.1 -0.4 0.1 -0.4 0.13 -0.24 C 0.17 -0.06 0.3 0.06 0.3 0.28 Q 0.3 0.36 0 0.36 Q -0.3 0.36 -0.3 0.28 Z"
        fill={`url(#${gid})`}
        stroke={dark}
        strokeWidth={0.026}
      />
      {/* ball top overlapping the cone (no pinched chess neck) */}
      <circle cx={0} cy={-0.28} r={0.17} fill={`url(#${hid})`} stroke={dark} strokeWidth={0.026} />
      <path d="M -0.13 -0.24 Q 0 -0.14 0.13 -0.24" fill={`url(#${hid})`} stroke="none" />
      {/* glossy highlights: hot-spot on the ball + streak down the cone */}
      <ellipse cx={-0.065} cy={-0.34} rx={0.065} ry={0.05} fill="#ffffff" opacity={0.95} />
      <path d="M -0.12 0.26 C -0.16 0.08 -0.09 -0.06 -0.06 -0.16" fill="none" stroke="#ffffff" strokeWidth={0.045} strokeLinecap="round" opacity={0.45} />
      <path d="M 0.145 -0.33 A 0.17 0.17 0 0 1 0.06 -0.13" fill="none" stroke={rim} strokeWidth={0.03} strokeLinecap="round" opacity={0.85} />
    </>
  );
}

function Quadrant({ x, y, colors }: { x: number; y: number; colors: readonly [string, string, string] }) {
  const isTop = y === 0;
  const hy = isTop ? y + 1.05 : y + 0.45;
  const slots = quadSlots(x, y);
  return (
    <g>
      {/* flat solid quadrant, square edges — the board reads as ONE continuous surface */}
      <rect x={x} y={y} width={6} height={6} fill={colors[1]} />
      {/* white home square with a soft drop edge */}
      <rect x={x + 0.77} y={hy + 0.07} width={4.5} height={4.5} rx={0.45} fill="rgba(16,24,48,.16)" />
      <rect x={x + 0.75} y={hy} width={4.5} height={4.5} rx={0.45} fill="#ffffff" />
      {/* All four resting discs — the 4-player engine gives each seat four base
          tokens, so every disc frames an actual peg foot (Ludo Club). */}
      {slots.map(([sx, sy], i) => (
        <circle key={i} cx={sx} cy={sy} r={0.56} fill="#d4dae6" />
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
        playHop(); // soft per-cell tap
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

  // Group every token by the TRACK cell it shares (across ALL seats) so co-located
  // tokens of ANY colour fan out and stay individually visible.
  const trackGroups = new Map<number, Array<{ seat: number; token: number }>>();
  positions.forEach((row, seat) =>
    row.forEach((pos, token) => {
      if (pos < 0 || pos > LAST_TRACK_REL) return; // base/home/centre don't overlap across seats
      const cell = ((SEAT_START4[seat] ?? 0) + pos) % TRACK.length;
      const g = trackGroups.get(cell);
      if (g) g.push({ seat, token });
      else trackGroups.set(cell, [{ seat, token }]);
    }),
  );
  /** Small circular fan so N tokens on one cell each stay visible (0 for a lone token). */
  function fanOffset(seat: number, token: number, pos: number): [number, number] {
    if (pos < 0 || pos > LAST_TRACK_REL) return [0, 0];
    const group = trackGroups.get(((SEAT_START4[seat] ?? 0) + pos) % TRACK.length);
    if (!group || group.length < 2) return [0, 0];
    const idx = group.findIndex((o) => o.seat === seat && o.token === token);
    const n = group.length;
    const r = n === 2 ? 0.17 : 0.22;
    const a = (idx / n) * Math.PI * 2 - Math.PI / 2;
    return [Math.cos(a) * r, Math.sin(a) * r];
  }

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
          <clipPath id="board4clip">
            <rect x={0} y={0} width={15} height={15} rx={0.35} />
          </clipPath>
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
        <g clipPath="url(#board4clip)">
        <rect x={0} y={0} width={15} height={15} fill="#ffffff" />

        {QUADS.map((q) => (
          <Quadrant key={`${q.o[0]}-${q.o[1]}`} x={q.o[0]} y={q.o[1]} colors={q.c} />
        ))}

        {/* track cells: continuous grid, shared hairline borders (no gaps) */}
        {TRACK.map(([x, y], i) => (
          <rect key={i} x={x} y={y} width={1} height={1} fill="#ffffff" stroke="#a6b0c0" strokeWidth={0.05} />
        ))}

        {/* safe cells: grey-filled cell carrying a white star (Ludo Club) */}
        {[...SAFE_CELLS].map((i) => {
          const cell = TRACK[i];
          if (!cell) return null;
          const cx = cell[0] + 0.5;
          const cy = cell[1] + 0.5;
          return (
            <g key={`s${i}`}>
              <rect x={cell[0]} y={cell[1]} width={1} height={1} fill="#c9d1de" stroke="#a6b0c0" strokeWidth={0.05} />
              <polygon points={starPoints(cx, cy, 0.36)} fill="#ffffff" strokeLinejoin="round" />
            </g>
          );
        })}

        {/* home-run columns for all four seats — flat solid (Ludo Club matte) */}
        {HOME_COLUMNS4.map((col, seat) =>
          col.map(([x, y], i) => (
            <rect
              key={`h${seat}-${i}`}
              x={x}
              y={y}
              width={1}
              height={1}
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
              x={cell[0]}
              y={cell[1]}
              width={1}
              height={1}
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
              y -= BASE_FOOT_LIFT; // seat the foot-bulb centred on the grey circle
            } else {
              [x, y] = tokenXY4(seat, token, pos);
              // fan out every token sharing this cell (any colour) so all stay visible
              const [dx, dy] = fanOffset(seat, token, pos);
              x += dx;
              y += dy;
            }
            const isMine = seat === mySeat;
            const isMovable = isMine && movable.includes(token);
            const walking = pos !== (game.positions[seat]?.[token] ?? pos);
            return (
              <g
                key={`t${seat}-${token}`}
                className={`token${isMovable ? ' token--movable' : ''}`}
                style={{ transform: `translate(${x}px, ${y}px)`, transition: `transform ${WALK_TWEEN_MS}ms cubic-bezier(0.35,0,0.25,1)` }}
                onClick={isMovable ? () => onTokenTap(token) : undefined}
                role={isMovable ? 'button' : undefined}
                tabIndex={isMovable ? 0 : undefined}
                aria-label={isMovable ? `Move token ${token + 1}` : undefined}
                onKeyDown={
                  isMovable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onTokenTap(token);
                        }
                      }
                    : undefined
                }
              >
                {isMovable && (
                  <circle cx={0} cy={0} r={0.58} fill="none" stroke="#F5B301" strokeWidth={0.09}>
                    <animate attributeName="r" values=".52;.64;.52" dur="1s" repeatCount="indefinite" />
                  </circle>
                )}
                <g className={`token__body${walking ? ' token__body--hop' : ''}${pos === -1 ? ' token__body--base' : ''}`}>
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
        </g>
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
