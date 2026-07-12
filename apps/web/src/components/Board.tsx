/**
 * SVG board generated from the engine constants (single source of truth).
 * Premium pass (benchmarked vs Ludo King / Ludo Club / Yalla Ludo 2026):
 * a raised bevelled frame around a recessed play well, real SVG depth via
 * reusable inner-shadow / drop-shadow filters (applied only to STATIC layers),
 * 3-stop candy gradients, an elevated gold centre dome, debossed safe stars,
 * and injection-moulded glossy pawns whose soft shadows are baked into
 * gradients (never filters) so the ~8 animated tokens stay at 60fps.
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

/** Classic palette: [light, base, dark] per colour. Bases match app-wide CSS;
 *  lights brightened and darks deepened so the candy gradients read glossy. */
const RED = ['#FF7A6E', '#E5484D', '#9E2529'] as const;
const GREEN = ['#6AD873', '#46A758', '#256F35'] as const;
const YELLOW = ['#FFD75A', '#F4B400', '#A9760A'] as const;
const BLUE = ['#6C9BFF', '#3E63DD', '#23408F'] as const;

const SEAT_COLOR: ReadonlyArray<readonly [string, string, string]> = [BLUE, GREEN];

/** Per-seat pawn material tokens (glossy plastic): [bodyGradId, rim, dark, occl]. */
const PAWN_MAT: Record<number, { grad: string; rim: string; dark: string; occl: string }> = {
  0: { grad: 'url(#pawnMeBody)', rim: '#bcd0ff', dark: '#182f63', occl: '#0e2149' },
  1: { grad: 'url(#pawnOppBody)', rim: '#b3efb0', dark: '#17512a', occl: '#0d3d1f' },
};

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

/**
 * Injection-moulded glossy pawn. Single top-left light: hot-spot core near the
 * head, Fresnel rim on the lower-right, occluded neck seam, wide moulded flange,
 * and a soft gradient contact shadow (no filter → cheap under animation).
 */
function Pawn({ seat }: { seat: Seat }) {
  const m = PAWN_MAT[seat] ?? PAWN_MAT[0]!;
  const grad = m.grad;
  return (
    <>
      {/* soft contact shadow, offset down-right (gradient falloff = fake blur) */}
      <ellipse cx={0.03} cy={0.44} rx={0.42} ry={0.13} fill="url(#pawnCast)" />
      {/* wide moulded flange behind the dome */}
      <ellipse cx={0} cy={0.31} rx={0.37} ry={0.135} fill={m.dark} opacity={0.9} />
      {/* base dome */}
      <ellipse cx={0} cy={0.26} rx={0.34} ry={0.16} fill={grad} stroke={m.dark} strokeWidth={0.03} />
      {/* neck / waist */}
      <path
        d="M -0.24 0.24 Q -0.11 0.05 -0.1 -0.05 L 0.1 -0.05 Q 0.11 0.05 0.24 0.24 Z"
        fill={grad}
        stroke={m.dark}
        strokeWidth={0.035}
      />
      {/* neck seam occlusion under the head */}
      <ellipse cx={0} cy={-0.045} rx={0.115} ry={0.045} fill={m.occl} opacity={0.55} />
      {/* head */}
      <circle cx={0} cy={-0.21} r={0.23} fill={grad} stroke={m.dark} strokeWidth={0.03} />
      {/* Fresnel rim on the shadowed lower-right edge — the key gloss cue */}
      <path
        d="M 0.205 -0.30 A 0.23 0.23 0 0 1 0.05 0.005"
        fill="none"
        stroke={m.rim}
        strokeWidth={0.032}
        strokeLinecap="round"
        opacity={0.8}
      />
      {/* bright hot-spot core (top-left of head) */}
      <ellipse cx={-0.08} cy={-0.29} rx={0.085} ry={0.06} fill="#ffffff" opacity={0.92} />
      {/* broad soft sheen */}
      <ellipse cx={-0.04} cy={-0.17} rx={0.12} ry={0.05} fill="#ffffff" opacity={0.14} />
      {/* base catch-light */}
      <ellipse cx={-0.1} cy={0.2} rx={0.07} ry={0.03} fill="#ffffff" opacity={0.4} />
    </>
  );
}

/**
 * Home-yard panel: 3-stop candy wall, a bright top lip, a recessed white tray
 * (inner-shadow filter) and dished sockets for resting pawns.
 */
function Quadrant({
  x,
  y,
  yardGrad,
  dark,
  active,
}: {
  x: number;
  y: number;
  yardGrad: string;
  dark: string;
  active: boolean;
}) {
  return (
    <g>
      <rect x={x} y={y} width={6} height={6} rx={0.6} fill={yardGrad} />
      {/* single top-left gloss (shared sheen) */}
      <rect x={x + 0.14} y={y + 0.14} width={5.72} height={5.72} rx={0.5} fill="url(#sheenV)" />
      {/* dark bottom bevel */}
      <rect x={x + 0.14} y={y + 5.32} width={5.72} height={0.54} rx={0.4} fill={dark} opacity={0.5} />
      {/* recessed white tray */}
      <rect x={x + 1} y={y + 1} width={4} height={4} rx={0.55} fill="#ffffff" filter="url(#fInset)" />
      <rect
        x={x + 1}
        y={y + 1}
        width={4}
        height={4}
        rx={0.55}
        fill="none"
        stroke={dark}
        strokeWidth={0.04}
        opacity={0.28}
      />
      {!active &&
        [
          [x + 2.3, y + 2.3],
          [x + 3.7, y + 2.3],
          [x + 2.3, y + 3.7],
          [x + 3.7, y + 3.7],
        ].map(([cx, cy], i) => (
          <g key={i}>
            <circle cx={cx} cy={cy} r={0.5} fill="url(#socket)" />
            <circle cx={cx} cy={cy} r={0.5} fill="none" stroke="#aab4c9" strokeWidth={0.05} opacity={0.7} />
          </g>
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

  /** Raised chevron on a start cell, pointing along the first track step. */
  const startChevron = (seat: Seat) => {
    const idx = SEAT_START[seat] ?? 0;
    const cell = TRACK[idx];
    const next = TRACK[(idx + 1) % TRACK_LEN];
    if (!cell || !next) return null;
    const [cx, cy] = [cell[0] + 0.5, cell[1] + 0.5];
    const ang = (Math.atan2(next[1] - cell[1], next[0] - cell[0]) * 180) / Math.PI;
    return (
      <g key={`ch${seat}`} transform={`rotate(${ang} ${cx} ${cy})`}>
        {/* drop shadow of the glyph = embossed look */}
        <path
          d={`M ${cx - 0.16} ${cy - 0.26} L ${cx + 0.18} ${cy + 0.02} L ${cx - 0.16} ${cy + 0.3}`}
          fill="none"
          stroke={SEAT_COLOR[seat]![2]}
          strokeWidth={0.17}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.6}
        />
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
      <svg
        viewBox="-0.55 -0.55 16.1 16.1"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Ludo board"
        shapeRendering="geometricPrecision"
      >
        <defs>
          {/* --- reusable depth filters (STATIC layers only, never on tokens) --- */}
          <filter id="fInset" x="-25%" y="-25%" width="150%" height="150%">
            <feOffset dy="0.06" />
            <feGaussianBlur stdDeviation="0.09" result="ib" />
            <feComposite operator="out" in="SourceGraphic" in2="ib" result="iv" />
            <feFlood floodColor="#0e1f52" floodOpacity="0.4" />
            <feComposite operator="in" in2="iv" result="sh" />
            <feComposite operator="over" in="sh" in2="SourceGraphic" />
          </filter>
          <filter id="fTile" x="-8%" y="-8%" width="116%" height="116%">
            <feDropShadow dx="0" dy="0.05" stdDeviation="0.045" floodColor="#1c2b63" floodOpacity="0.32" />
          </filter>
          <filter id="fLift" x="-70%" y="-70%" width="240%" height="240%">
            <feDropShadow dx="0" dy="0.14" stdDeviation="0.16" floodColor="#0d1a44" floodOpacity="0.5" />
          </filter>
          <filter id="fFrame" x="-15%" y="-15%" width="130%" height="130%">
            <feDropShadow dx="0" dy="0.2" stdDeviation="0.26" floodColor="#0b1636" floodOpacity="0.5" />
          </filter>
          <filter id="fStar" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="0.03" stdDeviation="0.025" floodColor="#7a5300" floodOpacity="0.4" />
          </filter>

          {/* --- one light model: top-left key, all surface gradients on TL→BR --- */}
          <linearGradient id="frameG" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#fdfefe" />
            <stop offset="52%" stopColor="#e7ecf6" />
            <stop offset="100%" stopColor="#c8d2e6" />
          </linearGradient>
          <radialGradient id="frameSheen" cx="26%" cy="16%" r="80%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.7" />
            <stop offset="45%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="goldTrim" x1="0" y1="0" x2="0.35" y2="1">
            <stop offset="0%" stopColor="#ffe9a8" />
            <stop offset="50%" stopColor="#f5b301" />
            <stop offset="100%" stopColor="#b8790a" />
          </linearGradient>
          <radialGradient id="rivet" cx="35%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#fff2c2" />
            <stop offset="60%" stopColor="#f5b301" />
            <stop offset="100%" stopColor="#9c650a" />
          </radialGradient>
          <linearGradient id="wellG" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#e6ebf5" />
            <stop offset="100%" stopColor="#d5ddec" />
          </linearGradient>

          {/* board-wide glass overlays (zero filter cost) */}
          <radialGradient id="boardSheen" cx="26%" cy="18%" r="62%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.4" />
            <stop offset="45%" stopColor="#ffffff" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="vignette" cx="42%" cy="38%" r="72%">
            <stop offset="55%" stopColor="#0a1330" stopOpacity="0" />
            <stop offset="100%" stopColor="#0a1330" stopOpacity="0.15" />
          </radialGradient>
          {/* shared gloss reused on every glossy inlay */}
          <linearGradient id="sheenV" x1="0" y1="0" x2="0.18" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
            <stop offset="16%" stopColor="#ffffff" stopOpacity="0.15" />
            <stop offset="45%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>

          {/* track tiles */}
          <linearGradient id="tileFace" x1="0" y1="0" x2="0.5" y2="1">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="55%" stopColor="#f3f6fc" />
            <stop offset="100%" stopColor="#e3e9f4" />
          </linearGradient>
          <linearGradient id="tileEdge" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="50%" stopColor="#c3ccdd" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#8391af" stopOpacity="0.8" />
          </linearGradient>

          {/* home / quadrant domes (deep-anchored candy) */}
          <radialGradient id="domeRed" cx="38%" cy="30%" r="90%">
            <stop offset="0%" stopColor="#FF7A6E" /><stop offset="55%" stopColor="#E5484D" /><stop offset="100%" stopColor="#9E2529" />
          </radialGradient>
          <radialGradient id="domeGreen" cx="38%" cy="30%" r="90%">
            <stop offset="0%" stopColor="#6AD873" /><stop offset="55%" stopColor="#46A758" /><stop offset="100%" stopColor="#256F35" />
          </radialGradient>
          <radialGradient id="domeBlue" cx="38%" cy="30%" r="90%">
            <stop offset="0%" stopColor="#6C9BFF" /><stop offset="55%" stopColor="#3E63DD" /><stop offset="100%" stopColor="#23408F" />
          </radialGradient>
          <radialGradient id="domeYellow" cx="38%" cy="30%" r="90%">
            <stop offset="0%" stopColor="#FFD75A" /><stop offset="55%" stopColor="#F4B400" /><stop offset="100%" stopColor="#A9760A" />
          </radialGradient>

          {/* seat lanes (home columns + start cells) */}
          <linearGradient id="laneBlue" x1="0" y1="0" x2="0.2" y2="1">
            <stop offset="0%" stopColor="#6C9BFF" /><stop offset="50%" stopColor="#3E63DD" /><stop offset="100%" stopColor="#23408F" />
          </linearGradient>
          <linearGradient id="laneGreen" x1="0" y1="0" x2="0.2" y2="1">
            <stop offset="0%" stopColor="#6AD873" /><stop offset="50%" stopColor="#46A758" /><stop offset="100%" stopColor="#256F35" />
          </linearGradient>

          {/* centre pinwheel blades (diagonal, deep-anchored) */}
          <linearGradient id="bladeRed" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#FF7A6E" /><stop offset="100%" stopColor="#9E2529" /></linearGradient>
          <linearGradient id="bladeGreen" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#6AD873" /><stop offset="100%" stopColor="#256F35" /></linearGradient>
          <linearGradient id="bladeYellow" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#FFD75A" /><stop offset="100%" stopColor="#A9760A" /></linearGradient>
          <linearGradient id="bladeBlue" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#6C9BFF" /><stop offset="100%" stopColor="#23408F" /></linearGradient>

          {/* gold jewel + star */}
          <radialGradient id="goldDome" cx="38%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#fff2c0" /><stop offset="42%" stopColor="#ffd34e" /><stop offset="82%" stopColor="#e79a00" /><stop offset="100%" stopColor="#b06d00" />
          </radialGradient>
          <linearGradient id="starGold" x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0%" stopColor="#ffe9a0" /><stop offset="50%" stopColor="#f5b301" /><stop offset="100%" stopColor="#c8860a" />
          </linearGradient>

          {/* safe cell: gold pad + glow */}
          <radialGradient id="safePad" cx="50%" cy="42%" r="66%">
            <stop offset="0%" stopColor="#fff7e0" /><stop offset="100%" stopColor="#f0e1b8" />
          </radialGradient>

          {/* dished socket (resting slots) */}
          <radialGradient id="socket" cx="50%" cy="38%" r="66%">
            <stop offset="0%" stopColor="#c3ccdd" /><stop offset="60%" stopColor="#d8deea" /><stop offset="100%" stopColor="#eef2f9" />
          </radialGradient>

          {/* pawn contact shadow (gradient falloff = cheap fake blur) */}
          <radialGradient id="pawnCast" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#121c3a" stopOpacity="0.45" /><stop offset="55%" stopColor="#121c3a" stopOpacity="0.24" /><stop offset="100%" stopColor="#121c3a" stopOpacity="0" />
          </radialGradient>

          {/* pawn bodies (userSpaceOnUse → every pawn lit identically) */}
          <radialGradient id="pawnMeBody" gradientUnits="userSpaceOnUse" cx="-0.09" cy="-0.32" r="0.66" fx="-0.13" fy="-0.37">
            <stop offset="0%" stopColor="#eef3ff" /><stop offset="16%" stopColor="#a9c2ff" /><stop offset="44%" stopColor="#3E63DD" /><stop offset="80%" stopColor="#2947A8" /><stop offset="100%" stopColor="#182f63" />
          </radialGradient>
          <radialGradient id="pawnOppBody" gradientUnits="userSpaceOnUse" cx="-0.09" cy="-0.32" r="0.66" fx="-0.13" fy="-0.37">
            <stop offset="0%" stopColor="#eafbe8" /><stop offset="16%" stopColor="#9fe39a" /><stop offset="44%" stopColor="#46A758" /><stop offset="80%" stopColor="#2E7A3C" /><stop offset="100%" stopColor="#17512a" />
          </radialGradient>
        </defs>

        {/* raised bevelled frame with gold trim + corner rivets */}
        <rect x={-0.85} y={-0.85} width={16.7} height={16.7} rx={1.5} fill="url(#frameG)" filter="url(#fFrame)" />
        <rect x={-0.85} y={-0.85} width={16.7} height={16.7} rx={1.5} fill="url(#frameSheen)" pointerEvents="none" />
        <rect x={-0.42} y={-0.42} width={15.84} height={15.84} rx={1.08} fill="none" stroke="url(#goldTrim)" strokeWidth={0.13} />
        <rect x={-0.24} y={-0.24} width={15.48} height={15.48} rx={0.95} fill="none" stroke="#1a2660" strokeWidth={0.05} opacity={0.35} />
        {([
          [-0.5, -0.5],
          [15.5, -0.5],
          [-0.5, 15.5],
          [15.5, 15.5],
        ] as const).map(([cx, cy], i) => (
          <g key={`rv${i}`}>
            <circle cx={cx} cy={cy} r={0.2} fill="#b8790a" opacity={0.5} />
            <circle cx={cx} cy={cy} r={0.16} fill="url(#rivet)" />
            <circle cx={cx - 0.045} cy={cy - 0.045} r={0.045} fill="#ffffff" opacity={0.8} />
          </g>
        ))}
        {/* recessed play well */}
        <rect x={-0.1} y={-0.1} width={15.2} height={15.2} rx={0.85} fill="url(#wellG)" filter="url(#fInset)" />

        {/* quadrants: red / green / blue / yellow (classic) */}
        <Quadrant x={0} y={0} yardGrad="url(#domeRed)" dark={RED[2]} active={false} />
        <Quadrant x={9} y={0} yardGrad="url(#domeGreen)" dark={GREEN[2]} active={true} />
        <Quadrant x={0} y={9} yardGrad="url(#domeBlue)" dark={BLUE[2]} active={true} />
        <Quadrant x={9} y={9} yardGrad="url(#domeYellow)" dark={YELLOW[2]} active={false} />

        {/* recessed cross channel that holds the track */}
        <g filter="url(#fInset)">
          <rect x={5.94} y={-0.02} width={3.12} height={15.04} rx={0.5} fill="#dfe6f2" />
          <rect x={-0.02} y={5.94} width={15.04} height={3.12} rx={0.5} fill="#dfe6f2" />
        </g>

        {/* resting slots for the two live seats */}
        {BASE_SPOTS.map((spots, seat) =>
          spots.map(([sx, sy], i) => (
            <g key={`bs${seat}-${i}`}>
              <circle cx={sx} cy={sy} r={0.5} fill="url(#socket)" />
              <circle cx={sx} cy={sy} r={0.5} fill="none" stroke={SEAT_COLOR[seat]![1]} strokeWidth={0.07} opacity={0.85} />
            </g>
          )),
        )}

        {/* track: pillowy candy tiles lifted off the channel by ONE shared shadow */}
        <g filter="url(#fTile)">
          {TRACK.map(([x, y], i) => (
            <g key={i}>
              <rect
                x={x + 0.05}
                y={y + 0.05}
                width={0.9}
                height={0.9}
                rx={0.18}
                fill="url(#tileFace)"
                stroke="url(#tileEdge)"
                strokeWidth={0.05}
              />
              <rect x={x + 0.14} y={y + 0.11} width={0.72} height={0.24} rx={0.11} fill="#ffffff" opacity={0.7} />
            </g>
          ))}
        </g>

        {/* safe cells: raised gold pad + glow + embossed star */}
        {[...SAFE_CELLS].map((i) => {
          const cell = TRACK[i];
          if (!cell) return null;
          const cx = cell[0] + 0.5;
          const cy = cell[1] + 0.5;
          return (
            <g key={`s${i}`} filter="url(#fStar)">
              <rect x={cell[0] + 0.08} y={cell[1] + 0.08} width={0.84} height={0.84} rx={0.16} fill="url(#safePad)" stroke="#e6c877" strokeWidth={0.04} />
              <polygon points={starPoints(cx, cy + 0.035, 0.3)} fill="#ffffff" opacity={0.85} strokeLinejoin="round" />
              <polygon points={starPoints(cx, cy, 0.3)} fill="url(#starGold)" stroke="#c8860a" strokeWidth={0.025} strokeLinejoin="round" />
            </g>
          );
        })}

        {/* home columns: candy lane with shared gloss + bevel */}
        {HOME_COLUMNS.map((col, seat) => {
          const g = seat === 0 ? 'url(#laneBlue)' : 'url(#laneGreen)';
          return col.map(([x, y], i) => (
            <g key={`h${seat}-${i}`}>
              <rect
                x={x + 0.04}
                y={y + 0.04}
                width={0.92}
                height={0.92}
                rx={0.16}
                fill={g}
                stroke={SEAT_COLOR[seat]![2]}
                strokeWidth={0.04}
              />
              <rect x={x + 0.06} y={y + 0.05} width={0.88} height={0.9} rx={0.14} fill="url(#sheenV)" />
              <rect x={x + 0.1} y={y + 0.76} width={0.8} height={0.15} rx={0.07} fill={SEAT_COLOR[seat]![2]} opacity={0.5} />
            </g>
          ));
        })}

        {/* start cells: candy tile + embossed chevron */}
        {SEAT_START.map((idx, seat) => {
          const cell = TRACK[idx];
          if (!cell) return null;
          const g = seat === 0 ? 'url(#laneBlue)' : 'url(#laneGreen)';
          return (
            <g key={`d${seat}`}>
              <rect
                x={cell[0] + 0.04}
                y={cell[1] + 0.04}
                width={0.92}
                height={0.92}
                rx={0.16}
                fill={g}
                stroke={SEAT_COLOR[seat as Seat]![2]}
                strokeWidth={0.04}
              />
              <rect x={cell[0] + 0.06} y={cell[1] + 0.05} width={0.88} height={0.9} rx={0.14} fill="url(#sheenV)" />
              <rect x={cell[0] + 0.1} y={cell[1] + 0.76} width={0.8} height={0.15} rx={0.07} fill={SEAT_COLOR[seat as Seat]![2]} opacity={0.5} />
            </g>
          );
        })}
        {([0, 1] as const).map((seat) => startChevron(seat))}

        {/* centre: faceted pinwheel + elevated gold jewel */}
        <polygon points="6,6 9,6 7.5,7.5" fill="url(#bladeRed)" />
        <polygon points="9,6 9,9 7.5,7.5" fill="url(#bladeGreen)" />
        <polygon points="6,9 9,9 7.5,7.5" fill="url(#bladeYellow)" />
        <polygon points="6,6 6,9 7.5,7.5" fill="url(#bladeBlue)" />
        <rect x={6} y={6} width={3} height={3} fill="url(#boardSheen)" pointerEvents="none" />
        <path
          d="M7.5 7.5 L6 6 M7.5 7.5 L9 6 M7.5 7.5 L9 9 M7.5 7.5 L6 9 M6 6 H9 V9 H6 Z"
          fill="none"
          stroke="#ffffff"
          strokeWidth={0.05}
          strokeOpacity={0.85}
          strokeLinejoin="round"
        />
        <g filter="url(#fLift)">
          <circle cx={7.5} cy={7.5} r={0.84} fill="url(#goldDome)" stroke="#b06d00" strokeWidth={0.05} />
        </g>
        <ellipse cx={7.32} cy={7.22} rx={0.34} ry={0.22} fill="#ffffff" opacity={0.42} />
        <circle cx={7.5} cy={7.5} r={0.56} fill="#fffdf5" />
        <polygon points={starPoints(7.5, 7.52, 0.42)} fill="url(#starGold)" stroke="#c8860a" strokeWidth={0.03} strokeLinejoin="round" />

        {/* board-wide glass: vignette then top-left sheen (below tokens) */}
        <rect x={-0.1} y={-0.1} width={15.2} height={15.2} rx={0.85} fill="url(#vignette)" pointerEvents="none" />
        <rect x={-0.1} y={-0.1} width={15.2} height={15.2} rx={0.85} fill="url(#boardSheen)" pointerEvents="none" />

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
