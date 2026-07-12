/**
 * Central pacing constants — the board animation and the local bot session
 * share these so token walks, turn hand-offs and bot "thinking" stay in sync
 * and feel deliberate (not rushed). Tuned for readability over speed.
 */

/** Per-cell pawn walk (setTimeout between hops in the board animation). */
export const WALK_STEP_MS = 430;
/** CSS transform tween for a single hop — a touch under WALK_STEP_MS so each hop lands before the next starts. */
export const WALK_TWEEN_MS = 380;
/** Deliberate pause after a move finishes walking before the turn actually passes. */
export const TURN_BEAT_MS = 750;
/** Bot "thinking" before it rolls (after the turn reaches it). */
export const BOT_ROLL_MS = 1000;
/** Bot "thinking" before it commits its move (after its roll settles). */
export const BOT_MOVE_MS = 850;
/** Pause before an only-legal move auto-plays, so the roll is read first. */
export const FORCED_MOVE_MS = 780;
