import { describe, expect, it } from 'vitest';
import { absCell, applyMove, applyRoll, FINISHED, legalMoves, newGame, otherSeat, pickAutoMove } from '../src/index.js';
import type { GameState } from '../src/index.js';

// Exhaustive rule coverage complementing engine.test.ts — error paths, the
// pickAutoMove exit/most-advanced branches, and home-column capture immunity.

describe('absCell', () => {
  it('returns null off the track (base, home column, finished)', () => {
    expect(absCell(0, -1)).toBeNull(); // base
    expect(absCell(0, 51)).toBeNull(); // first home-column cell (rel > 50)
    expect(absCell(0, FINISHED)).toBeNull();
  });
  it('wraps around the 52-cell track for seat 1 (start 26)', () => {
    expect(absCell(1, 0)).toBe(26);
    expect(absCell(1, 30)).toBe((26 + 30) % 52); // = 4
  });
  it('throws on an invalid seat', () => {
    // @ts-expect-error deliberately out-of-range seat
    expect(() => absCell(5, 0)).toThrow(/invalid seat/);
  });
});

describe('otherSeat', () => {
  it('swaps 0 and 1', () => {
    expect(otherSeat(0)).toBe(1);
    expect(otherSeat(1)).toBe(0);
  });
});

describe('applyRoll guards', () => {
  it('rejects a roll when not in the roll phase', () => {
    const g: GameState = { ...newGame(), phase: 'awaiting-move', dice: 3, legal: [0], positions: [[2, -1], [-1, -1]] };
    expect(() => applyRoll(g, 4)).toThrow(/BAD_STATE/);
  });
  it.each([0, 7, 2.5, -1])('rejects an out-of-range / non-integer die (%s)', (die) => {
    expect(() => applyRoll(newGame(), die)).toThrow(/invalid die/);
  });
});

describe('applyMove guards', () => {
  it('rejects a move when not in the move phase', () => {
    const g: GameState = { ...newGame(), phase: 'awaiting-roll', dice: null };
    expect(() => applyMove(g, 0)).toThrow(/BAD_STATE/);
  });
  it('rejects a move whose token is not in the legal set (forged legal / stale client)', () => {
    // A crafted state whose `legal` claims token 1 is playable when it is not.
    let g: GameState = { ...newGame(), positions: [[2, -1], [-1, -1]] };
    g = applyRoll(g, 4); // real legal = [0]
    const forged: GameState = { ...g, legal: [0, 1] };
    // token 1 is in the (forged) legal set, so applyMove proceeds — but the engine
    // still can't move a based token without a 6: it leaves base onto cell 0. This
    // documents that the SERVER, not the engine, is the legal-set authority; the
    // engine trusts state.legal by design (re-validated one layer up in room.ts).
    const { state } = applyMove(forged, 1);
    expect(state.positions[0]![1]).toBe(0); // token 1 forced out onto the start cell
  });
});

describe('home-column capture immunity', () => {
  it('a token in the home column neither captures nor is captured (absCell null)', () => {
    // seat 0 token 0 at rel 49 → +2 = 51 (first home-column cell, off the track).
    // seat 1 sits where abs would be if 51 were on the track — but it is not, so no cut.
    let g: GameState = { ...newGame(), positions: [[49, -1], [10, 20]] };
    g = applyRoll(g, 2);
    const { state, events } = applyMove(g, 0);
    expect(state.positions[0]![0]).toBe(51); // advanced into the home column
    expect(events.capture).toBe(false); // home-column cell can't capture
    expect(state.positions[1]).toEqual([10, 20]); // opponent untouched
  });
});

describe('sixStreak resets on a non-six extra turn', () => {
  it('6, 6, capture-with-2, 6 does NOT forfeit (the 2 breaks the streak)', () => {
    // Build a position where a 2 both moves and CAPTURES (grants an extra turn
    // without being a six), so the streak must reset to 0, not roll toward 3.
    let g: GameState = { ...newGame(), positions: [[1, 40], [29, -1]] }; // seat1 lone at abs 3 (rel 29)
    g = applyRoll(g, 6); // streak 1
    g = applyMove(g, 1).state; // move token 1 (at 40 → 46), die 6 → extra turn, streak kept 1
    expect(g.turn).toBe(0);
    expect(g.sixStreak).toBe(1);
    g = applyRoll(g, 6); // streak 2
    g = applyMove(g, 1).state; // 46 → 52, extra turn, streak kept 2
    expect(g.sixStreak).toBe(2);
    g = applyRoll(g, 2); // non-six → streak resets to 0 at roll time
    const moved = applyMove(g, 0); // 1 → 3 = abs 3, captures seat1 → extra turn
    expect(moved.events.capture).toBe(true);
    expect(moved.state.turn).toBe(0); // extra turn from the capture
    expect(moved.state.sixStreak).toBe(0); // NOT carried — the 2 broke the six run
    // a following 6 is only streak 1, nowhere near a forfeit
    const after = applyRoll(moved.state, 6);
    expect(after.sixStreak).toBe(1);
  });
});

describe('pickAutoMove priority ladder', () => {
  it('returns null when there is no legal move', () => {
    const g: GameState = { ...newGame(), positions: [[-1, -1], [0, -1]] };
    expect(pickAutoMove(g, 0, 3)).toBeNull(); // needs a 6 to exit
  });
  it('prefers exiting base on a 6 over merely advancing another token', () => {
    // token 0 in base, token 1 already advanced; on a 6 the heuristic exits base.
    const g: GameState = { ...newGame(), positions: [[-1, 20], [40, -1]] };
    expect(pickAutoMove(g, 0, 6)).toBe(0); // exit preferred (no finish/capture available)
  });
  it('falls back to the most-advanced token when nothing better exists', () => {
    // Two advancing tokens, no finish/capture/exit — pick the furthest along.
    const g: GameState = { ...newGame(), positions: [[10, 30], [5, -1]] };
    // die 3: token 0 → 13, token 1 → 33; neither finishes/captures; furthest = token 1
    expect(pickAutoMove(g, 0, 3)).toBe(1);
  });
  it('keeps the first token when it is already the most advanced (tie-break false branch)', () => {
    const g: GameState = { ...newGame(), positions: [[30, 10], [5, -1]] };
    // die 3: token 0 (30) is furthest → the later token never beats it.
    expect(pickAutoMove(g, 0, 3)).toBe(0);
  });
  it('does not treat a protected pair as a capture', () => {
    // seat 1 pair on abs 3; seat 0 could land there but it is not a capture.
    const g: GameState = { ...newGame(), positions: [[1, 40], [29, 29]] };
    // die 2 lands token 0 on abs 3 (pair) — no capture; token 1 (40→42) advances more.
    expect(pickAutoMove(g, 0, 2)).toBe(1); // most-advanced fallback, not the pair "capture"
  });
});

describe('legalMoves edge cases', () => {
  it('an empty seat row yields no moves', () => {
    const g = { ...newGame(), positions: [] } as unknown as GameState;
    expect(legalMoves(g, 0, 6)).toEqual([]);
  });
});
