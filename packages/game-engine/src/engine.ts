/**
 * Ludo Blitz rules engine — PURE and DETERMINISTIC.
 * No Math.random, no I/O: dice are always injected by the caller
 * (server: commit-reveal; client bot: local RNG).
 */
import {
  BLITZ,
  FINISHED,
  LAST_TRACK_REL,
  SAFE_CELLS,
  SEAT_START,
  TRACK_LEN,
} from './constants.js';
import type { GameState, MoveResult, Seat } from './types.js';

export function newGame(): GameState {
  const start = BLITZ.firstTokenStartsOnBoard ? 0 : -1;
  return {
    positions: [
      [start, -1],
      [start, -1],
    ],
    turn: 0,
    dice: null,
    legal: [],
    rollCount: 0,
    phase: 'awaiting-roll',
    winner: null,
  };
}

export function otherSeat(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

/** Absolute cell (0..51) occupied by a token on the track, or null (base/home/finished). */
export function absCell(seat: Seat, rel: number): number | null {
  if (rel < 0 || rel > LAST_TRACK_REL) return null;
  const startIdx = SEAT_START[seat];
  if (startIdx === undefined) throw new Error(`invalid seat: ${seat}`);
  return (startIdx + rel) % TRACK_LEN;
}

/** Playable tokens for `seat` with die `die`. */
export function legalMoves(state: GameState, seat: Seat, die: number): number[] {
  const out: number[] = [];
  const tokens = state.positions[seat];
  if (!tokens) return out;
  tokens.forEach((pos, ti) => {
    if (pos === FINISHED) return;
    if (pos === -1) {
      if (die === 6) out.push(ti);
      return;
    }
    // Overshoot allowed (BLITZ.allowOvershootFinish): always playable.
    out.push(ti);
  });
  return out;
}

/**
 * Applies a die roll. If no move is possible, the turn passes.
 * Returns the new state (phase awaiting-move if a choice exists).
 */
export function applyRoll(state: GameState, die: number): GameState {
  if (state.phase !== 'awaiting-roll') throw new Error('BAD_STATE: not in roll phase');
  if (die < 1 || die > 6 || !Number.isInteger(die)) throw new Error(`invalid die: ${die}`);
  const legal = legalMoves(state, state.turn, die);
  const next: GameState = {
    ...state,
    positions: state.positions.map((row) => [...row]),
    dice: die,
    legal,
    rollCount: state.rollCount + 1,
  };
  if (legal.length === 0) {
    next.turn = otherSeat(state.turn);
    next.dice = null;
    next.legal = [];
    next.phase = 'awaiting-roll';
  } else {
    next.phase = 'awaiting-move';
  }
  return next;
}

/** Plays token `token` with the current die. */
export function applyMove(state: GameState, token: number): MoveResult {
  if (state.phase !== 'awaiting-move' || state.dice === null)
    throw new Error('BAD_STATE: not in move phase');
  if (!state.legal.includes(token)) throw new Error(`ILLEGAL_MOVE: token ${token}`);

  const seat = state.turn;
  const die = state.dice;
  const positions = state.positions.map((row) => [...row]);
  const seatRow = positions[seat];
  if (!seatRow) throw new Error('BAD_STATE: corrupted positions');

  let pos = seatRow[token];
  if (pos === undefined) throw new Error(`invalid token: ${token}`);

  if (pos === -1) {
    pos = 0; // leaves base onto the start cell
  } else {
    pos = pos + die;
    if (pos >= FINISHED) pos = FINISHED;
  }
  seatRow[token] = pos;

  // Capture (only on the track, outside safe cells)
  let capture = false;
  const cell = absCell(seat, pos);
  if (cell !== null && !SAFE_CELLS.has(cell)) {
    const opp = otherSeat(seat);
    const oppRow = positions[opp];
    if (oppRow) {
      oppRow.forEach((oppPos, oi) => {
        if (absCell(opp, oppPos) === cell) {
          oppRow[oi] = -1;
          capture = true;
        }
      });
    }
  }

  const finished = pos === FINISHED;
  const won = seatRow.every((p) => p === FINISHED);
  const extraTurn = !won && (die === 6 || capture);

  const next: GameState = {
    positions,
    turn: won || extraTurn ? seat : otherSeat(seat),
    dice: null,
    legal: [],
    rollCount: state.rollCount,
    phase: won ? 'over' : 'awaiting-roll',
    winner: won ? seat : null,
  };

  return { state: next, events: { capture, finished, extraTurn, won } };
}

/** Automatic move (clock expired): prefers finish > capture > exit > most advanced token. */
export function pickAutoMove(state: GameState, seat: Seat, die: number): number | null {
  const legal = legalMoves(state, seat, die);
  const first = legal[0];
  if (first === undefined) return null;
  const row = state.positions[seat];
  if (!row) return first;

  const canFinish = legal.find((ti) => (row[ti] ?? -1) >= 0 && (row[ti] ?? 0) + die >= FINISHED);
  if (canFinish !== undefined) return canFinish;

  const opp = otherSeat(seat);
  const oppRow = state.positions[opp] ?? [];
  const canCapture = legal.find((ti) => {
    const p = row[ti] ?? -1;
    if (p < 0) return false;
    const np = p + die;
    const cell = absCell(seat, np);
    if (cell === null || SAFE_CELLS.has(cell)) return false;
    return oppRow.some((op) => absCell(opp, op) === cell);
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
