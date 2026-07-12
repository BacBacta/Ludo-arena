/**
 * SVG board generated from the engine constants (single source of truth).
 * Candy pass (Ludo-Club reference): white board, the four classic quadrant
 * colours (red/green/blue/yellow), glossy pin-shaped pawns, start chevrons,
 * home-column arrows. You = blue (bottom-left), opponent = green (top-right).
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

/** Classic palette: [light, base, dark] per colour. */
const RED = ['#F1655A', '#E5484D', '#B02E33'] as const;
const GREEN = ['#5FCB68', '#46A758', '#2E7A3C'] as const;
const YELLOW = ['#FFD54F', '#F4B400', '#C08900'] as const;
const BLUE = ['#5B8DEF', '#3E63DD', '#2947A8'] as const;

const SEAT_COLOR: ReadonlyArray<readonly [string, string, string]> = [BLUE, GREEN];

const STEP_MS = 300; // per-cell walk pace (deliberate, readable)

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

/** Glossy pin pawn (Ludo-Club-like): dome base, waist, shiny ball head. */
function Pawn({ seat }: { seat: Seat }) {
  const grad = seat === 0 ? 'url(#pawnMe)' : 'url(#pawnOpp)';
  const rim = seat === 0 ? BLUE[2] : GREEN[2];
  return (
    <>
      <ellipse cx={0} cy={0.38} rx={0.36} ry={0.11} fill="rgba(23,43,99,.3)" />
      <ellipse cx={0} cy={0.26} rx={0.34} ry={0.16} fill={grad} stroke={rim} strokeWidth={0.05} />
      <path
        d="M -0.24 0.24 Q -0.11 0.05 -0.1 -0.05 L 0.1 -0.05 Q 0.11 0.05 0.24 0.24 Z"
        fill={grad}
        stroke={rim}
        strokeWidth={0.045}
      />
      <circle cx={0} cy={-0.21} r={0.23} fill={grad} stroke={rim} strokeWidth={0.05} />
      <ellipse cx={-0.08} cy={-0.29} rx={0.095} ry={0.06} fill="rgba(255,255,255,.92)" />
      <ellipse cx={-0.11} cy={0.2} rx={0.07} ry={0.035} fill="rgba(255,255,255,.5)" />
    </>
  );
}

/** Quadrant panel: bright colour, white base, resting slots (grey when unused). */
function Quadrant({ x, y, colors, active }: { x: number; y: number; colors: readonly [string, string, string]; active: boolean }) {
  const gid = `q${x}-${y}`;
  return (
    <g>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colors[0]} />
          <stop offset="100%" stopColor={colors[1]} />
        </linearGradient>
      </defs>
      <rect x={x} y={y} width={6} height={6} rx={0.55} fill={`url(#${gid})`} />
      <rect x={x + 0.12} y={y + 0.12} width={5.76} height={2.6} rx={0.45} fill="#ffffff" opacity={0.14} />
      <rect x={x + 1} y={y + 1} width={4} height={4} rx={0.5} fill="#ffffff" />
      <rect x={x + 1} y={y + 1} width={4} height={4} rx={0.5} fill="none" stroke={colors[2]} strokeWidth={0.05} opacity={0.25} />
      {!active &&
        [
          [x + 2.3, y + 2.3],
          [x + 3.7, y + 2.3],
          [x + 2.3, y + 3.7],
          [x + 3.7, y + 3.7],
        ].map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r={0.5} fill="#d4dae6" />)}
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
}

export function Board({ game, mySeat, onTokenTap }: BoardProps) {
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

  /** Chevron on a start cell, pointing along the first track step. */
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

  return (
    <div className={`boardwrap${shake ? ' boardwrap--shake' : ''}`}>
      <svg viewBox="0 0 15 15" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Ludo board">
        <defs>
          <radialGradient id="pawnMe" cx="32%" cy="25%" r="95%">
            <stop offset="0%" stopColor="#9db9ff" />
            <stop offset="55%" stopColor={BLUE[1]} />
            <stop offset="100%" stopColor={BLUE[2]} />
          </radialGradient>
          <radialGradient id="pawnOpp" cx="32%" cy="25%" r="95%">
            <stop offset="0%" stopColor="#a8e9a4" />
            <stop offset="55%" stopColor={GREEN[1]} />
            <stop offset="100%" stopColor={GREEN[2]} />
          </radialGradient>
        </defs>

        {/* white board plate */}
        <rect x={0} y={0} width={15} height={15} rx={0.7} fill="#e8ecf5" />

        {/* quadrants: red / green / blue / yellow (classic) */}
        <Quadrant x={0} y={0} colors={RED} active={false} />
        <Quadrant x={9} y={0} colors={GREEN} active={true} />
        <Quadrant x={0} y={9} colors={BLUE} active={true} />
        <Quadrant x={9} y={9} colors={YELLOW} active={false} />

        {/* resting slots for the two live seats */}
        {BASE_SPOTS.map((spots, seat) =>
          spots.map(([sx, sy], i) => (
            <g key={`bs${seat}-${i}`}>
              <circle cx={sx} cy={sy} r={0.5} fill="#dfe6f2" />
              <circle cx={sx} cy={sy} r={0.5} fill="none" stroke={SEAT_COLOR[seat]![1]} strokeWidth={0.08} opacity={0.85} />
            </g>
          )),
        )}

        {/* track: white cells, light grid */}
        {TRACK.map(([x, y], i) => (
          <rect
            key={i}
            x={x + 0.02}
            y={y + 0.02}
            width={0.96}
            height={0.96}
            rx={0.14}
            fill="#ffffff"
            stroke="#b9c3d6"
            strokeWidth={0.06}
          />
        ))}
        {[...SAFE_CELLS].map((i) => {
          const cell = TRACK[i];
          if (!cell) return null;
          return (
            <text
              key={`s${i}`}
              x={cell[0] + 0.5}
              y={cell[1] + 0.78}
              fontSize={0.72}
              textAnchor="middle"
              fill="#aeb9cf"
            >
              ★
            </text>
          );
        })}

        {/* home columns: solid seat-colour lane with a soft top gloss (Ludo Club style) */}
        {HOME_COLUMNS.map((col, seat) =>
          col.map(([x, y], i) => (
            <g key={`h${seat}-${i}`}>
              <rect
                x={x + 0.02}
                y={y + 0.02}
                width={0.96}
                height={0.96}
                rx={0.14}
                fill={SEAT_COLOR[seat]![1]}
                stroke={SEAT_COLOR[seat]![2]}
                strokeWidth={0.04}
              />
              <rect x={x + 0.1} y={y + 0.08} width={0.8} height={0.34} rx={0.14} fill="#ffffff" opacity={0.18} />
            </g>
          )),
        )}

        {/* start cells: seat colour + double chevron */}
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
              rx={0.14}
              fill={SEAT_COLOR[seat as Seat]![1]}
            />
          );
        })}
        {([0, 1] as const).map((seat) => startChevron(seat))}

        {/* centre: four-colour pinwheel + gold finish medallion */}
        <polygon points="6,6 9,6 7.5,7.5" fill={RED[1]} />
        <polygon points="9,6 9,9 7.5,7.5" fill={GREEN[1]} />
        <polygon points="6,9 9,9 7.5,7.5" fill={YELLOW[1]} />
        <polygon points="6,6 6,9 7.5,7.5" fill={BLUE[1]} />
        <circle cx={7.5} cy={7.5} r={0.62} fill="#ffffff" stroke="#f5b301" strokeWidth={0.09} />
        <text x={7.5} y={7.76} fontSize={0.62} textAnchor="middle" fill="#f5b301">
          ★
        </text>

        {/* pieces */}
        {positions.map((row, seat) =>
          row.map((pos, token) => {
            let [x, y] = tokenXY(seat as Seat, token, pos);
            const other = row[1 - token];
            if (pos !== -1 && pos === other && token === 1) x += 0.3;
            const isMine = (seat as Seat) === mySeat;
            const isMovable = isMine && movable.includes(token);
            return (
              <g
                key={`t${seat}-${token}`}
                className={`token${isMovable ? ' token--movable' : ''}`}
                style={{
                  transform: `translate(${x}px, ${y}px)`,
                  transition: 'transform 280ms cubic-bezier(0.35, 0, 0.25, 1)',
                }}
                onClick={isMovable ? () => onTokenTap(token) : undefined}
              >
                {isMovable && (
                  <circle cx={0} cy={0} r={0.56} fill="none" stroke="#F5B301" strokeWidth={0.09}>
                    <animate attributeName="r" values=".5;.62;.5" dur="1s" repeatCount="indefinite" />
                  </circle>
                )}
                <g transform="scale(1.18)">
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
