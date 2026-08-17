/**
 * SVG board generated from the engine constants (single source of truth).
 * Organic pass ("the premium table", design 1c/1m): the plate is the same paper
 * as the rest of the app, quadrants are a knocked-back wash of the seat colour
 * rather than four saturated blocks, track cells are inset and rounded, safe
 * cells carry a bare star instead of a filled tile, and the home column fades
 * as it runs in. Only the two seats actually playing tint a quadrant.
 * You = green (bottom-left), opponent = red clay (top-right) — matching the
 * `--me` / `--opp` roles in global.css.
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
import type { TokenPattern } from '../lib/tokenSkins';
import { boardThemeById, type BoardTheme } from '../lib/boardThemes';
import { playHop } from '../lib/sound';
import { t } from '../lib/i18n';

/** True vivid Ludo-Club palette [highlight, TRUE base, deep shade] — matches the
 *  4-player board (Board4) so the staked board reads with the same premium look. */
/* Seat colours, Organic pass — [lit rim, true colour, shadow]. The middle stop
   is the token value quoted in global.css (--seat-*); the outer two are that
   colour lifted and dropped by a fixed step, the same way the design generates
   its ceramic pieces. Pulled apart in hue AND value so four pawns stay legible
   at 12px on cream. A board cosmetic never re-skins these (golden rule). */
const RED = ['#E2512F', '#C8371B', '#9A2712'] as const;
const GREEN = ['#5A9B46', '#3F7D2F', '#2A5420'] as const;
const YELLOW = ['#FFD04A', '#F2B307', '#B8860A'] as const;
const BLUE = ['#3F83CF', '#1F5FA8', '#133F73'] as const;

/* Seat 0 is the local player and always sits bottom-left, so it carries `--me`
   (green); seat 1 is the opponent and carries `--opp` (red clay). The candy pass
   had blue/green here, which no longer matched the roles the stylesheet had
   already moved to green/red. */
const SEAT_COLOR: ReadonlyArray<readonly [string, string, string]> = [GREEN, RED];

const STEP_MS = WALK_STEP_MS; // per-cell walk pace (deliberate, readable)

/** Quadrant origin per seat: you (blue) bottom-left, opponent (green) top-right. */
const SEAT_QUAD: Record<number, readonly [number, number]> = { 0: [0, 9], 1: [9, 0] };

/** The four resting-slot centres inside a quadrant's yard. The yard is a 4x4
 *  square inset one cell into the 6x6 quadrant, so the slots land on a plain
 *  2/4 grid — no top/bottom nudge, the name label rides the board edge in CSS. */
function quadSlots(qx: number, qy: number): Array<[number, number]> {
  return [
    [qx + 2, qy + 2],
    [qx + 4, qy + 2],
    [qx + 2, qy + 4],
    [qx + 4, qy + 4],
  ];
}

export interface PlayerBanner {
  seat: Seat;
  name: string;
  flag: string;
  active: boolean;
  /** This banner is the local player's — renders a gold "YOU" chip after the
   *  name. MiniPay testers couldn't tell which side was theirs; on a 15s clock
   *  that hesitation costs the turn. */
  you?: boolean;
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
  // Each of the 4 tokens rests on its OWN disc — matching the four discs Quadrant
  // draws, exactly like Board4. The old `slots[token + 2]` crammed all four onto
  // the lower two discs, stacking the non-movable tokens ON TOP of the movable ones:
  // that hid their pulse AND stole taps (the covering copy has no onClick), so a
  // base pawn couldn't be played at all — the "die frozen after a 6" bot freeze.
  return slots[token] ?? [7.5, 7.5];
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
function Pawn({ seat, pattern }: { seat: Seat; pattern?: TokenPattern }) {
  return <PegShape c={SEAT_COLOR[seat] ?? BLUE} idKey={`peg-${seat}${pattern && pattern !== 'none' ? `-${pattern}` : ''}`} pattern={pattern} />;
}

/** Heritage pattern overlay (cosmetics phase 1): pure SVG geometry clipped to
 *  the peg body, LOW-OPACITY over the seat gradient so the seat colour always
 *  dominates (gameplay readability is untouchable). ~1-2 KB per pattern.
 *  Exported for Board4, whose peg shares the same body path. */
export function PegPattern({ pattern, idKey, dark }: { pattern: TokenPattern; idKey: string; dark: string }) {
  const pid = `${idKey}-pat`;
  const body = 'M -0.3 0.28 C -0.3 0.06 -0.17 -0.06 -0.13 -0.24 C -0.1 -0.4 0.1 -0.4 0.13 -0.24 C 0.17 -0.06 0.3 0.06 0.3 0.28 Q 0.3 0.36 0 0.36 Q -0.3 0.36 -0.3 0.28 Z';
  if (pattern === 'none') return null;
  return (
    <>
      <defs>
        {pattern === 'wax' && (
          <pattern id={pid} width={0.14} height={0.14} patternUnits="userSpaceOnUse">
            <circle cx={0.045} cy={0.045} r={0.03} fill="#fff6df" />
            <circle cx={0.045} cy={0.045} r={0.012} fill={dark} />
          </pattern>
        )}
        {pattern === 'kente' && (
          <pattern id={pid} width={0.2} height={0.16} patternUnits="userSpaceOnUse">
            <rect width={0.2} height={0.05} fill="#f5b301" />
            <rect y={0.05} width={0.2} height={0.02} fill="#0c130f" />
            <rect y={0.07} width={0.2} height={0.05} fill="#2e9e6b" />
            <rect y={0.12} width={0.2} height={0.02} fill="#0c130f" />
            <rect x={0.09} width={0.02} height={0.16} fill="#0c130f" opacity={0.7} />
          </pattern>
        )}
        {pattern === 'bogolan' && (
          <pattern id={pid} width={0.18} height={0.14} patternUnits="userSpaceOnUse">
            <rect width={0.18} height={0.14} fill="#2a1c0e" />
            <path d="M 0 0.045 L 0.045 0.1 L 0.09 0.045 L 0.135 0.1 L 0.18 0.045" fill="none" stroke="#f2e5c9" strokeWidth={0.02} />
            <circle cx={0.09} cy={0.02} r={0.011} fill="#f2e5c9" />
          </pattern>
        )}
        {pattern === 'gilded' && (
          <linearGradient id={pid} x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0%" stopColor="#fff3c4" />
            <stop offset="35%" stopColor="#f5b301" />
            <stop offset="65%" stopColor="#b98700" />
            <stop offset="100%" stopColor="#8a6400" />
          </linearGradient>
        )}
        {pattern === 'lion' && (
          // Legendary (phase 3): tawny coat wash; the mane strokes are drawn below.
          <linearGradient id={pid} x1="0" y1="0" x2="0.15" y2="1">
            <stop offset="0%" stopColor="#ffd98a" />
            <stop offset="55%" stopColor="#e8a33d" />
            <stop offset="100%" stopColor="#8a5a10" />
          </linearGradient>
        )}
      </defs>
      {/* gilded/lion = a stronger wash; heritage fabrics = soft cloth band */}
      <path d={body} fill={`url(#${pid})`} opacity={pattern === 'gilded' ? 0.55 : pattern === 'lion' ? 0.5 : 0.38} />
      {pattern === 'gilded' && (
        <path d="M -0.1 0.24 C -0.14 0.06 -0.07 -0.08 -0.04 -0.18" fill="none" stroke="#fff8dc" strokeWidth={0.05} strokeLinecap="round" opacity={0.6} />
      )}
      {pattern === 'lion' && (
        // Mane: dark amber strokes fanning around the shoulders of the body.
        <g stroke="#6e4408" strokeWidth={0.032} strokeLinecap="round" fill="none" opacity={0.75}>
          <path d="M -0.16 -0.12 C -0.2 -0.02 -0.2 0.08 -0.17 0.16" />
          <path d="M 0.16 -0.12 C 0.2 -0.02 0.2 0.08 0.17 0.16" />
          <path d="M -0.08 -0.2 C -0.12 -0.08 -0.12 0.06 -0.09 0.2" />
          <path d="M 0.08 -0.2 C 0.12 -0.08 0.12 0.06 0.09 0.2" />
          <path d="M 0 -0.22 C -0.02 -0.06 -0.02 0.1 0 0.24" />
        </g>
      )}
    </>
  );
}

/** The peg geometry itself, parameterised so the lobby hero can reuse it with
 *  any of the four seat colours (gradient ids must be unique per instance). */
function PegShape({ c, idKey, pattern = 'none' }: { c: readonly [string, string, string]; idKey: string; pattern?: TokenPattern }) {
  const dark = c[2];
  const rim = c[0];
  const gid = idKey;
  const hid = `${idKey}-head`;
  return (
    <>
      <defs>
        {/* body: ceramic, not plastic — a narrow lit rim, then a long gentle
            falloff into the shade. The candy peg ramped hard at 20%, which read
            as a moulded toy under a studio light. */}
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
      {/* teardrop: ball top blending smoothly into a flared cone foot */}
      <path
        d="M -0.3 0.28 C -0.3 0.06 -0.17 -0.06 -0.13 -0.24 C -0.1 -0.4 0.1 -0.4 0.13 -0.24 C 0.17 -0.06 0.3 0.06 0.3 0.28 Q 0.3 0.36 0 0.36 Q -0.3 0.36 -0.3 0.28 Z"
        fill={`url(#${gid})`}
        stroke={dark}
        strokeWidth={0.026}
      />
      <PegPattern pattern={pattern} idKey={idKey} dark={dark} />
      <circle cx={0} cy={-0.28} r={0.17} fill={`url(#${hid})`} stroke={dark} strokeWidth={0.026} />
      <path d="M -0.13 -0.24 Q 0 -0.14 0.13 -0.24" fill={`url(#${hid})`} stroke="none" />
      {/* the single bright specular the design keeps, then two whispers of form
          on the cone and rim — glazed ceramic, not a wet plastic bead */}
      <ellipse cx={-0.065} cy={-0.34} rx={0.06} ry={0.046} fill="#fffdf8" opacity={0.85} />
      <path d="M -0.12 0.26 C -0.16 0.08 -0.09 -0.06 -0.06 -0.16" fill="none" stroke="#fffdf8" strokeWidth={0.045} strokeLinecap="round" opacity={0.2} />
      <path d="M 0.145 -0.33 A 0.17 0.17 0 0 1 0.06 -0.13" fill="none" stroke={rim} strokeWidth={0.03} strokeLinecap="round" opacity={0.5} />
    </>
  );
}

/** The four canonical seat colour triples, for use outside the board (lobby hero). */
export const PEG_COLORS = { blue: BLUE, green: GREEN, red: RED, yellow: YELLOW } as const;

/** Standalone peg preview for the cosmetics shop (token-skin tiles). */
export function TokenPreview({ pattern, idKey }: { pattern: TokenPattern; idKey: string }) {
  return (
    <svg viewBox="-0.42 -0.52 0.84 0.98" style={{ width: 44, height: 50, display: 'block', margin: '0 auto' }} aria-hidden="true">
      <PegShape c={BLUE} idKey={idKey} pattern={pattern} />
    </svg>
  );
}

/** Mini board swatch for the cosmetics shop (board-theme tiles): the four seat
 *  corners around a themed track cross, so the NEUTRAL surfaces (what a theme
 *  actually changes) carry the tile. */
export function BoardThemePreview({ theme }: { theme: BoardTheme }) {
  const crisp = theme.crisp === true;
  const quads: ReadonlyArray<readonly [number, number, readonly [string, string, string]]> = [
    [0, 0, RED],
    [9, 0, YELLOW],
    [0, 9, GREEN],
    [9, 9, BLUE],
  ];
  return (
    <svg viewBox="0 0 15 15" style={{ width: 44, height: 44, display: 'block', margin: '0 auto', borderRadius: crisp ? 2 : 6 }} aria-hidden="true">
      <rect x={0} y={0} width={15} height={15} fill={theme.ground} />
      {quads.map(([qx, qy, c]) => (
        <g key={`${qx}-${qy}`}>
          <rect x={qx + 0.12} y={qy + 0.12} width={5.76} height={5.76} rx={crisp ? 0.15 : 0.9} fill={c[1]} opacity={theme.quadOpacity} />
          <rect
            x={qx + 1}
            y={qy + 1}
            width={4}
            height={4}
            rx={crisp ? 0.1 : 0.6}
            fill={theme.yard}
            stroke={c[1]}
            strokeWidth={crisp ? 0.12 : 0.07}
            opacity={0.95}
          />
        </g>
      ))}
      {[6, 7, 8].map((c) => (
        <g key={c}>
          <rect x={c + 0.06} y={0.06} width={0.88} height={14.88} fill={theme.cell} stroke={theme.cellStroke} strokeWidth={0.05} />
          <rect x={0.06} y={c + 0.06} width={14.88} height={0.88} fill={theme.cell} stroke={theme.cellStroke} strokeWidth={0.05} />
        </g>
      ))}
      <rect x={6} y={6} width={3} height={3} rx={crisp ? 0.1 : 0.5} fill={theme.centre} />
      <polygon points={starPoints(6.5, 3, 0.4)} fill={theme.star} opacity={0.5} />
      <polygon points={starPoints(8.5, 12, 0.4)} fill={theme.star} opacity={0.5} />
    </svg>
  );
}

/** One standalone pawn in its own <svg>, for the lobby hero scene. */
export function HeroPeg({ colors, idKey }: { colors: readonly [string, string, string]; idKey: string }) {
  return (
    <svg className="heropeg" viewBox="-0.38 -0.5 0.76 0.96" aria-hidden="true">
      <PegShape c={colors} idKey={idKey} />
    </svg>
  );
}

/**
 * Quadrant panel, Organic pass: a knocked-back wash of the seat colour on the
 * plate (never a saturated block), holding a yard of the theme's paper ringed in
 * the seat colour, with four resting discs tinted from the same colour. The
 * theme decides how far back the wash sits; the colour itself is always the
 * canonical seat value.
 */
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
  seat: Seat;
}

export interface BoardProps {
  game: GameState;
  mySeat: Seat;
  onTokenTap(token: number): void;
  /** A move intent is in flight (awaiting the server echo): suppress token taps
   *  and the movable pulse so a slow RTT can't be re-tapped into a duplicate move. */
  locked?: boolean;
  /** Name banners drawn on each seat's quadrant (Ludo-Club style). */
  banners?: PlayerBanner[];
  /** Equipped token-skin PATTERN per seat (cosmetics phase 1) — mine from local
   *  state, the opponent's from match.found. Absent seat = classic peg. */
  tokenPatterns?: Partial<Record<Seat, TokenPattern>>;
  /** Equipped board theme id (cosmetics phase 2) — restyles ONLY the neutral
   *  surfaces; seat colours never change. Absent/unknown = classic. */
  themeId?: string;
}

export function Board({ game, mySeat, onTokenTap, locked, banners, tokenPatterns, themeId }: BoardProps) {
  const theme = boardThemeById(themeId);
  // The two seats sit DIAGONALLY (0 = bottom-left, 1 = top-right) and the geometry
  // is fixed, so seat 1 would play from the far corner with the opponent sitting in
  // "their" place — the board read upside-down and every tap felt wrong. Mirror the
  // whole board 180° for seat 1 so YOU are always at the bottom, like any Ludo.
  const flip = mySeat === 1;
  const movable = !locked && game.turn === mySeat && game.phase === 'awaiting-move' ? game.legal : [];
  const positions = useAnimatedPositions(game.positions);

  // Fan out every token sharing a TRACK cell (both colours) so none is hidden.
  const trackGroups = new Map<number, Array<{ seat: number; token: number }>>();
  positions.forEach((row, seat) =>
    row.forEach((pos, token) => {
      if (pos < 0 || pos > LAST_TRACK_REL) return;
      const cell = ((SEAT_START[seat] ?? 0) + pos) % TRACK_LEN;
      const g = trackGroups.get(cell);
      if (g) g.push({ seat, token });
      else trackGroups.set(cell, [{ seat, token }]);
    }),
  );
  function fanOffset(seat: number, token: number, pos: number): [number, number] {
    if (pos < 0 || pos > LAST_TRACK_REL) return [0, 0];
    const group = trackGroups.get(((SEAT_START[seat] ?? 0) + pos) % TRACK_LEN);
    if (!group || group.length < 2) return [0, 0];
    const idx = group.findIndex((o) => o.seat === seat && o.token === token);
    const n = group.length;
    const r = n === 2 ? 0.17 : 0.22;
    const a = (idx / n) * Math.PI * 2 - Math.PI / 2;
    return [Math.cos(a) * r, Math.sin(a) * r];
  }

  const prevRef = useRef(game.positions);
  const [bursts, setBursts] = useState<Burst[]>([]);
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
          // Capture feedback stays LOCAL (a particle burst on the eaten pawn). The
          // whole-board shake was removed on purpose — translating the entire board
          // on every capture read as the board being unstable.
          setTimeout(() => setBursts((b) => b.filter((bb) => bb.key !== key)), 650);
        }
      }),
    );
  }, [game.positions]);

  const crisp = theme.crisp === true;
  const cellRx = crisp ? 0.04 : 0.2;

  return (
    <div className="boardwrap" style={{ ['--plabel-ink' as string]: theme.onGround }}>
      <svg
        viewBox="-0.4 -0.4 15.8 15.8"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Ludo board"
        shapeRendering="geometricPrecision"
        style={{ borderRadius: theme.radius, boxShadow: theme.shadow }}
      >
        <g transform={flip ? 'rotate(180 7.5 7.5)' : undefined}>
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

        {/* Only the seats actually playing tint a quadrant — the empty corners stay
            bare plate. The candy board painted all four, which invented two
            opponents who were never in the game. */}
        <Quadrant x={0} y={9} colors={SEAT_COLOR[0]!} theme={theme} />
        <Quadrant x={9} y={0} colors={SEAT_COLOR[1]!} theme={theme} />

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
        {SEAT_START.map((idx, seat) => {
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
              fill={SEAT_COLOR[seat as Seat]![1]}
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
        {HOME_COLUMNS.map((col, seat) =>
          col.map(([x, y], i) => (
            <rect
              key={`h${seat}-${i}`}
              x={x + 0.06}
              y={y + 0.06}
              width={0.88}
              height={0.88}
              rx={cellRx}
              fill={SEAT_COLOR[seat]![1]}
              opacity={(crisp ? 0.9 : 0.66) - i * 0.05}
            />
          )),
        )}

        {/* centre: a rosette of the theme's own surface, the two playing seats'
            triangles, and a paper dot capping the middle */}
        <rect x={6} y={6} width={3} height={3} rx={crisp ? 0.1 : 0.5} fill={theme.centre} />
        <polygon points="6,6 9,6 7.5,7.5" fill={theme.cellStroke} opacity={0.6} />
        <polygon points="6,9 9,9 7.5,7.5" fill={theme.cellStroke} opacity={0.6} />
        <polygon points="6,6 6,9 7.5,7.5" fill={SEAT_COLOR[0]![1]} opacity={crisp ? 1 : 0.85} />
        <polygon points="9,6 9,9 7.5,7.5" fill={SEAT_COLOR[1]![1]} opacity={crisp ? 1 : 0.85} />
        <circle cx={7.5} cy={7.5} r={0.42} fill={theme.yard} stroke={theme.edge} strokeWidth={0.05} />

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
              const [dx, dy] = fanOffset(seat, token, pos);
              x += dx;
              y += dy;
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
                <g className={`token__body${pos !== (game.positions[seat]?.[token] ?? pos) ? ' token__body--hop' : ''}${pos === -1 ? ' token__body--base' : ''}`}>
                  {/* Counter-rotate on an INNER group: .token__body carries a CSS
                      transform (scale/hop), and CSS beats the SVG transform
                      attribute — putting the rotate there left the pegs upside-down. */}
                  <g transform={flip ? 'rotate(180)' : undefined}>
                    <Pawn seat={seat as Seat} pattern={tokenPatterns?.[seat as Seat]} />
                  </g>
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
        </g>
      </svg>

      {/* plain white name labels painted on each quadrant (Board4 style; the
          flag/avatar identity lives in the corner avatar cards). Labels are
          HTML overlays (never rotated), so they follow the DISPLAYED corner:
          on a flipped board seat 1 shows bottom-left (q0), seat 0 top-right (q2). */}
      {banners?.map((b) => (
        <div
          key={b.seat}
          className={`plabel plabel--q${(flip ? 1 - b.seat : b.seat) === 0 ? 0 : 2}${b.active ? ' plabel--active' : ''}`}
        >
          {b.name}
          {b.you && <span className="plabel__you">{t('you').toUpperCase()}</span>}
        </div>
      ))}
    </div>
  );
}
