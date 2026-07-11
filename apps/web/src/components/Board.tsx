/**
 * SVG board generated from the engine constants (single source of truth).
 * Premium pass: token depth (gradient + ground shadow + specular), decorated
 * inactive quadrants, correct home-column mouths, capture particle burst.
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

const ME_FILL = '#2E9E6B';
const ME_STROKE = '#0f3d28';
const OPP_FILL = '#E8833A';
const OPP_STROKE = '#7a3d12';

const STEP_MS = 120; // per-cell interpolation (E6.3)

/**
 * Display positions that step one cell at a time toward the real ones, so a
 * token visibly walks the track. Forward track/home moves animate; base exits,
 * captures and resets snap. Honours prefers-reduced-motion.
 */
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
          return tgt > d && d >= 0 ? d + 1 : tgt; // walk forward, else snap
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

/** A token with ground shadow, radial body and specular highlight. */
function Token({ x, y, seat }: { x: number; y: number; seat: Seat }) {
  return (
    <>
      <ellipse cx={x} cy={y + 0.32} rx={0.33} ry={0.13} fill="rgba(0,0,0,.35)" />
      <circle
        cx={x}
        cy={y}
        r={0.42}
        fill={seat === 0 ? 'url(#tokMe)' : 'url(#tokOpp)'}
        stroke={seat === 0 ? ME_STROKE : OPP_STROKE}
        strokeWidth={0.09}
      />
      <ellipse cx={x - 0.12} cy={y - 0.17} rx={0.15} ry={0.09} fill="rgba(255,255,255,.65)" />
    </>
  );
}

/** Inactive seat quadrant: intentionally parked, with a faint die watermark. */
function DeadQuadrant({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y} width={6} height={6} rx={0.4} fill="#18211b" />
      <g opacity={0.14} stroke="#8fa89d" fill="#8fa89d">
        <rect
          x={x + 1.6}
          y={y + 1.6}
          width={2.8}
          height={2.8}
          rx={0.55}
          fill="none"
          strokeWidth={0.14}
        />
        <circle cx={x + 2.35} cy={y + 2.35} r={0.22} stroke="none" />
        <circle cx={x + 3} cy={y + 3} r={0.22} stroke="none" />
        <circle cx={x + 3.65} cy={y + 3.65} r={0.22} stroke="none" />
      </g>
    </g>
  );
}

interface Burst {
  key: number;
  x: number;
  y: number;
  seat: Seat; // seat of the CAPTURED token (particles take its colour)
}

export interface BoardProps {
  game: GameState;
  mySeat: Seat;
  onTokenTap(token: number): void;
}

export function Board({ game, mySeat, onTokenTap }: BoardProps) {
  const movable = game.turn === mySeat && game.phase === 'awaiting-move' ? game.legal : [];
  const positions = useAnimatedPositions(game.positions);

  // Capture FX: particle burst where a token got sent home + board shake.
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

  return (
    <div className={`boardwrap${shake ? ' boardwrap--shake' : ''}`}>
      <svg viewBox="0 0 15 15" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Ludo board">
        <defs>
          <radialGradient id="tokMe" cx="35%" cy="30%" r="85%">
            <stop offset="0%" stopColor="#63d69e" />
            <stop offset="55%" stopColor={ME_FILL} />
            <stop offset="100%" stopColor="#17714a" />
          </radialGradient>
          <radialGradient id="tokOpp" cx="35%" cy="30%" r="85%">
            <stop offset="0%" stopColor="#ffb068" />
            <stop offset="55%" stopColor={OPP_FILL} />
            <stop offset="100%" stopColor="#a8531a" />
          </radialGradient>
          <radialGradient id="potG" cx="40%" cy="35%" r="80%">
            <stop offset="0%" stopColor="#2a3a32" />
            <stop offset="100%" stopColor="#131b16" />
          </radialGradient>
        </defs>

        {/* active base quadrants (me bottom-left, opp top-right) */}
        <rect x={0} y={9} width={6} height={6} rx={0.4} fill={ME_FILL} />
        <rect x={9} y={0} width={6} height={6} rx={0.4} fill={OPP_FILL} />
        <DeadQuadrant x={0} y={0} />
        <DeadQuadrant x={9} y={9} />
        <rect x={1} y={10} width={4} height={4} rx={0.3} fill="#f6f1e4" />
        <rect x={10} y={1} width={4} height={4} rx={0.3} fill="#f6f1e4" />
        {/* resting slots inside the bases */}
        {BASE_SPOTS.map((spots, seat) =>
          spots.map(([sx, sy], i) => (
            <circle
              key={`bs${seat}-${i}`}
              cx={sx}
              cy={sy}
              r={0.44}
              fill="none"
              stroke={seat === 0 ? ME_FILL : OPP_FILL}
              strokeWidth={0.06}
              strokeDasharray="0.12 0.09"
              opacity={0.55}
            />
          )),
        )}

        {/* track */}
        {TRACK.map(([x, y], i) => (
          <rect
            key={i}
            x={x + 0.03}
            y={y + 0.03}
            width={0.94}
            height={0.94}
            rx={0.16}
            fill={SAFE_CELLS.has(i) ? '#e9e2cf' : '#f4efe6'}
            stroke="#c4bca9"
            strokeWidth={0.045}
          />
        ))}
        {[...SAFE_CELLS].map((i) => {
          const cell = TRACK[i];
          if (!cell) return null;
          return (
            <text key={`s${i}`} x={cell[0] + 0.5} y={cell[1] + 0.74} fontSize={0.62} textAnchor="middle" fill="#a89f8c">
              ★
            </text>
          );
        })}

        {/* home columns + start cells */}
        {HOME_COLUMNS.map((col, seat) =>
          col.map(([x, y], i) => (
            <rect
              key={`h${seat}-${i}`}
              x={x + 0.03}
              y={y + 0.03}
              width={0.94}
              height={0.94}
              rx={0.16}
              fill={seat === 0 ? '#7FCBA4' : '#F0B183'}
              stroke="#c4bca9"
              strokeWidth={0.045}
            />
          )),
        )}
        {SEAT_START.map((idx, seat) => {
          const cell = TRACK[idx];
          if (!cell) return null;
          return (
            <rect
              key={`d${seat}`}
              x={cell[0] + 0.03}
              y={cell[1] + 0.03}
              width={0.94}
              height={0.94}
              rx={0.16}
              fill={seat === 0 ? '#7FCBA4' : '#F0B183'}
              stroke="#c4bca9"
              strokeWidth={0.045}
            />
          );
        })}

        {/* center: goal mouths match the home-column directions (green from the
            left, orange from the right); finished tokens land on the gold pot */}
        <rect x={6} y={6} width={3} height={3} fill="#131b16" />
        <polygon points="6,6 6,9 7.5,7.5" fill={ME_FILL} />
        <polygon points="9,6 9,9 7.5,7.5" fill={OPP_FILL} />
        <polygon points="6,6 9,6 7.5,7.5" fill="#18211b" />
        <polygon points="6,9 9,9 7.5,7.5" fill="#18211b" />
        <circle cx={7.5} cy={7.5} r={0.58} fill="url(#potG)" stroke="#f5b301" strokeWidth={0.07} />
        <text x={7.5} y={7.72} fontSize={0.55} textAnchor="middle" fill="#f5b301">
          ★
        </text>

        {/* tokens */}
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
                onClick={isMovable ? () => onTokenTap(token) : undefined}
              >
                <Token x={x} y={y} seat={seat as Seat} />
                {isMovable && (
                  <circle cx={x} cy={y} r={0.55} fill="none" stroke="#F5B301" strokeWidth={0.08}>
                    <animate attributeName="r" values=".5;.6;.5" dur="1s" repeatCount="indefinite" />
                  </circle>
                )}
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
                  fill={b.seat === 0 ? ME_FILL : OPP_FILL}
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
