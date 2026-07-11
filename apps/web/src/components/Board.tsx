/**
 * SVG board generated from the engine constants (single source of truth).
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

const ME_FILL = '#2E9E6B';
const ME_STROKE = '#0f3d28';
const OPP_FILL = '#E8833A';
const OPP_STROKE = '#7a3d12';

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

export interface BoardProps {
  game: GameState;
  mySeat: Seat;
  onTokenTap(token: number): void;
}

export function Board({ game, mySeat, onTokenTap }: BoardProps) {
  const movable = game.turn === mySeat && game.phase === 'awaiting-move' ? game.legal : [];
  const positions = useAnimatedPositions(game.positions);

  return (
    <div className="boardwrap">
      <svg viewBox="0 0 15 15" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Ludo board">
        {/* base quadrants */}
        <rect x={0} y={9} width={6} height={6} rx={0.4} fill={ME_FILL} />
        <rect x={9} y={0} width={6} height={6} rx={0.4} fill={OPP_FILL} />
        <rect x={0} y={0} width={6} height={6} rx={0.4} fill="#3a4a42" />
        <rect x={9} y={9} width={6} height={6} rx={0.4} fill="#3a4a42" />
        <rect x={1} y={10} width={4} height={4} rx={0.3} fill="#F4EFE6" />
        <rect x={10} y={1} width={4} height={4} rx={0.3} fill="#F4EFE6" />
        <rect x={1} y={1} width={4} height={4} rx={0.3} fill="#2a3a32" />
        <rect x={10} y={10} width={4} height={4} rx={0.3} fill="#2a3a32" />

        {/* track */}
        {TRACK.map(([x, y], i) => (
          <rect
            key={i}
            x={x}
            y={y}
            width={1}
            height={1}
            fill={SAFE_CELLS.has(i) ? '#E7E0CE' : '#F4EFE6'}
            stroke="#C9C2B4"
            strokeWidth={0.35}
          />
        ))}
        {[...SAFE_CELLS].map((i) => {
          const cell = TRACK[i];
          if (!cell) return null;
          return (
            <text key={`s${i}`} x={cell[0] + 0.5} y={cell[1] + 0.74} fontSize={0.62} textAnchor="middle" fill="#A89F8C">
              ★
            </text>
          );
        })}

        {/* home columns + start cells */}
        {HOME_COLUMNS.map((col, seat) =>
          col.map(([x, y], i) => (
            <rect
              key={`h${seat}-${i}`}
              x={x}
              y={y}
              width={1}
              height={1}
              fill={seat === 0 ? '#7FCBA4' : '#F0B183'}
              stroke="#C9C2B4"
              strokeWidth={0.35}
            />
          )),
        )}
        {SEAT_START.map((idx, seat) => {
          const cell = TRACK[idx];
          if (!cell) return null;
          return (
            <rect
              key={`d${seat}`}
              x={cell[0]}
              y={cell[1]}
              width={1}
              height={1}
              fill={seat === 0 ? '#7FCBA4' : '#F0B183'}
              stroke="#C9C2B4"
              strokeWidth={0.35}
            />
          );
        })}

        {/* center */}
        <rect x={6} y={6} width={3} height={3} fill="#16211C" />
        <polygon points="6,6 9,6 7.5,7.5" fill={OPP_FILL} />
        <polygon points="6,9 9,9 7.5,7.5" fill={ME_FILL} />
        <polygon points="6,6 6,9 7.5,7.5" fill="#3a4a42" />
        <polygon points="9,6 9,9 7.5,7.5" fill="#3a4a42" />

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
                <circle
                  cx={x}
                  cy={y}
                  r={0.42}
                  fill={seat === 0 ? ME_FILL : OPP_FILL}
                  stroke={seat === 0 ? ME_STROKE : OPP_STROKE}
                  strokeWidth={0.14}
                />
                <circle cx={x} cy={y - 0.08} r={0.16} fill="rgba(255,255,255,.55)" />
                {isMovable && (
                  <circle cx={x} cy={y} r={0.55} fill="none" stroke="#F5B301" strokeWidth={0.08}>
                    <animate attributeName="r" values=".5;.6;.5" dur="1s" repeatCount="indefinite" />
                  </circle>
                )}
              </g>
            );
          }),
        )}
      </svg>
    </div>
  );
}
