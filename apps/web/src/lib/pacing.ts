/**
 * Central pacing constants — the board animation and the local bot session
 * share these so token walks, turn hand-offs and bot "thinking" stay in sync
 * and feel deliberate (not rushed). Tuned for readability over speed.
 */

/** Per-cell pawn walk (setTimeout between hops in the board animation). */
export const WALK_STEP_MS = 300;
/** CSS transform tween for a single hop — a touch under WALK_STEP_MS so each hop lands before the next starts. */
export const WALK_TWEEN_MS = 250;
/** Deliberate pause after a move finishes walking before the turn actually passes. */
export const TURN_BEAT_MS = 480;
/** Bot "thinking" before it rolls (after the turn reaches it). Trimmed to offset
 *  the longer post-roll DIE_SETTLE hold, so the game stays snappy overall. */
export const BOT_ROLL_MS = 420;
/** Time the rolled die stays visible before a move/turn passes. MUST exceed the
 *  die's ~0.7s tumble so the RESULT is read as settled, not cut off mid-spin. */
export const DIE_SETTLE_MS = 1000;
/** The Die3D somersault (matches its CSS transition). */
export const DIE_TUMBLE_MS = 700;
/** How long a die stays on screen after its roll, even once the turn has moved
 *  on. ONLINE play is server-paced: the roll, the auto-move and the turn change
 *  arrive in one burst, so a die shown only on its owner's turn is pulled the
 *  instant it starts spinning (measured: the opponent's was visible for 0-32ms).
 *  Tumble + a settled beat, so the number is actually readable. */
export const DIE_HOLD_MS = DIE_TUMBLE_MS + DIE_SETTLE_MS;
/** Bot "thinking" before it commits its move (after its roll settles). */
export const BOT_MOVE_MS = DIE_SETTLE_MS;
/** Pause before an only-legal move auto-plays, so the roll is read first. */
export const FORCED_MOVE_MS = DIE_SETTLE_MS;
