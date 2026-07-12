/**
 * 4-player Ludo board (practice mode) — renders all four seats: blue (you,
 * bottom-left), red (top-left), green (top-right), yellow (bottom-right).
 * Same candy visual language as the 2-player <Board>, driven by ludo4 geometry.
 */
import { useEffect, useRef, useState } from 'react';
import { SAFE_CELLS, TRACK } from '@ludo/game-engine';
import { BASE_SPOTS4, HOME_COLUMNS4, SEAT_START4, tokenXY4, type Game4 } from '../lib/ludo4';
import { WALK_STEP_MS, WALK_TWEEN_MS } from '../lib/pacing';

const RED = ['#FF7A6E', '#E5484D', '#B02E33'] as const;
const GREEN = ['#5FCB68', '#46A758', '#2E7A3C'] as const;
const YELLOW = ['#FFD54F', '#F4B400', '#C08900'] as const;
const BLUE = ['#6B93F0', '#3E63DD', '#2947A8'] as const;

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
/** Tint each safe star to the seat that owns its arm. */
function starTint(cx: number, cy: number): readonly [string, string, string] | null {
  if (cy >= 6 && cy <= 8) {
    if (cx <= 5) return BLUE; // left arm
    if (cx >= 9) return GREEN; // right arm
  }
  if (cx >= 6 && cx <= 8) {
    if (cy <= 5) return RED; // top arm
    if (cy >= 9) return YELLOW; // bottom arm
  }
  return null;
}

function baseSlotXY(seat: number, token: number): [number, number] {
  const s = BASE_SPOTS4[seat]?.[token];
  return s ? [s[0], s[1]] : [7.5, 7.5];
}

/** Chunky glossy peg. */
function Pawn({ seat }: { seat: number }) {
  const c = SEAT_COLORS[seat] ?? BLUE;
  const dark = c[2];
  const gid = `peg4-${seat}`;
  return (
    <>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c[0]} />
          <stop offset="55%" stopColor={c[1]} />
          <stop offset="100%" stopColor={c[2]} />
        </linearGradient>
      </defs>
      <ellipse cx={0.03} cy={0.4} rx={0.34} ry={0.1} fill="rgba(16,24,48,.34)" />
      <path
        d="M -0.32 0.36 C -0.34 0.14 -0.14 0.1 -0.12 -0.04 L 0.12 -0.04 C 0.14 0.1 0.34 0.14 0.32 0.36 Q 0.32 0.44 0 0.44 Q -0.32 0.44 -0.32 0.36 Z"
        fill={`url(#${gid})`}
        stroke={dark}
        strokeWidth={0.03}
      />
      <ellipse cx={0} cy={-0.02} rx={0.13} ry={0.05} fill={dark} opacity={0.35} />
      <circle cx={0} cy={-0.24} r={0.26} fill={`url(#${gid})`} stroke={dark} strokeWidth={0.03} />
      <ellipse cx={-0.09} cy={-0.33} rx={0.09} ry={0.065} fill="#ffffff" opacity={0.9} />
      <ellipse cx={0.07} cy={-0.17} rx={0.05} ry={0.08} fill="#ffffff" opacity={0.22} />
    </>
  );
}

function Quadrant({ x, y, colors }: { x: number; y: number; colors: readonly [string, string, string] }) {
  const gid = `q4-${x}-${y}`;
  const isTop = y === 0;
  const hy = isTop ? y + 1.35 : y + 0.25;
  const slots = quadSlots(x, y);
  return (
    <g>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colors[0]} />
          <stop offset="100%" stopColor={colors[1]} />
        </linearGradient>
      </defs>
      <rect x={x} y={y} width={6} height={6} rx={0.5} fill={`url(#${gid})`} />
      <rect x={x + 0.3} y={y + 0.3} width={5.4} height={1.4} rx={0.6} fill="#ffffff" opacity={0.12} />
      <rect x={x + 0.82} y={hy + 0.09} width={4.4} height={4.4} rx={0.55} fill="rgba(16,24,48,.18)" />
      <rect x={x + 0.8} y={hy} width={4.4} height={4.4} rx={0.55} fill="#ffffff" />
      <rect x={x + 0.8} y={hy} width={4.4} height={4.4} rx={0.55} fill="none" stroke={colors[2]} strokeWidth={0.06} opacity={0.16} />
      {slots.map(([sx, sy], i) => (
        <g key={i}>
          <circle cx={sx} cy={sy} r={0.5} fill="#e5e9f1" />
          <circle cx={sx} cy={sy} r={0.5} fill="none" stroke="#cfd6e3" strokeWidth={0.055} />
        </g>
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
        <rect x={0} y={0} width={15} height={15} rx={0.4} fill="#ffffff" />

        {QUADS.map((q) => (
          <Quadrant key={`${q.o[0]}-${q.o[1]}`} x={q.o[0]} y={q.o[1]} colors={q.c} />
        ))}

        {/* track cells */}
        {TRACK.map(([x, y], i) => (
          <rect key={i} x={x + 0.015} y={y + 0.015} width={0.97} height={0.97} rx={0.06} fill="#ffffff" stroke="#d4dbe8" strokeWidth={0.03} />
        ))}

        {/* safe stars, arm-tinted */}
        {[...SAFE_CELLS].map((i) => {
          const cell = TRACK[i];
          if (!cell) return null;
          const cx = cell[0] + 0.5;
          const cy = cell[1] + 0.5;
          const tint = starTint(cell[0], cell[1]);
          return (
            <polygon
              key={`s${i}`}
              points={starPoints(cx, cy, 0.36)}
              fill={tint ? tint[0] : '#eef1f7'}
              stroke={tint ? tint[2] : '#b7c1d2'}
              strokeWidth={0.05}
              strokeLinejoin="round"
              opacity={tint ? 0.9 : 1}
            />
          );
        })}

        {/* home-run columns for all four seats */}
        {HOME_COLUMNS4.map((col, seat) =>
          col.map(([x, y], i) => (
            <rect
              key={`h${seat}-${i}`}
              x={x + 0.02}
              y={y + 0.02}
              width={0.96}
              height={0.96}
              rx={0.12}
              fill={SEAT_COLORS[seat]![1]}
              stroke={SEAT_COLORS[seat]![2]}
              strokeWidth={0.04}
            />
          )),
        )}

        {/* coloured start cells for all four seats */}
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
              rx={0.12}
              fill={SEAT_COLORS[seat]![1]}
              stroke={SEAT_COLORS[seat]![2]}
              strokeWidth={0.04}
            />
          );
        })}

        {/* home-run entry chevrons (four arms) */}
        {edgeChevron(0.5, 7.5, 0, BLUE[1], 'eb')}
        {edgeChevron(14.5, 7.5, 180, GREEN[1], 'eg')}
        {edgeChevron(7.5, 0.5, 90, RED[1], 'er')}
        {edgeChevron(7.5, 14.5, 270, YELLOW[1], 'ey')}

        {/* centre pinwheel */}
        <polygon points="6,6 9,6 7.5,7.5" fill={RED[1]} stroke="#ffffff" strokeWidth={0.07} strokeLinejoin="round" />
        <polygon points="9,6 9,9 7.5,7.5" fill={GREEN[1]} stroke="#ffffff" strokeWidth={0.07} strokeLinejoin="round" />
        <polygon points="6,9 9,9 7.5,7.5" fill={YELLOW[1]} stroke="#ffffff" strokeWidth={0.07} strokeLinejoin="round" />
        <polygon points="6,6 6,9 7.5,7.5" fill={BLUE[1]} stroke="#ffffff" strokeWidth={0.07} strokeLinejoin="round" />

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
                <g transform="scale(1.3)">
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

      {/* name banners on each seat's quadrant */}
      {banners?.map((b) => (
        <div
          key={b.seat}
          className={`pbanner pbanner--q${b.seat}${b.active ? ' pbanner--active' : ''}`}
          style={{ borderColor: SEAT_COLORS[b.seat]![1] }}
        >
          <span className="pbanner__flag">{b.flag}</span>
          <span className="pbanner__name">{b.name}</span>
        </div>
      ))}
    </div>
  );
}

/** Re-exported so screens can map seat → colour without duplicating the palette. */
export const SEAT_HEX = SEAT_COLORS.map((c) => c[1]);
export { SEAT_QUAD };
