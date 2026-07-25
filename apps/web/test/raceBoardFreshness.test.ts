import { describe, expect, it } from 'vitest';
import { RACE_BOARD_TTL_MS, boardIsStale } from '../src/lib/pacing';

// THE BUG. The lobby podium preview fetched the leaderboard ONCE per app mount
// (a useRef(false) latch, plus a guard on the already-stored board). Whatever
// standings a player saw when they opened the app, they kept for the whole
// session: finish a scoring game, walk back to the lobby, and the card still
// showed the old podium. Only opening the full sheet ever refreshed it — so the
// leaderboard "looked frozen" even when the server had moved on.

describe('lobby podium freshness', () => {
  it('the FIRST read always runs (never fetched = lastAt 0)', () => {
    expect(boardIsStale(1_000_000, 0)).toBe(true);
  });

  it('re-entering the lobby after a game refreshes — a game is far past the TTL', () => {
    const openedAt = 1_000_000;
    const afterAGame = openedAt + 4 * 60_000; // a Blitz game plus the end screen
    expect(boardIsStale(afterAGame, openedAt)).toBe(true);
  });

  it('a re-render storm inside the window does NOT hammer the endpoint', () => {
    const at = 1_000_000;
    expect(boardIsStale(at, at)).toBe(false);
    expect(boardIsStale(at + 1, at)).toBe(false);
    expect(boardIsStale(at + RACE_BOARD_TTL_MS - 1, at)).toBe(false);
  });

  it('exactly at the TTL it is stale — no off-by-one that pins a stuck podium', () => {
    const at = 1_000_000;
    expect(boardIsStale(at + RACE_BOARD_TTL_MS, at)).toBe(true);
  });

  it('the TTL is short enough to read as "live" and long enough to not spam', () => {
    expect(RACE_BOARD_TTL_MS).toBeGreaterThanOrEqual(5_000);
    expect(RACE_BOARD_TTL_MS).toBeLessThanOrEqual(60_000);
  });

  it('the old once-per-session behaviour would fail this suite', () => {
    // What the latch did: after the first fetch, never again.
    const onceOnly = (fetched: boolean): boolean => !fetched;
    expect(onceOnly(false)).toBe(true); // first read: same as ours
    expect(onceOnly(true)).toBe(false); // ...and then frozen forever
    // Ours recovers on the very next lobby entry past the TTL.
    expect(boardIsStale(1_000_000 + 4 * 60_000, 1_000_000)).toBe(true);
  });
});
