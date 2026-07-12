/**
 * SVG board generated from the engine constants (single source of truth).
 * Ludo-Club fidelity pass (user-provided reference screenshots): flat white
 * plate that bleeds edge-to-edge, thin grey cell grid, solid candy quadrants
 * with the player's name banner ON the quadrant, grey slot circles, classic
 * peg pawns, per-colour tinted safe stars, big coloured chevrons at the four
 * home-run entries, and a plain four-triangle centre (no medallion).
 * You = blue (bottom-left), opponent = green (top-right).
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

/** Classic palette: [light, base, dark] per colour. */
const RED = ['#FF7A6E', '#E5484D', '#B02E33'] as const;
const GREEN = ['#5FCB68', '#46A758', '#2E7A3C'] as const;
const YELLOW = ['#FFD54F', '#F4B400', '#C08900'] as const;
const BLUE = ['#6B93F0', '#3E63DD', '#2947A8'] as const;

const SEAT_COLOR: ReadonlyArray<readonly [string, string, string]> = [BLUE, GREEN];

const STEP_MS = WALK_STEP_MS; // per-cell walk pace (deliberate, readable)

/** Ludo-Club tints the classic safe star nearest each corner with that colour. */
const STAR_TINT: Record<number, readonly [string, string, string]> = {
  8: BLUE,
  21: RED,
  34: GREEN,
  47: YELLOW,
};

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

/** Classic Ludo-Club peg: round head on a flared skirt, soft shadow, small specular. */
function Pawn({ seat }: { seat: Seat }) {
  const grad = seat === 0 ? 'url(#pegBlue)' : 'url(#pegGreen)';
  const dark = SEAT_COLOR[seat]![2];
  return (
    <>
      <ellipse cx={0.02} cy={0.34} rx={0.28} ry={0.09} fill="rgba(16,24,48,.32)" />
      <path
        d="M -0.27 0.28 C -0.27 0.08 -0.11 0.04 -0.1 -0.08 L 0.1 -0.08 C 0.11 0.04 0.27 0.08 0.27 0.28 Q 0.27 0.36 0 0.36 Q -0.27 0.36 -0.27 0.28 Z"
        fill={grad}
        stroke={dark}
        strokeWidth={0.028}
      />
      <circle cx={0} cy={-0.2} r={0.235} fill={grad} stroke={dark} strokeWidth={0.028} />
      <ellipse cx={-0.08} cy={-0.28} rx={0.08} ry={0.055} fill="#ffffff" opacity={0.85} />
    </>
  );
}

/**
 * Quadrant panel, Ludo-Club style: solid candy colour, white rounded tray with
 * grey resting slots, and the player's name banner on the outer edge band.
 */
function Quadrant({
  x,
  y,
  colors,
  active,
  label,
}: {
  x: number;
  y: number;
  colors: readonly [string, string, string];
  active: boolean;
  label?: string;
}) {
  const gid = `qq${x}-${y}`;
  const isTop = y === 0;
  return (
    <g>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colors[0]} />
          <stop offset="100%" stopColor={colors[1]} />
        </linearGradient>
      </defs>
      <rect x={x} y={y} width={6} height={6} rx={0.45} fill={`url(#${gid})`} />
      {/* white tray, nudged toward the centre so the outer band holds the banner */}
      <rect x={x + 1} y={isTop ? y + 1.25 : y + 0.75} width={4} height={4} rx={0.5} fill="#ffffff" />
      {!active &&
        [
          [x + 2.3, y + (isTop ? 2.55 : 2.05)],
          [x + 3.7, y + (isTop ? 2.55 : 2.05)],
          [x + 2.3, y + (isTop ? 3.95 : 3.45)],
          [x + 3.7, y + (isTop ? 3.95 : 3.45)],
        ].map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r={0.48} fill="#dce1ea" />)}
      {label && (
        <text
          x={x + 3}
          y={isTop ? y + 0.82 : y + 5.62}
          textAnchor="middle"
          fontFamily="Fredoka, system-ui, sans-serif"
          fontWeight={600}
          fontSize={0.62}
          fill="#ffffff"
          style={{ paintOrder: 'stroke' }}
          stroke="rgba(16,24,48,.25)"
          strokeWidth={0.05}
        >
          {label}
        </text>
      )}
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
  labels?: Partial<Record<Seat, string>>;
}

export function Board({ game, mySeat, onTokenTap, labels }: BoardProps) {
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

  /** White chevron on a start cell, pointing along the first track step. */
  const startChevron = (seat: Seat) => {
    const idx = SEAT_START[seat] ?? 0;
    const cell = TRACK[idx];
    const next = TRACK[(idx + 1) % TRACK_LEN];
    if (!cell || !next) return null;
    const [cx, cy] = [cell[0] + 0.5, cell[1] + 0.5];
    const ang = (Math.atan2(next[1] - cell[1], next[0] - cell[0]) * 180) / Math.PI;
    return (
      <g key={`ch${seat}`} transform={`rotate(${ang} ${cx} ${cy})`}>
        <path
          d={`M ${cx - 0.16} ${cy - 0.28} L ${cx + 0.18} ${cy} L ${cx - 0.16} ${cy + 0.28}`}
          fill="none"
          stroke="#ffffff"
          strokeWidth={0.17}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    );
  };

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
          {/* flat candy peg bodies (Ludo-Club look: bright, barely gradient) */}
          <linearGradient id="pegBlue" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6B93F0" />
            <stop offset="55%" stopColor="#3E63DD" />
            <stop offset="100%" stopColor="#2C4BB8" />
          </linearGradient>
          <linearGradient id="pegGreen" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5FCB68" />
            <stop offset="55%" stopColor="#46A758" />
            <stop offset="100%" stopColor="#357F44" />
          </linearGradient>
        </defs>

        {/* flat white plate (edge-to-edge; the wrapper gives the soft shadow) */}
        <rect x={0} y={0} width={15} height={15} rx={0.4} fill="#ffffff" />

        {/* quadrants with name banners: red / green / blue / yellow (classic) */}
        <Quadrant x={0} y={0} colors={RED} active={false} />
        <Quadrant x={9} y={0} colors={GREEN} active={true} label={labels?.[1]} />
        <Quadrant x={0} y={9} colors={BLUE} active={true} label={labels?.[0]} />
        <Quadrant x={9} y={9} colors={YELLOW} active={false} />

        {/* resting slots for the two live seats (trays are nudged per quadrant) */}
        {BASE_SPOTS.map((spots, seat) =>
          spots.map(([sx, sy], i) => {
            const dy = seat === 1 ? 0.25 : -0.25; // green tray sits lower, blue higher
            return <circle key={`bs${seat}-${i}`} cx={sx} cy={sy + dy} r={0.48} fill="#dce1ea" />;
          }),
        )}

        {/* track: flat white cells with a thin grey grid (Ludo-Club) */}
        {TRACK.map(([x, y], i) => (
          <rect
            key={i}
            x={x + 0.02}
            y={y + 0.02}
            width={0.96}
            height={0.96}
            rx={0.12}
            fill="#ffffff"
            stroke="#c9d2e0"
            strokeWidth={0.045}
          />
        ))}

        {/* safe stars: colour-tinted near each corner, soft grey elsewhere */}
        {[...SAFE_CELLS].map((i) => {
          const cell = TRACK[i];
          if (!cell) return null;
          const tint = STAR_TINT[i];
          const cx = cell[0] + 0.5;
          const cy = cell[1] + 0.5;
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
        {([0, 1] as const).map((seat) => startChevron(seat))}

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
            let [x, y] = tokenXY(seat as Seat, token, pos);
            const other = row[1 - token];
            if (pos !== -1 && pos === other && token === 1) x += 0.3;
            if (pos === -1) y += seat === 1 ? 0.25 : -0.25; // match the nudged tray slots
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
                  <circle cx={0} cy={0} r={0.56} fill="none" stroke="#F5B301" strokeWidth={0.09}>
                    <animate attributeName="r" values=".5;.62;.5" dur="1s" repeatCount="indefinite" />
                  </circle>
                )}
                <g transform="scale(1.3)">
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
    </div>
  );
}
