/**
 * Board geometry — SINGLE source of truth (the frontend SVG is generated from this file).
 * 15x15 grid. 52-cell main track, clockwise.
 */
export const TRACK: ReadonlyArray<readonly [number, number]> = [
  [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
  [6, 5], [6, 4], [6, 3], [6, 2], [6, 1], [6, 0],
  [7, 0],
  [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
  [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6],
  [14, 7],
  [14, 8], [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
  [8, 9], [8, 10], [8, 11], [8, 12], [8, 13], [8, 14],
  [7, 14],
  [6, 14], [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
  [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  [0, 7], [0, 6],
];

export const TRACK_LEN = 52;

/** Absolute indices of safe cells (stars + start cells). No captures possible there. */
export const SAFE_CELLS: ReadonlySet<number> = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

/**
 * Relative token positions:
 *  -1            : in base
 *  0..50         : on the track (51 traversed cells, relative to the seat's start)
 *  51..55        : home column (5 cells)
 *  56 (FINISHED) : arrived at the center
 */
export const LAST_TRACK_REL = 50;
export const FIRST_HOME_REL = 51;
export const FINISHED = 56;

/** Absolute start cell per seat (Blitz 1v1: diagonally opposite seats). */
export const SEAT_START: readonly number[] = [0, 26];

/** Home columns per seat (grid coordinates, from entrance toward the center). */
export const HOME_COLUMNS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
];

/** Base token spots (grid coordinates, centers). */
export const BASE_SPOTS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[2.5, 11.5], [4.5, 11.5]],
  [[10.5, 2.5], [12.5, 2.5]],
];

/** Default Blitz config. */
export const BLITZ = {
  tokensPerPlayer: 2,
  /** Token 0 starts already placed on the start cell (speeds the game up). */
  firstTokenStartsOnBoard: true,
  /** Overshoot allowed to finish (no exact roll required). */
  allowOvershootFinish: true,
  /** ms per decision before auto-move. */
  moveClockMs: 15_000,
  /** consecutive auto-moves before forfeit. */
  forfeitAfterAutoMoves: 3,
} as const;
