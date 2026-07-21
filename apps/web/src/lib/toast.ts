/**
 * How long a toast stays on screen, scaled to its length so a message can
 * actually be READ before it clears. A flat 2.4s vanished long diagnostics
 * (e.g. "Stake not locked — match cancelled — <viem cause>") before the eye
 * reached the end. Roughly: a reading floor plus ~65ms/char (~15 chars/s, a
 * slow-but-safe read rate), capped so a toast never sticks for minutes.
 */
const MIN_MS = 2400; // snappy floor for short confirmations (the old flat value)
const PER_CHAR_MS = 65;
const MAX_MS = 12000;

export function toastDurationMs(message: string): number {
  const scaled = MIN_MS + message.length * PER_CHAR_MS;
  return Math.min(MAX_MS, Math.max(MIN_MS, scaled));
}
