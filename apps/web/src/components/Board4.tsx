/**
 * 4-player Ludo board (practice mode) — renders all four seats: blue (you,
 * bottom-left), red (top-left), green (top-right), yellow (bottom-right).
 * Same candy visual language as the 2-player <Board>, driven by ludo4 geometry.
 */
import { useEffect, useRef, useState } from 'react';
import { LAST_TRACK_REL, SAFE_CELLS, TRACK } from '@ludo/game-engine';
import { HOME_COLUMNS4, SEAT_START4, tokenXY4, type Game4 } from '@ludo/game-engine';
import { WALK_STEP_MS, WALK_TWEEN_MS } from '../lib/pacing';
import type { TokenPattern } from '../lib/tokenSkins';
import { boardThemeById, type BoardTheme } from '../lib/boardThemes';
import { PegPattern } from './Board';
import { playHop } from '../lib/sound';
import { t } from '../lib/i18n';
import { PEG_COLORS } from './Board';

/* Seat colours [lit rim, TRUE base, shadow]. Single source: Board.tsx. This
   file used to keep its own copy, which is how a 1v1 board and a 4-player board
   end up two different greens. The base [1] is the real flat panel colour. */
const { red: RED, green: GREEN, yellow: YELLOW, blue: BLUE } = PEG_COLORS;

/** seat → colour triple (matches ludo4 seat order). The board is always spun so
 *  the local player sits bottom-left, so seat 0 carries `--me` (green) exactly
 *  like the 1v1 board; blue moves to the bottom-right corner. */
const SEAT_COLORS = [GREEN, RED, YELLOW, BLUE] as const;
/** seat → quadrant origin. */
const SEAT_QUAD: ReadonlyArray<readonly [number, number]> = [
  [0, 9],
  [0, 0],
  [9, 0],
  [9, 9],
];
/** quadrant origin → colour (for drawing the four panels) — the inverse of
 *  SEAT_QUAD above, and it must stay in step with it. */
const QUADS: Array<{ o: readonly [number, number]; c: readonly [string, string, string] }> = [
  { o: [0, 9], c: SEAT_COLORS[0] },
  { o: [0, 0], c: SEAT_COLORS[1] },
  { o: [9, 0], c: SEAT_COLORS[2] },
  { o: [9, 9], c: SEAT_COLORS[3] },
];

export interface PlayerBanner4 {
  seat: number;
  name: string;
  flag: string;
  active: boolean;
  /** The local player's banner — renders the gold "YOU" chip (see Board). */
  you?: boolean;
}

/** The four resting-slot centres inside a quadrant's yard — a plain 2/4 grid on
 *  the 4x4 yard, identical to the 1v1 board (see Board.tsx). */
function quadSlots(qx: number, qy: number): Array<[number, number]> {
  return [
    [qx + 2, qy + 2],
    [qx + 4, qy + 2],
    [qx + 2, qy + 4],
    [qx + 4, qy + 4],
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
function Pawn({ seat, pattern }: { seat: number; pattern?: TokenPattern }) {
  const c = SEAT_COLORS[seat] ?? BLUE;
  const dark = c[2];
  const rim = c[0];
  const gid = `peg4-${seat}`;
  const hid = `peghead4-${seat}`;
  return (
    <>
      <defs>
        {/* body: ceramic, not plastic — narrow lit rim, long gentle falloff
            (kept identical to the 1v1 peg, which is the canonical shape) */}
        <linearGradient id={gid} x1="0" y1="0" x2="0.12" y2="1">
          <stop offset="0%" stopColor={c[0]} />
          <stop offset="26%" stopColor={c[1]} />
          <stop offset="100%" stopColor={c[2]} />
        </linearGradient>
        {/* head: glazed sphere, hot-spot upper-left, softened the same way */}
        <radialGradient id={hid} cx="34%" cy="27%" r="82%">
          <stop offset="0%" stopColor={c[0]} />
          <stop offset="45%" stopColor={c[1]} />
          <stop offset="100%" stopColor={c[2]} />
        </radialGradient>
      </defs>
      {/* contact shadow: one flat ink ellipse, as the design draws it */}
      <ellipse cx={0.02} cy={0.36} rx={0.3} ry={0.075} fill="rgba(32,30,29,.2)" />
      {/* Ludo-Club teardrop: ball top blending smoothly into a flared cone foot */}
      <path
        d="M -0.3 0.28 C -0.3 0.06 -0.17 -0.06 -0.13 -0.24 C -0.1 -0.4 0.1 -0.4 0.13 -0.24 C 0.17 -0.06 0.3 0.06 0.3 0.28 Q 0.3 0.36 0 0.36 Q -0.3 0.36 -0.3 0.28 Z"
        fill={`url(#${gid})`}
        stroke={dark}
        strokeWidth={0.026}
      />
      {/* equipped pawn-skin pattern (4p extension) — same overlay as the 1v1 peg */}
      <PegPattern pattern={pattern ?? 'none'} idKey={`peg4-${seat}${pattern && pattern !== 'none' ? `-${pattern}` : ''}`} dark={dark} />
      {/* ball top overlapping the cone (no pinched chess neck) */}
      <circle cx={0} cy={-0.28} r={0.17} fill={`url(#${hid})`} stroke={dark} strokeWidth={0.026} />
      <path d="M -0.13 -0.24 Q 0 -0.14 0.13 -0.24" fill={`url(#${hid})`} stroke="none" />
      {/* the single bright specular, then two whispers of form — glazed ceramic.
          The candy peg lit these with pure #ffffff, which punched a cold hole in
          a board whose lightest paper is #fffdf8. */}
      <ellipse cx={-0.065} cy={-0.34} rx={0.06} ry={0.046} fill="#fffdf8" opacity={0.85} />
      <path d="M -0.12 0.26 C -0.16 0.08 -0.09 -0.06 -0.06 -0.16" fill="none" stroke="#fffdf8" strokeWidth={0.045} strokeLinecap="round" opacity={0.2} />
      <path d="M 0.145 -0.33 A 0.17 0.17 0 0 1 0.06 -0.13" fill="none" stroke={rim} strokeWidth={0.03} strokeLinecap="round" opacity={0.5} />
    </>
  );
}

/** Organic quadrant — identical treatment to the 1v1 board: a knocked-back wash
 *  of the seat colour, a yard of the theme's paper ringed in that colour, and
 *  four discs tinted from it. All four seats play here, so all four are drawn. */
function Quadrant({ x, y, colors, theme }: { x: number; y: number; colors: readonly [string, string, string]; theme: BoardTheme }) {
  const crisp = theme.crisp === true;
  return (
    <g>
      <rect x={x + 0.12} y={y + 0.12} width={5.76} height={5.76} rx={crisp ? 0.15 : 0.9} fill={colors[1]} opacity={theme.quadOpacity} />
      <rect
        x={x + 1}
        y={y + 1}
        width={4}
        height={4}
        rx={crisp ? 0.1 : 0.6}
        fill={theme.yard}
        stroke={colors[1]}
        strokeWidth={crisp ? 0.12 : 0.07}
        opacity={0.95}
      />
      {quadSlots(x, y).map(([sx, sy], i) => (
        <circle key={i} cx={sx} cy={sy} r={0.52} fill={colors[1]} opacity={0.15} />
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

/**
 * Board geometry is fixed (seat 0 bottom-left, then CLOCKWISE: 1 top-left,
 * 2 top-right, 3 bottom-right), so every player but seat 0 would otherwise play
 * from a far corner. The board is spun so the local player's quadrant is always
 * bottom-left: rotate(90*k) moves seat s to seat (s+k)'s corner, hence k = -mySeat mod 4.
 */
export const quarters4 = (mySeat: number): number => (4 - (mySeat % 4)) % 4;
/** seat → the quadrant it is DRAWN in after the spin (for un-rotated HTML overlays). */
export const shownQuad4 = (seat: number, mySeat: number): number => (seat + quarters4(mySeat)) % 4;
/** inverse of `shownQuad4`: which seat is drawn in quadrant `quad`. */
export const seatAtQuad4 = (quad: number, mySeat: number): number => (quad + mySeat) % 4;

export interface Board4Props {
  game: Game4;
  mySeat: number;
  onTokenTap(token: number): void;
  banners?: PlayerBanner4[];
  /** Equipped board theme id — restyles ONLY the neutral surfaces (seat colours
   *  never change). Local view, like the 1v1 board. Absent/unknown = classic. */
  themeId?: string;
  /** Equipped pawn-skin PATTERN per seat: mine from local state, the others'
   *  from match.found4 players (bots = classic). */
  tokenPatterns?: Partial<Record<number, TokenPattern>>;
}

export function Board4({ game, mySeat, onTokenTap, banners, themeId, tokenPatterns }: Board4Props) {
  const theme = boardThemeById(themeId);
  const crisp = theme.crisp === true;
  const cellRx = crisp ? 0.04 : 0.2;
  const movable = game.turn === mySeat && game.phase === 'awaiting-move' ? game.legal : [];
  const positions = useAnimated4(game.positions);

  // Board geometry is fixed (seat 0 bottom-left, then CLOCKWISE: 1 top-left,
  // 2 top-right, 3 bottom-right), so every player but seat 0 would otherwise
  // play from a far corner. Spin the board so MY quadrant is always bottom-left:
  // rotate(90*k) moves seat s to seat (s+k)'s corner, so k = -mySeat mod 4.
  const rot = quarters4(mySeat) * 90;
  const shownQuad = (seat: number): number => shownQuad4(seat, mySeat);

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

  return (
    <div className={`boardwrap${shake ? ' boardwrap--shake' : ''}`} style={{ ['--plabel-ink' as string]: theme.onGround }}>
      <svg
        viewBox="-0.4 -0.4 15.8 15.8"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Ludo board"
        shapeRendering="geometricPrecision"
        style={{ borderRadius: theme.radius, boxShadow: theme.shadow }}
      >
        <g transform={rot ? `rotate(${rot} 7.5 7.5)` : undefined}>
        {/* the plate: the same paper the rest of the app sits on */}
        <rect
          x={-0.35}
          y={-0.35}
          width={15.7}
          height={15.7}
          rx={crisp ? 0.3 : 1.1}
          fill={theme.ground}
          stroke={theme.edge}
          strokeWidth={crisp ? 0.1 : 0.06}
        />

        {QUADS.map((q) => (
          <Quadrant key={`${q.o[0]}-${q.o[1]}`} x={q.o[0]} y={q.o[1]} colors={q.c} theme={theme} />
        ))}

        {/* track cells: inset and rounded, so the plate breathes between them */}
        {TRACK.map(([x, y], i) => (
          <rect
            key={i}
            x={x + 0.06}
            y={y + 0.06}
            width={0.88}
            height={0.88}
            rx={cellRx}
            fill={theme.cell}
            stroke={theme.cellStroke}
            strokeWidth={crisp ? 0.07 : 0.05}
          />
        ))}

        {/* start cells: the seat colour, held back so the pawn still wins the cell */}
        {SEAT_START4.map((idx, seat) => {
          const cell = TRACK[idx];
          if (!cell) return null;
          return (
            <rect
              key={`d${seat}`}
              x={cell[0] + 0.06}
              y={cell[1] + 0.06}
              width={0.88}
              height={0.88}
              rx={cellRx}
              fill={SEAT_COLORS[seat]![1]}
              opacity={crisp ? 0.85 : 0.66}
            />
          );
        })}

        {/* safe cells: a bare star, no filled tile — the mark, not a second surface */}
        {[...SAFE_CELLS].map((i) => {
          const cell = TRACK[i];
          if (!cell) return null;
          return (
            <polygon
              key={`s${i}`}
              points={starPoints(cell[0] + 0.5, cell[1] + 0.5, 0.3)}
              fill={theme.star}
              opacity={0.5}
              strokeLinejoin="round"
            />
          );
        })}

        {/* home columns: the seat colour fading as it runs in to the centre */}
        {HOME_COLUMNS4.map((col, seat) =>
          col.map(([x, y], i) => (
            <rect
              key={`h${seat}-${i}`}
              x={x + 0.06}
              y={y + 0.06}
              width={0.88}
              height={0.88}
              rx={cellRx}
              fill={SEAT_COLORS[seat]![1]}
              opacity={(crisp ? 0.9 : 0.66) - i * 0.05}
            />
          )),
        )}

        {/* centre: a rosette of the theme's own surface, then one triangle per
            seat pointing down its own arm (seat 0 bottom, 1 left, 2 top, 3
            right — the order HOME_COLUMNS4 lays out), capped by a paper dot */}
        <rect x={6} y={6} width={3} height={3} rx={crisp ? 0.1 : 0.5} fill={theme.centre} />
        <polygon points="6,6 9,6 7.5,7.5" fill={SEAT_COLORS[2]![1]} opacity={crisp ? 1 : 0.85} />
        <polygon points="9,6 9,9 7.5,7.5" fill={SEAT_COLORS[3]![1]} opacity={crisp ? 1 : 0.85} />
        <polygon points="6,9 9,9 7.5,7.5" fill={SEAT_COLORS[0]![1]} opacity={crisp ? 1 : 0.85} />
        <polygon points="6,6 6,9 7.5,7.5" fill={SEAT_COLORS[1]![1]} opacity={crisp ? 1 : 0.85} />
        <circle cx={7.5} cy={7.5} r={0.42} fill={theme.yard} stroke={theme.edge} strokeWidth={0.05} />

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
                  <circle cx={0} cy={0} r={0.58} fill="none" stroke="#C67139" strokeWidth={0.09}>
                    <animate attributeName="r" values=".52;.64;.52" dur="1s" repeatCount="indefinite" />
                  </circle>
                )}
                <g className={`token__body${walking ? ' token__body--hop' : ''}${pos === -1 ? ' token__body--base' : ''}`}>
                  {/* Counter-rotate on an INNER group: .token__body carries a CSS
                      transform (scale/hop), and CSS beats the SVG transform
                      attribute — putting the rotate there leaves the pegs tilted. */}
                  <g transform={rot ? `rotate(${-rot})` : undefined}>
                    <Pawn seat={seat} pattern={tokenPatterns?.[seat]} />
                  </g>
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
        <div key={b.seat} className={`plabel plabel--q${shownQuad(b.seat)}${b.active ? ' plabel--active' : ''}`}>
          {b.name}
          {b.you && <span className="plabel__you">{t('you').toUpperCase()}</span>}
        </div>
      ))}
    </div>
  );
}

/** Re-exported so screens can map seat → colour without duplicating the palette. */
export const SEAT_HEX = SEAT_COLORS.map((c) => c[1]);
/** Ink that stays legible ON each seat colour — board yellow needs dark text
 *  where the other three take paper (design 1d's seat chips). */
export const SEAT_ON_HEX: readonly string[] = ['#f9f4ed', '#fdf6e9', '#402310', '#f9f4ed'];
export { SEAT_QUAD };
