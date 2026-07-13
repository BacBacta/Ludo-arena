export type Seat = 0 | 1;

export type Phase = 'awaiting-roll' | 'awaiting-move' | 'over';

export interface GameState {
  /** positions[seat][token] — see constants.ts for the encoding. */
  positions: number[][];
  turn: Seat;
  /** Current die (set by applyRoll, consumed by applyMove). */
  dice: number | null;
  /** Playable tokens with the current die (empty outside awaiting-move). */
  legal: number[];
  rollCount: number;
  /** Consecutive 6s rolled by the current player (Ludo Club: 3 → turn forfeited). */
  sixStreak: number;
  phase: Phase;
  winner: Seat | null;
}

export interface MoveEvents {
  capture: boolean;
  finished: boolean;
  extraTurn: boolean;
  won: boolean;
}

export interface MoveResult {
  state: GameState;
  events: MoveEvents;
}
