export type Seat = 0 | 1;

export type Phase = 'awaiting-roll' | 'awaiting-move' | 'over';

export interface GameState {
  /** positions[seat][token] — voir constants.ts pour l'encodage. */
  positions: number[][];
  turn: Seat;
  /** Dé courant (posé par applyRoll, consommé par applyMove). */
  dice: number | null;
  /** Pions jouables avec le dé courant (vide hors phase awaiting-move). */
  legal: number[];
  rollCount: number;
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
