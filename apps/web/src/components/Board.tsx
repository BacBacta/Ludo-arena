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
import type { TokenPattern } from '../lib/tokenSkins';
import { boardThemeById, type BoardTheme } from '../lib/boardThemes';
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

/** Centre of a quadrant's white home square (4-player geometry: the label band
 *  sits on the OUTER edge, exactly like Board4). */
function homeCenter(qx: number, qy: number): [number, number] {
  const isTop = qy === 0;
  const hy = isTop ? qy + 1.05 : qy + 0.45;
  return [qx + 3, hy + 2.25];
}

/** The four resting-slot centres inside a quadrant's home square (Board4). */
function quadSlots(qx: number, qy: number): Array<[number, number]> {
  const [cx, cy] = homeCenter(qx, qy);
  return [
    [cx - 0.85, cy - 0.85],
    [cx + 0.85, cy - 0.85],
    [cx - 0.85, cy + 0.85],
    [cx + 0.85, cy + 0.85],
  ];
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
 *  dominates (gameplay readability is untouchable). ~1-2 KB per pattern. */
function PegPattern({ pattern, idKey, dark }: { pattern: TokenPattern; idKey: string; dark: string }) {
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
        {/* body: thin light rim at the top, then the TRUE colour dominates */}
        <linearGradient id={gid} x1="0" y1="0" x2="0.12" y2="1">
          <stop offset="0%" stopColor={c[0]} />
          <stop offset="20%" stopColor={c[1]} />
          <stop offset="100%" stopColor={c[2]} />
        </linearGradient>
        {/* head: radial glossy sphere, hot-spot upper-left (matches Board4) */}
        <radialGradient id={hid} cx="34%" cy="27%" r="82%">
          <stop offset="0%" stopColor={c[0]} />
          <stop offset="34%" stopColor={c[1]} />
          <stop offset="100%" stopColor={c[2]} />
        </radialGradient>
        {/* soft radial cast shadow (Board4's pawnCast, per-instance id) */}
        <radialGradient id={`${idKey}-cast`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#0f1f4d" stopOpacity="0.42" />
          <stop offset="58%" stopColor="#0f1f4d" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#0f1f4d" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* soft contact shadow, directly under the foot */}
      <ellipse cx={0.02} cy={0.36} rx={0.3} ry={0.08} fill={`url(#${idKey}-cast)`} />
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
      {/* glossy highlights: hot-spot on the ball + streak down the cone + rim reflection */}
      <ellipse cx={-0.065} cy={-0.34} rx={0.065} ry={0.05} fill="#ffffff" opacity={0.95} />
      <path d="M -0.12 0.26 C -0.16 0.08 -0.09 -0.06 -0.06 -0.16" fill="none" stroke="#ffffff" strokeWidth={0.045} strokeLinecap="round" opacity={0.45} />
      <path d="M 0.145 -0.33 A 0.17 0.17 0 0 1 0.06 -0.13" fill="none" stroke={rim} strokeWidth={0.03} strokeLinecap="round" opacity={0.85} />
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
  return (
    <svg viewBox="0 0 15 15" style={{ width: 44, height: 44, display: 'block', margin: '0 auto', borderRadius: 6 }} aria-hidden="true">
      <rect x={0} y={0} width={15} height={15} fill={theme.cell} />
      <rect x={0} y={0} width={6} height={6} fill={RED[1]} />
      <rect x={9} y={0} width={6} height={6} fill={GREEN[1]} />
      <rect x={0} y={9} width={6} height={6} fill={BLUE[1]} />
      <rect x={9} y={9} width={6} height={6} fill={YELLOW[1]} />
      <rect x={1.1} y={1.1} width={3.8} height={3.8} rx={0.7} fill={theme.home} />
      <rect x={10.1} y={1.1} width={3.8} height={3.8} rx={0.7} fill={theme.home} />
      <rect x={1.1} y={10.1} width={3.8} height={3.8} rx={0.7} fill={theme.home} />
      <rect x={10.1} y={10.1} width={3.8} height={3.8} rx={0.7} fill={theme.home} />
      {[6, 7, 8].map((c) => (
        <g key={c}>
          <rect x={c} y={0} width={1} height={15} fill={theme.cell} stroke={theme.cellStroke} strokeWidth={0.08} />
          <rect x={0} y={c} width={15} height={1} fill={theme.cell} stroke={theme.cellStroke} strokeWidth={0.08} />
        </g>
      ))}
      <rect x={6} y={2.5} width={1} height={1} fill={theme.safe} />
      <polygon points={starPoints(6.5, 3, 0.4)} fill={theme.safeStar} />
      <rect x={8} y={11.5} width={1} height={1} fill={theme.safe} />
      <polygon points={starPoints(8.5, 12, 0.4)} fill={theme.safeStar} />
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
 * Quadrant panel, Ludo-Club style: solid candy colour, a big white rounded home
 * square with grey resting slots. The tray is nudged toward the board centre so
 * the outer band holds the name banner (rendered as HTML over the board).
 */
function Quadrant({ x, y, colors, theme }: { x: number; y: number; colors: readonly [string, string, string]; theme: BoardTheme }) {
  const isTop = y === 0;
  const hy = isTop ? y + 1.05 : y + 0.45;
  const slots = quadSlots(x, y);
  return (
    <g>
      {/* flat solid quadrant, square edges — the board reads as ONE continuous surface */}
      <rect x={x} y={y} width={6} height={6} fill={colors[1]} />
      {/* home square with a soft drop edge (Board4 geometry) — themed surface */}
      <rect x={x + 0.77} y={hy + 0.07} width={4.5} height={4.5} rx={0.45} fill={theme.homeEdge} />
      <rect x={x + 0.75} y={hy} width={4.5} height={4.5} rx={0.45} fill={theme.home} />
      {/* all four resting discs, exactly like the 4-player board — the unused
          seats' homes sit pristine and empty (Ludo-Club 1v1 look) */}
      {slots.map(([sx, sy], i) => (
        <circle key={i} cx={sx} cy={sy} r={0.56} fill={theme.slot} />
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
    <div className="boardwrap">
      <svg
        viewBox="0 0 15 15"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Ludo board"
        shapeRendering="geometricPrecision"
      >
        <defs>
          <clipPath id="boardclip">
            <rect x={0} y={0} width={15} height={15} rx={0.35} />
          </clipPath>
        </defs>
        <g clipPath="url(#boardclip)" transform={flip ? 'rotate(180 7.5 7.5)' : undefined}>
        {/* flat plate (edge-to-edge; the wrapper gives the soft shadow) — themed */}
        <rect x={0} y={0} width={15} height={15} fill={theme.cell} />

        {/* quadrants: red / green / blue / yellow (classic) */}
        <Quadrant x={0} y={0} colors={RED} theme={theme} />
        <Quadrant x={9} y={0} colors={GREEN} theme={theme} />
        <Quadrant x={0} y={9} colors={BLUE} theme={theme} />
        <Quadrant x={9} y={9} colors={YELLOW} theme={theme} />

        {/* track cells: continuous grid, shared hairline borders (matches the 4-player board) */}
        {TRACK.map(([x, y], i) => (
          <rect key={i} x={x} y={y} width={1} height={1} fill={theme.cell} stroke={theme.cellStroke} strokeWidth={0.05} />
        ))}

        {/* safe cells: filled cell carrying a star (matches the 4-player board) */}
        {[...SAFE_CELLS].map((i) => {
          const cell = TRACK[i];
          if (!cell) return null;
          const cx = cell[0] + 0.5;
          const cy = cell[1] + 0.5;
          return (
            <g key={`s${i}`}>
              <rect x={cell[0]} y={cell[1]} width={1} height={1} fill={theme.safe} stroke={theme.cellStroke} strokeWidth={0.05} />
              <polygon points={starPoints(cx, cy, 0.36)} fill={theme.safeStar} strokeLinejoin="round" />
            </g>
          );
        })}

        {/* home columns: solid seat colour, flat square (matches the 4-player board) */}
        {HOME_COLUMNS.map((col, seat) =>
          col.map(([x, y], i) => (
            <rect
              key={`h${seat}-${i}`}
              x={x}
              y={y}
              width={1}
              height={1}
              fill={SEAT_COLOR[seat]![1]}
              stroke={SEAT_COLOR[seat]![2]}
              strokeWidth={0.035}
            />
          )),
        )}

        {/* start cells: solid seat colour, flat square */}
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
              fill={SEAT_COLOR[seat as Seat]![1]}
              stroke={SEAT_COLOR[seat as Seat]![2]}
              strokeWidth={0.035}
            />
          );
        })}

        {/* big coloured chevrons at the four home-run entries (Ludo-Club) */}
        {edgeChevron(0.5, 7.5, 0, BLUE[1], 'eb')}
        {edgeChevron(14.5, 7.5, 180, GREEN[1], 'eg')}
        {edgeChevron(7.5, 0.5, 90, RED[1], 'er')}
        {edgeChevron(7.5, 14.5, 270, YELLOW[1], 'ey')}

        {/* centre: plain four-triangle pinwheel (matches the 4-player board) */}
        <polygon points="6,6 9,6 7.5,7.5" fill={RED[1]} />
        <polygon points="9,6 9,9 7.5,7.5" fill={GREEN[1]} />
        <polygon points="6,9 9,9 7.5,7.5" fill={YELLOW[1]} />
        <polygon points="6,6 6,9 7.5,7.5" fill={BLUE[1]} />

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
                  <circle cx={0} cy={0} r={0.58} fill="none" stroke="#F5B301" strokeWidth={0.09}>
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
        </div>
      ))}
    </div>
  );
}
