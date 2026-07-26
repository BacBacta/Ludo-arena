/**
 * Pawn-home celebration ladder (A3) — pure, so the tier rules are unit-tested.
 *
 * The FIRST pawn a player brings home is a milestone: it gets the premium
 * arrival sound. The 2nd and 3rd get a shorter progress cue (still rewarding,
 * never spammy). The 4th IS the victory — playWin() already owns that moment,
 * so the ladder stays silent there rather than stacking two celebrations.
 * A move that brings no new pawn home (including a capture, which DECREASES
 * a count by sending a token back to base) plays nothing.
 *
 * Sound-design grounding (2025/26 mobile best practices): reward cues must
 * escalate with the size of the accomplishment (micro → macro), keep a clear
 * hierarchy so the big moment stays big, and stay short with fast envelopes.
 * The ladder encodes exactly that: one premium stinger per game (first pawn),
 * brief variants for progress, and the existing win fanfare untouched.
 */
import { FINISHED } from '@ludo/game-engine';

/** How many of a seat's tokens are home. Null-safe: an unknown row is 0. */
export function countFinished(row: readonly number[] | undefined | null): number {
  if (!row) return 0;
  return row.reduce((n, p) => (p === FINISHED ? n + 1 : n), 0);
}

export type HomeTier = 'first' | 'progress' | 'final' | 'none';

/** The celebration tier for a move that took a seat from `before` to `after`
 *  pawns home. Monotonicity guard: anything but a strict increase is 'none'
 *  (captures reduce counts; state resyncs can repeat identical counts). */
export function homeTier(before: number, after: number): HomeTier {
  if (after <= before) return 'none';
  if (after >= 4) return 'final'; // the win — playWin() owns it
  if (before === 0) return 'first';
  return 'progress';
}
