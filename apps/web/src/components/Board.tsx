/**
 * SVG board generated from the engine constants (single source of truth).
 * Ludo-Club fidelity pass: large white home squares, chunky glossy pegs, thin
 * grey cell grid, per-colour tinted safe stars, coloured home-run chevrons, a
 * plain four-triangle centre, and HTML name banners (flag + name) sitting on
 * each seat's quadrant like the reference. You = blue (bottom-left),
 * opponent = green (top-right).
 */
import { useEffect, useRef, useState } from 'react';
import {
  BASE_SPOTS,
  FINISHED,
  HOME_COLUMNS,
  LAST_TRACK_REL,
  SAFE_CELLS,
  SEAT_START,
  TRACK,
  TRACK_LEN,
} from '@ludo/game-engine';
import type { GameState, Seat } from '@ludo/game-engine';
import { WALK_STEP_MS, WALK_TWEEN_MS } from '../lib/pacing';
import { playHop } from '../lib/sound';

/** True vivid Ludo-Club palette [highlight, TRUE base, deep shade] — matches the
 *  4-player board (Board4) so the staked board reads with the same premium look. */
const RED = ['#FF7B6E', '#E62E2A', '#AC1C1A'] as const;
const GREEN = ['#5FCE79', '#25A544', '#16792E'] as const;
const YELLOW = ['#FFDD4A', '#F6C200', '#C08A00'] as const;
const BLUE = ['#63C4EC', '#1F8FD4', '#105F97'] as const;

const SEAT_COLOR: ReadonlyArray<readonly [string, string, string]> = [BLUE, GREEN];

const STEP_MS = WALK_STEP_MS; // per-cell walk pace (deliberate, readable)

/** Quadrant origin per seat: you (blue) bottom-left, opponent (green) top-right. */
const SEAT_QUAD: Record<number, readonly [number, number]> = { 0: [0, 9], 1: [9, 0] };

/** Centre of a quadrant's white home square (nudged toward the board centre). */
function homeCenter(qx: number, qy: number): [number, number] {
  const isTop = qy === 0;
  const hy = isTop ? qy + 1.35 : qy + 0.25;
  return [qx + 3, hy + 2.2];
}

/** The four resting-slot centres inside a quadrant's home square. */
function quadSlots(qx: number, qy: number): Array<[number, number]> {
  const [cx, cy] = homeCenter(qx, qy);
  return [
    [cx - 0.8, cy - 0.8],
    [cx + 0.8, cy - 0.8],
    [cx - 0.8, cy + 0.8],
    [cx + 0.8, cy + 0.8],
  ];
}

/** Tint a safe star to the seat that owns its arm: left arm = blue, right = green. */
function starTint(cx: number, cy: number): readonly [string, string, string] | null {
  if (cy >= 6 && cy <= 8) {
    if (cx <= 5) return BLUE; // left horizontal arm (blue home-run)
    if (cx >= 9) return GREEN; // right horizontal arm (green home-run)
  }
  return null;
}

export interface PlayerBanner {
  seat: Seat;
  name: string;
  flag: string;
  active: boolean;
}

/** Display positions stepping one cell at a time toward the real ones. */
function useAnimatedPositions(positions: number[][]): number[][] {
  const [display, setDisplay] = useState(positions);
  const ref = useRef(display);
  ref.current = display;

  useEffect(() => {
    const reduce =
      typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const differs = positions.some((row, s) => row.some((tgt, k) => tgt !== ref.current[s]?.[k]));
    if (!differs) return;
    if (reduce) {
      setDisplay(positions.map((row) => [...row]));
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
        timer = setTimeout(tick, STEP_MS);
      }
    };
    tick();
    return () => clearTimeout(timer);
  }, [positions]);

  return display;
}

function tokenXY(seat: Seat, token: number, rel: number): [number, number] {
  if (rel === -1) {
    const spot = BASE_SPOTS[seat]?.[token] ?? [7.5, 7.5];
    return [spot[0], spot[1]];
  }
  if (rel === FINISHED) {
    return [7.5 + (seat === 0 ? -0.35 : 0.35), 7.5];
  }
  if (rel <= LAST_TRACK_REL) {
    const cell = TRACK[((SEAT_START[seat] ?? 0) + rel) % TRACK_LEN] ?? [7, 7];
    return [cell[0] + 0.5, cell[1] + 0.5];
  }
  const home = HOME_COLUMNS[seat]?.[rel - (LAST_TRACK_REL + 1)] ?? [7, 7];
  return [home[0] + 0.5, home[1] + 0.5];
}

/** Base-slot centre for a seat's token (aligned to the home-square slots). */
function baseSlotXY(seat: Seat, token: number): [number, number] {
  const quad = SEAT_QUAD[seat] ?? [0, 9];
  const slots = quadSlots(quad[0], quad[1]);
  // two tokens rest on the two lower slots so the banner edge stays clear
  return slots[token + 2] ?? slots[token] ?? [7.5, 7.5];
}

/** Ten-point star polygon string — crisp vector stars (text glyphs render fuzzy). */
function starPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.46;
    pts.push(`${(cx + Math.cos(a) * rr).toFixed(3)},${(cy + Math.sin(a) * rr).toFixed(3)}`);
  }
  return pts.join(' ');
}

/** Chunky glossy Ludo-Club peg: bulb head, flared skirt, cast shadow, hot specular. */
function Pawn({ seat }: { seat: Seat }) {
  const grad = seat === 0 ? 'url(#pegBlue)' : 'url(#pegGreen)';
  const dark = SEAT_COLOR[seat]![2];
  return (
    <>
      {/* soft contact shadow, directly under the foot */}
      <ellipse cx={0.02} cy={0.36} rx={0.3} ry={0.08} fill="rgba(16,24,48,.3)" />
      {/* teardrop: ball top blending smoothly into a flared cone foot */}
      <path
        d="M -0.3 0.28 C -0.3 0.06 -0.17 -0.06 -0.13 -0.24 C -0.1 -0.4 0.1 -0.4 0.13 -0.24 C 0.17 -0.06 0.3 0.06 0.3 0.28 Q 0.3 0.36 0 0.36 Q -0.3 0.36 -0.3 0.28 Z"
        fill={grad}
        stroke={dark}
        strokeWidth={0.026}
      />
      <circle cx={0} cy={-0.28} r={0.17} fill={grad} stroke={dark} strokeWidth={0.026} />
      <path d="M -0.13 -0.24 Q 0 -0.14 0.13 -0.24" fill={grad} stroke="none" />
      <ellipse cx={-0.065} cy={-0.34} rx={0.065} ry={0.05} fill="#ffffff" opacity={0.95} />
      <path d="M -0.12 0.26 C -0.16 0.08 -0.09 -0.06 -0.06 -0.16" fill="none" stroke="#ffffff" strokeWidth={0.045} strokeLinecap="round" opacity={0.45} />
    </>
  );
}

/**
 * Quadrant panel, Ludo-Club style: solid candy colour, a big white rounded home
 * square with grey resting slots. The tray is nudged toward the board centre so
 * the outer band holds the name banner (rendered as HTML over the board).
 */
function Quadrant({
  x,
  y,
  colors,
  inactive,
}: {
  x: number;
  y: number;
  colors: readonly [string, string, string];
  inactive?: boolean;
}) {
  const isTop = y === 0;
  const hy = isTop ? y + 1.35 : y + 0.25; // home-square top
  const slots = quadSlots(x, y);
  return (
    <g opacity={inactive ? 0.42 : 1}>
      {/* flat solid quadrant (Ludo-Club matte) — no gradient, reads as a true colour */}
      <rect x={x} y={y} width={6} height={6} rx={0.5} fill={colors[1]} />
      {/* big white home square, lifted with a soft cast shadow */}
      {!inactive && <rect x={x + 0.82} y={hy + 0.09} width={4.4} height={4.4} rx={0.55} fill="rgba(16,24,48,.18)" />}
      <rect x={x + 0.8} y={hy} width={4.4} height={4.4} rx={0.55} fill="#ffffff" opacity={inactive ? 0.85 : 1} />
      {/* four solid grey resting discs sized to frame the peg foot (matches Board4) */}
      {!inactive &&
        slots.map(([sx, sy], i) => (
          <circle key={i} cx={sx} cy={sy} r={0.56} fill="#d4dae6" />
        ))}
    </g>
  );
}

interface Burst {
  key: number;
  x: number;
  y: number;
  seat: Seat;
}

export interface BoardProps {
  game: GameState;
  mySeat: Seat;
  onTokenTap(token: number): void;
  /** Name banners drawn on each seat's quadrant (Ludo-Club style). */
  banners?: PlayerBanner[];
}

export function Board({ game, mySeat, onTokenTap, banners }: BoardProps) {
  const movable = game.turn === mySeat && game.phase === 'awaiting-move' ? game.legal : [];
  const positions = useAnimatedPositions(game.positions);

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
          const [x, y] = tokenXY(seat as Seat, token, before);
          const key = Date.now() + seat * 100 + token;
          setBursts((b) => [...b, { key, x, y, seat: seat as Seat }]);
          setShake(true);
          setTimeout(() => setShake(false), 320);
          setTimeout(() => setBursts((b) => b.filter((bb) => bb.key !== key)), 650);
        }
      }),
    );
  }, [game.positions]);

  /** Big coloured chevron on an outer middle cell (home-run entry, Ludo-Club). */
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
      <svg
        viewBox="0 0 15 15"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Ludo board"
        shapeRendering="geometricPrecision"
      >
        <defs>
          {/* compressed highlight so the peg reads the TRUE saturated colour (not washed) */}
          <linearGradient id="pegBlue" x1="0" y1="0" x2="0.12" y2="1">
            <stop offset="0%" stopColor="#63C4EC" />
            <stop offset="20%" stopColor="#1F8FD4" />
            <stop offset="100%" stopColor="#105F97" />
          </linearGradient>
          <linearGradient id="pegGreen" x1="0" y1="0" x2="0.12" y2="1">
            <stop offset="0%" stopColor="#5FCE79" />
            <stop offset="20%" stopColor="#25A544" />
            <stop offset="100%" stopColor="#16792E" />
          </linearGradient>
        </defs>

        {/* flat white plate (edge-to-edge; the wrapper gives the soft shadow) */}
        <rect x={0} y={0} width={15} height={15} rx={0.4} fill="#ffffff" />

        {/* quadrants: red / green / blue / yellow (classic) */}
        <Quadrant x={0} y={0} colors={RED} inactive />
        <Quadrant x={9} y={0} colors={GREEN} />
        <Quadrant x={0} y={9} colors={BLUE} />
        <Quadrant x={9} y={9} colors={YELLOW} inactive />

        {/* track: flat white cells with a thin grey grid (Ludo-Club) */}
        {TRACK.map(([x, y], i) => (
          <rect
            key={i}
            x={x + 0.015}
            y={y + 0.015}
            width={0.97}
            height={0.97}
            rx={0.06}
            fill="#ffffff"
            stroke="#d4dbe8"
            strokeWidth={0.03}
          />
        ))}

        {/* safe stars: colour-tinted near each corner, soft grey elsewhere */}
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

        {/* home columns: solid seat colour, flat */}
        {HOME_COLUMNS.map((col, seat) =>
          col.map(([x, y], i) => (
            <rect
              key={`h${seat}-${i}`}
              x={x + 0.02}
              y={y + 0.02}
              width={0.96}
              height={0.96}
              rx={0.12}
              fill={SEAT_COLOR[seat]![1]}
              stroke={SEAT_COLOR[seat]![2]}
              strokeWidth={0.04}
            />
          )),
        )}

        {/* start cells: solid seat colour + white chevron */}
        {SEAT_START.map((idx, seat) => {
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
              fill={SEAT_COLOR[seat as Seat]![1]}
              stroke={SEAT_COLOR[seat as Seat]![2]}
              strokeWidth={0.04}
            />
          );
        })}

        {/* big coloured chevrons at the four home-run entries (Ludo-Club) */}
        {edgeChevron(0.5, 7.5, 0, BLUE[1], 'eb')}
        {edgeChevron(14.5, 7.5, 180, GREEN[1], 'eg')}
        {edgeChevron(7.5, 0.5, 90, RED[1], 'er')}
        {edgeChevron(7.5, 14.5, 270, YELLOW[1], 'ey')}

        {/* centre: plain four-triangle pinwheel (Ludo-Club has no medallion) */}
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
              [x, y] = baseSlotXY(seat as Seat, token);
              y -= 0.15; // seat the foot-bulb centred on the grey resting disc
            } else {
              [x, y] = tokenXY(seat as Seat, token, pos);
              const other = row[1 - token];
              if (pos === other && token === 1) x += 0.3;
            }
            const isMine = (seat as Seat) === mySeat;
            const isMovable = isMine && movable.includes(token);
            return (
              <g
                key={`t${seat}-${token}`}
                className={`token${isMovable ? ' token--movable' : ''}`}
                style={{
                  transform: `translate(${x}px, ${y}px)`,
                  transition: `transform ${WALK_TWEEN_MS}ms cubic-bezier(0.35, 0, 0.25, 1)`,
                }}
                onClick={isMovable ? () => onTokenTap(token) : undefined}
              >
                {isMovable && (
                  <circle cx={0} cy={0} r={0.58} fill="none" stroke="#F5B301" strokeWidth={0.09}>
                    <animate attributeName="r" values=".52;.64;.52" dur="1s" repeatCount="indefinite" />
                  </circle>
                )}
                <g className={`token__body${pos !== (game.positions[seat]?.[token] ?? pos) ? ' token__body--hop' : ''}${pos === -1 ? ' token__body--base' : ''}`}>
                  <Pawn seat={seat as Seat} />
                </g>
              </g>
            );
          }),
        )}

        {/* capture particle bursts */}
        {bursts.map((b) => (
          <g key={b.key} transform={`translate(${b.x} ${b.y})`}>
            {Array.from({ length: 8 }, (_, i) => {
              const a = (i / 8) * Math.PI * 2;
              return (
                <circle
                  key={i}
                  r={0.1}
                  className="burst__p"
                  fill={SEAT_COLOR[b.seat]![1]}
                  style={{
                    ['--dx' as string]: `${(Math.cos(a) * 0.95).toFixed(2)}px`,
                    ['--dy' as string]: `${(Math.sin(a) * 0.95).toFixed(2)}px`,
                  }}
                />
              );
            })}
          </g>
        ))}
      </svg>

      {/* name banners over each seat's quadrant (crisp HTML text + flag) */}
      {banners?.map((b) => (
        <div
          key={b.seat}
          className={`pbanner pbanner--s${b.seat}${b.active ? ' pbanner--active' : ''}`}
          style={{ borderColor: SEAT_COLOR[b.seat]![1] }}
        >
          <span className="pbanner__flag">{b.flag}</span>
          <span className="pbanner__name">{b.name}</span>
        </div>
      ))}
    </div>
  );
}
