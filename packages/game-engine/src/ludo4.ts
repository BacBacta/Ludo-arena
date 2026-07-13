/**
 * Self-contained 4-player Ludo rules (client practice + server 4-player games).
 * Kept separate from the 2-player engine.ts (which drives staked 1v1 + on-chain
 * settlement) so 4-player never destabilises the production economy.
 * Pure + deterministic: dice are injected by the caller (server: commit-reveal).
 *
 * Geometry reuses the shared TRACK/constants; the four seats sit on the four
 * arms (starts 0/13/26/39) with their base quadrant, home column and colour:
 *   seat 0 blue  (bottom-left)   seat 1 red   (top-left)
 *   seat 2 green (top-right)     seat 3 yellow (bottom-right)
 */
import { FINISHED, LAST_TRACK_REL, SAFE_CELLS, TRACK, TRACK_LEN } from './constants.js';

export const SEATS4 = 4;
export const TOKENS4 = 4;

/**
 * Absolute start cell per seat, chosen so each seat's coloured start cell is
 * ADJACENT to its base quadrant (blue bottom-left exits at the bottom, etc.):
 *   seat 0 blue → 39 (bottom)   seat 1 red → 0 (left/top-left)
 *   seat 2 green → 13 (top)      seat 3 yellow → 26 (right)
 */
export const SEAT_START4: readonly number[] = [39, 0, 13, 26];

/** Home columns per seat (grid coords, entrance → centre) matching the starts. */
export const HOME_COLUMNS4: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]], // blue, bottom arm
  [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]], // red, left arm
  [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]], // green, top arm
  [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]], // yellow, right arm
];

/** Four base slots per quadrant (grid centres), matching the board home squares. */
export const BASE_SPOTS4: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[2.2, 10.65], [3.8, 10.65], [2.2, 12.25], [3.8, 12.25]], // blue bottom-left
  [[2.2, 2.75], [3.8, 2.75], [2.2, 4.35], [3.8, 4.35]], // red top-left
  [[11.2, 2.75], [12.8, 2.75], [11.2, 4.35], [12.8, 4.35]], // green top-right
  [[11.2, 10.65], [12.8, 10.65], [11.2, 12.25], [12.8, 12.25]], // yellow bottom-right
];

export interface Game4 {
  positions: number[][]; // [seat][token], same encoding as the 2p engine
  turn: number;
  dice: number | null;
  legal: number[];
  /** Consecutive 6s by the current player (Ludo Club: 3 → turn forfeited). */
  sixStreak: number;
  phase: 'awaiting-roll' | 'awaiting-move' | 'over';
  /** Seats that have finished all tokens, in arrival order (out of the rotation). */
  done: number[];
  winner: number | null;
}

export interface Move4Events {
  capture: boolean;
  finished: boolean;
  extraTurn: boolean;
  won: boolean;
}

/** Every seat starts with all four tokens in its base (like real Ludo Club). */
export function newGame4(): Game4 {
  return {
    positions: Array.from({ length: SEATS4 }, () => [-1, -1, -1, -1]),
    turn: 0,
    dice: null,
    legal: [],
    sixStreak: 0,
    phase: 'awaiting-roll',
    done: [],
    winner: null,
  };
}

function seatFinished(row: number[] | undefined): boolean {
  return !!row && row.every((p) => p === FINISHED);
}

/** Next seat still in play after `seat` (skips finished players). */
export function nextSeat4(g: Game4, seat: number): number {
  for (let i = 1; i <= SEATS4; i++) {
    const s = (seat + i) % SEATS4;
    if (!seatFinished(g.positions[s])) return s;
  }
  return seat;
}

/** Absolute track cell (0..51) for a seat's relative position, or null. */
function absCell4(seat: number, rel: number): number | null {
  if (rel < 0 || rel > LAST_TRACK_REL) return null;
  const start = SEAT_START4[seat] ?? 0;
  return (start + rel) % TRACK_LEN;
}

export function legalMoves4(g: Game4, seat: number, die: number): number[] {
  const out: number[] = [];
  const row = g.positions[seat];
  if (!row) return out;
  row.forEach((pos, ti) => {
    if (pos === FINISHED) return;
    if (pos === -1) {
      if (die === 6) out.push(ti); // Ludo Club: need a 6 to leave base
      return;
    }
    // Ludo Club: exact count to the centre — no overshoot.
    if (pos + die <= FINISHED) out.push(ti);
  });
  return out;
}

export function applyRoll4(g: Game4, die: number): Game4 {
  if (g.phase !== 'awaiting-roll') throw new Error('BAD_STATE');
  const streak = die === 6 ? (g.sixStreak ?? 0) + 1 : 0;
  const next: Game4 = {
    ...g,
    positions: g.positions.map((r) => [...r]),
    dice: die,
    legal: [],
    sixStreak: streak,
  };
  // Ludo Club: three 6s in a row burn the turn — no move, pass on.
  if (streak >= 3) {
    next.turn = nextSeat4(g, g.turn);
    next.dice = null;
    next.sixStreak = 0;
    next.phase = 'awaiting-roll';
    return next;
  }
  const legal = legalMoves4(g, g.turn, die);
  next.legal = legal;
  if (legal.length === 0) {
    next.turn = nextSeat4(g, g.turn);
    next.dice = null;
    next.sixStreak = 0; // turn passes → next seat's 6-streak starts fresh
    next.phase = 'awaiting-roll';
  } else {
    next.phase = 'awaiting-move';
  }
  return next;
}

export function applyMove4(g: Game4, token: number): { state: Game4; events: Move4Events } {
  if (g.phase !== 'awaiting-move' || g.dice === null) throw new Error('BAD_STATE');
  if (!g.legal.includes(token)) throw new Error('ILLEGAL_MOVE');

  const seat = g.turn;
  const die = g.dice;
  const positions = g.positions.map((r) => [...r]);
  const row = positions[seat]!;

  let pos = row[token]!;
  pos = pos === -1 ? 0 : pos + die; // exact — legalMoves4 guarantees pos + die <= FINISHED
  row[token] = pos;

  // Capture on this non-safe track cell. Ludo Club: a LONE opponent token is sent
  // home, but a PAIR of one opponent's tokens is protected (can't be cut). Each
  // opponent seat is judged independently — singles fall, pairs stand.
  let capture = false;
  const cell = absCell4(seat, pos);
  if (cell !== null && !SAFE_CELLS.has(cell)) {
    positions.forEach((oppRow, oppSeat) => {
      if (oppSeat === seat) return;
      const onCell = oppRow.reduce<number[]>((acc, op, oi) => (absCell4(oppSeat, op) === cell ? [...acc, oi] : acc), []);
      if (onCell.length === 1) {
        oppRow[onCell[0]!] = -1;
        capture = true;
      }
    });
  }

  const finished = pos === FINISHED;
  const seatDone = row.every((p) => p === FINISHED);
  const done = seatDone && !g.done.includes(seat) ? [...g.done, seat] : g.done;
  // first player to bring all tokens home wins the practice game
  const won = seatDone && g.winner === null;
  // Ludo Club: a 6, a capture, OR bringing a token home grants another roll.
  const extraTurn = !seatDone && (die === 6 || capture || finished);

  const next: Game4 = {
    positions,
    turn: won || extraTurn ? seat : nextSeat4({ ...g, positions, done }, seat),
    dice: null,
    legal: [],
    // keep the 6-streak while the same seat keeps rolling; reset when the turn passes
    sixStreak: won || !extraTurn ? 0 : (g.sixStreak ?? 0),
    phase: won ? 'over' : 'awaiting-roll',
    done,
    winner: won ? seat : g.winner,
  };
  return { state: next, events: { capture, finished, extraTurn, won } };
}

/** Bot heuristic: finish > capture > exit base > advance most. */
export function pickAutoMove4(g: Game4, seat: number, die: number): number | null {
  const legal = legalMoves4(g, seat, die);
  const first = legal[0];
  if (first === undefined) return null;
  const row = g.positions[seat];
  if (!row) return first;

  const canFinish = legal.find((ti) => (row[ti] ?? -1) >= 0 && (row[ti] ?? 0) + die === FINISHED);
  if (canFinish !== undefined) return canFinish;

  const canCapture = legal.find((ti) => {
    const p = row[ti] ?? -1;
    if (p < 0) return false;
    const cell = absCell4(seat, p + die);
    if (cell === null || SAFE_CELLS.has(cell)) return false;
    // a lone opponent token is capturable; a protected pair is not
    return g.positions.some((oppRow, os) => os !== seat && oppRow.filter((op) => absCell4(os, op) === cell).length === 1);
  });
  if (canCapture !== undefined) return canCapture;

  if (die === 6) {
    const canExit = legal.find((ti) => row[ti] === -1);
    if (canExit !== undefined) return canExit;
  }

  let best = first;
  let bestPos = -2;
  for (const ti of legal) {
    const p = row[ti] ?? -2;
    if (p > bestPos) {
      bestPos = p;
      best = ti;
    }
  }
  return best;
}

/** Grid XY for a seat's token (base slot / track / home column / centre). */
export function tokenXY4(seat: number, token: number, rel: number): [number, number] {
  if (rel === -1) {
    const s = BASE_SPOTS4[seat]?.[token] ?? [7.5, 7.5];
    return [s[0], s[1]];
  }
  if (rel === FINISHED) {
    const off: Array<[number, number]> = [
      [-0.3, 0.3],
      [-0.3, -0.3],
      [0.3, -0.3],
      [0.3, 0.3],
    ];
    const o = off[seat] ?? [0, 0];
    return [7.5 + o[0], 7.5 + o[1]];
  }
  if (rel <= LAST_TRACK_REL) {
    const cell = TRACK[((SEAT_START4[seat] ?? 0) + rel) % TRACK_LEN] ?? [7, 7];
    return [cell[0] + 0.5, cell[1] + 0.5];
  }
  const home = HOME_COLUMNS4[seat]?.[rel - (LAST_TRACK_REL + 1)] ?? [7, 7];
  return [home[0] + 0.5, home[1] + 0.5];
}
