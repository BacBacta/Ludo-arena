/**
 * SVG board generated from the engine constants (single source of truth).
 * Game-art pass: pawn-shaped pieces, gradient quadrant panels, vignette,
 * directional home-column arrows, gold safe stars, smooth tweened movement.
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
const OPP_FILL = '#E8833A';

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

/** Pawn-shaped piece: ground shadow, base, waist, glossy head. Drawn at 0,0. */
function Pawn({ seat }: { seat: Seat }) {
  const grad = seat === 0 ? 'url(#tokMe)' : 'url(#tokOpp)';
  const rim = seat === 0 ? '#0f3d28' : '#7a3d12';
  return (
    <>
      <ellipse cx={0} cy={0.34} rx={0.3} ry={0.11} fill="rgba(0,0,0,.38)" />
      <ellipse cx={0} cy={0.24} rx={0.28} ry={0.13} fill={grad} stroke={rim} strokeWidth={0.05} />
      <path
        d="M -0.17 0.22 Q -0.08 0.02 -0.075 -0.08 L 0.075 -0.08 Q 0.08 0.02 0.17 0.22 Z"
        fill={grad}
        stroke={rim}
        strokeWidth={0.045}
      />
      <circle cx={0} cy={-0.2} r={0.17} fill={grad} stroke={rim} strokeWidth={0.05} />
      <ellipse cx={-0.055} cy={-0.26} rx={0.06} ry={0.04} fill="rgba(255,255,255,.8)" />
    </>
  );
}

/** Inactive seat quadrant with a faint die watermark. */
function DeadQuadrant({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y} width={6} height={6} rx={0.5} fill="url(#deadG)" />
      <g opacity={0.13} stroke="#8fa89d" fill="#8fa89d">
        <rect x={x + 1.6} y={y + 1.6} width={2.8} height={2.8} rx={0.55} fill="none" strokeWidth={0.14} />
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

  return (
    <div className={`boardwrap${shake ? ' boardwrap--shake' : ''}`}>
      <svg viewBox="0 0 15 15" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Ludo board">
        <defs>
          <radialGradient id="tokMe" cx="35%" cy="28%" r="90%">
            <stop offset="0%" stopColor="#6fe0a8" />
            <stop offset="55%" stopColor={ME_FILL} />
            <stop offset="100%" stopColor="#14603e" />
          </radialGradient>
          <radialGradient id="tokOpp" cx="35%" cy="28%" r="90%">
            <stop offset="0%" stopColor="#ffbd7d" />
            <stop offset="55%" stopColor={OPP_FILL} />
            <stop offset="100%" stopColor="#984a15" />
          </radialGradient>
          <linearGradient id="meQ" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#3cbd83" />
            <stop offset="100%" stopColor="#1d7c50" />
          </linearGradient>
          <linearGradient id="oppQ" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f4a05c" />
            <stop offset="100%" stopColor="#c96a22" />
          </linearGradient>
          <linearGradient id="deadG" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#1c2721" />
            <stop offset="100%" stopColor="#141d18" />
          </linearGradient>
          <linearGradient id="boardBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#203026" />
            <stop offset="100%" stopColor="#131c17" />
          </linearGradient>
          <radialGradient id="vign" cx="50%" cy="45%" r="75%">
            <stop offset="60%" stopColor="rgba(0,0,0,0)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.30)" />
          </radialGradient>
          <radialGradient id="potG" cx="40%" cy="35%" r="80%">
            <stop offset="0%" stopColor="#33463b" />
            <stop offset="100%" stopColor="#101711" />
          </radialGradient>
        </defs>

        <rect x={0} y={0} width={15} height={15} rx={0.55} fill="url(#boardBg)" />

        {/* quadrant panels */}
        <rect x={0.25} y={9.25} width={5.5} height={5.5} rx={0.5} fill="url(#meQ)" />
        <rect x={9.25} y={0.25} width={5.5} height={5.5} rx={0.5} fill="url(#oppQ)" />
        <DeadQuadrant x={0.25} y={0.25} />
        <DeadQuadrant x={9.25} y={9.25} />
        <rect x={1} y={10} width={4} height={4} rx={0.35} fill="#f7f2e7" />
        <rect x={1} y={10} width={4} height={0.5} rx={0.25} fill="#ffffff" opacity={0.55} />
        <rect x={10} y={1} width={4} height={4} rx={0.35} fill="#f7f2e7" />
        <rect x={10} y={1} width={4} height={0.5} rx={0.25} fill="#ffffff" opacity={0.55} />
        {BASE_SPOTS.map((spots, seat) =>
          spots.map(([sx, sy], i) => (
            <circle
              key={`bs${seat}-${i}`}
              cx={sx}
              cy={sy}
              r={0.44}
              fill={seat === 0 ? 'rgba(46,158,107,.10)' : 'rgba(232,131,58,.12)'}
              stroke={seat === 0 ? ME_FILL : OPP_FILL}
              strokeWidth={0.06}
              strokeDasharray="0.12 0.09"
              opacity={0.7}
            />
          )),
        )}

        {/* track: alternating cream tones, inset stroke */}
        {TRACK.map(([x, y], i) => (
          <rect
            key={i}
            x={x + 0.04}
            y={y + 0.04}
            width={0.92}
            height={0.92}
            rx={0.18}
            fill={SAFE_CELLS.has(i) ? '#f0e3bd' : i % 2 ? '#f6f1e6' : '#efe9da'}
            stroke="rgba(0,0,0,.10)"
            strokeWidth={0.035}
          />
        ))}
        {[...SAFE_CELLS].map((i) => {
          const cell = TRACK[i];
          if (!cell) return null;
          return (
            <g key={`s${i}`}>
              <circle cx={cell[0] + 0.5} cy={cell[1] + 0.5} r={0.3} fill="#e4c96a" opacity={0.55} />
              <text
                x={cell[0] + 0.5}
                y={cell[1] + 0.73}
                fontSize={0.55}
                textAnchor="middle"
                fill="#9c7c17"
              >
                ★
              </text>
            </g>
          );
        })}

        {/* home columns with direction arrows */}
        {HOME_COLUMNS.map((col, seat) =>
          col.map(([x, y], i) => (
            <g key={`h${seat}-${i}`}>
              <rect
                x={x + 0.04}
                y={y + 0.04}
                width={0.92}
                height={0.92}
                rx={0.18}
                fill={seat === 0 ? '#8fd4ae' : '#f3bd90'}
                stroke="rgba(0,0,0,.10)"
                strokeWidth={0.035}
              />
              <polygon
                points={
                  seat === 0
                    ? `${x + 0.35},${y + 0.3} ${x + 0.35},${y + 0.7} ${x + 0.7},${y + 0.5}`
                    : `${x + 0.65},${y + 0.3} ${x + 0.65},${y + 0.7} ${x + 0.3},${y + 0.5}`
                }
                fill={seat === 0 ? '#1d7c50' : '#c96a22'}
                opacity={0.5}
              />
            </g>
          )),
        )}
        {SEAT_START.map((idx, seat) => {
          const cell = TRACK[idx];
          if (!cell) return null;
          return (
            <rect
              key={`d${seat}`}
              x={cell[0] + 0.04}
              y={cell[1] + 0.04}
              width={0.92}
              height={0.92}
              rx={0.18}
              fill={seat === 0 ? '#8fd4ae' : '#f3bd90'}
              stroke={seat === 0 ? ME_FILL : OPP_FILL}
              strokeWidth={0.06}
            />
          );
        })}

        {/* center: goal mouths + gold finish medallion */}
        <rect x={6} y={6} width={3} height={3} fill="#111813" />
        <polygon points="6,6 6,9 7.5,7.5" fill="url(#meQ)" />
        <polygon points="9,6 9,9 7.5,7.5" fill="url(#oppQ)" />
        <polygon points="6,6 9,6 7.5,7.5" fill="#18211b" />
        <polygon points="6,9 9,9 7.5,7.5" fill="#18211b" />
        <circle cx={7.5} cy={7.5} r={0.62} fill="url(#potG)" stroke="#f5b301" strokeWidth={0.07} />
        <text x={7.5} y={7.74} fontSize={0.58} textAnchor="middle" fill="#f5b301">
          ★
        </text>

        {/* pieces: tweened translate for smooth cell-to-cell glide */}
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
                  <circle cx={0} cy={0} r={0.56} fill="none" stroke="#F5B301" strokeWidth={0.08}>
                    <animate attributeName="r" values=".5;.62;.5" dur="1s" repeatCount="indefinite" />
                  </circle>
                )}
                <Pawn seat={seat as Seat} />
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

        <rect x={0} y={0} width={15} height={15} rx={0.55} fill="url(#vign)" pointerEvents="none" />
      </svg>
    </div>
  );
}
