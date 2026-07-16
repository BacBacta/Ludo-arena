import { describe, expect, it } from 'vitest';
import {
  applyMove4,
  BASE_SPOTS4,
  HOME_COLUMNS4,
  legalMoves4,
  newGame4,
  nextSeat4,
  pickAutoMove4,
  SEAT_START4,
  tokenXY4,
  type Game4,
} from '../src/ludo4.js';
import { FINISHED, LAST_TRACK_REL, SAFE_CELLS, TRACK, TRACK_LEN } from '../src/constants.js';

// Complements ludo4.test.ts: 4p geometry, multi-seat capture, the pickAutoMove4
// priority ladder, nextSeat4 fallback, and tokenXY4 rendering (all branches).

function base(): Game4 {
  return newGame4();
}

describe('4p geometry', () => {
  it('all four seat start cells are safe', () => {
    for (const s of SEAT_START4) expect(SAFE_CELLS.has(s)).toBe(true);
  });
  it('the four starts are distinct and evenly spaced (0/13/26/39)', () => {
    expect([...SEAT_START4].sort((a, b) => a - b)).toEqual([0, 13, 26, 39]);
  });
  it('home columns never collide across seats (each cell used by one seat only)', () => {
    const seen = new Set<string>();
    HOME_COLUMNS4.forEach((col) => {
      col.forEach(([x, y]) => {
        const key = `${x},${y}`;
        expect(seen.has(key)).toBe(false); // no overlap
        seen.add(key);
      });
    });
    expect(seen.size).toBe(4 * 5); // 4 seats × 5 home cells
  });
});

describe('nextSeat4', () => {
  it('returns the same seat when everyone else has finished (fallback)', () => {
    const g: Game4 = { ...base(), positions: [[FINISHED, FINISHED, FINISHED, FINISHED], [FINISHED, FINISHED, FINISHED, FINISHED], [FINISHED, FINISHED, FINISHED, FINISHED], [0, -1, -1, -1]] };
    expect(nextSeat4(g, 3)).toBe(3); // only seat 3 remains → stays on seat 3
  });
  it('wraps 3 → 0 skipping finished seats', () => {
    const g: Game4 = { ...base(), positions: [[0, -1, -1, -1], [FINISHED, FINISHED, FINISHED, FINISHED], [0, -1, -1, -1], [0, -1, -1, -1]] };
    expect(nextSeat4(g, 3)).toBe(0);
    expect(nextSeat4(g, 0)).toBe(2); // seat 1 finished → skipped
  });
  it('returns the current seat when EVERY seat (including it) has finished (loop fallback)', () => {
    const allDone: Game4 = { ...base(), positions: Array.from({ length: 4 }, () => [FINISHED, FINISHED, FINISHED, FINISHED]) };
    expect(nextSeat4(allDone, 2)).toBe(2); // loop finds no live seat → fallback `return seat`
  });
});

describe('4p multi-seat simultaneous capture', () => {
  it('one move sends TWO different opponents’ lone tokens home at once', () => {
    // seat 0 lands on abs cell C where BOTH seat 1 and seat 2 have a lone token.
    // Pick C = 5 (not safe). seat0: rel r0 with (39+r0)%52 = 5 → r0 = 18.
    // seat1 start 0 → rel 5; seat2 start 13 → rel (5-13+52)%52 = 44.
    const C = 5;
    expect(SAFE_CELLS.has(C)).toBe(false);
    const g: Game4 = {
      ...base(),
      positions: [
        [16, -1, -1, -1], // seat 0 token0 at rel 16 → +2 = 18 → abs (39+18)%52 = 5
        [5, -1, -1, -1], // seat 1 lone at abs 5
        [44, -1, -1, -1], // seat 2 lone at abs 5
        [-1, -1, -1, -1],
      ],
      turn: 0,
      dice: 2,
      legal: [0],
      phase: 'awaiting-move',
    };
    const { state, events } = applyMove4(g, 0);
    expect(events.capture).toBe(true);
    expect(state.positions[1]![0]).toBe(-1); // seat 1 sent home
    expect(state.positions[2]![0]).toBe(-1); // seat 2 ALSO sent home
    expect(state.turn).toBe(0); // capture grants an extra turn
  });

  it('captures the single opponent but spares a protected pair on the same cell', () => {
    // seat 1 lone (captured) and seat 2 pair (spared) both on abs 5.
    const g: Game4 = {
      ...base(),
      positions: [
        [16, -1, -1, -1],
        [5, -1, -1, -1], // seat 1 lone → captured
        [44, 44, -1, -1], // seat 2 pair → protected
        [-1, -1, -1, -1],
      ],
      turn: 0,
      dice: 2,
      legal: [0],
      phase: 'awaiting-move',
    };
    const { state, events } = applyMove4(g, 0);
    expect(events.capture).toBe(true);
    expect(state.positions[1]![0]).toBe(-1); // lone captured
    expect(state.positions[2]!.slice(0, 2)).toEqual([44, 44]); // pair stands
  });
});

describe('pickAutoMove4 priority ladder', () => {
  it('returns null with no legal move', () => {
    expect(pickAutoMove4(base(), 0, 3)).toBeNull();
  });
  it('prefers finishing a token', () => {
    const g: Game4 = { ...base(), positions: [[52, 10, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]] };
    expect(pickAutoMove4(g, 0, 4)).toBe(0); // 52 + 4 = 56 exact
  });
  it('prefers capturing when it cannot finish', () => {
    const g: Game4 = { ...base(), positions: [[16, 30, -1, -1], [5, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]] };
    // die 2: token0 16→18 (abs 5) captures seat1; token1 30→32 just advances.
    expect(pickAutoMove4(g, 0, 2)).toBe(0);
  });
  it('prefers exiting base on a 6 when no finish/capture exists', () => {
    const g: Game4 = { ...base(), positions: [[-1, 20, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]] };
    expect(pickAutoMove4(g, 0, 6)).toBe(0); // exit preferred
  });
  it('falls back to the most-advanced token', () => {
    const g: Game4 = { ...base(), positions: [[10, 30, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]] };
    expect(pickAutoMove4(g, 0, 3)).toBe(1); // token1 (30) is furthest; no finish/capture/exit
  });
  it('keeps the first token when it is already the furthest (tie-break false branch)', () => {
    const g: Game4 = { ...base(), positions: [[30, 10, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]] };
    expect(pickAutoMove4(g, 0, 3)).toBe(0); // token0 (30) furthest → never beaten
  });
  it('does not count a protected pair as a capture', () => {
    const g: Game4 = { ...base(), positions: [[16, 30, -1, -1], [5, 5, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]] };
    // seat1 pair on abs 5 → not capturable; heuristic falls back to most-advanced (token1).
    expect(pickAutoMove4(g, 0, 2)).toBe(1);
  });
  it('returns the first legal token when the seat row is missing', () => {
    const g = { ...base(), positions: [] } as unknown as Game4;
    // no row → legalMoves4 returns [] → null
    expect(pickAutoMove4(g, 0, 6)).toBeNull();
  });
});

describe('tokenXY4 rendering (all position kinds)', () => {
  it('maps a based token to its base slot', () => {
    expect(tokenXY4(0, 0, -1)).toEqual([BASE_SPOTS4[0]![0]![0], BASE_SPOTS4[0]![0]![1]]);
  });
  it('maps a finished token near the centre with a per-seat offset', () => {
    const [x, y] = tokenXY4(2, 0, FINISHED);
    expect(x).toBeCloseTo(7.5 + 0.3, 5); // seat 2 offset [+0.3, -0.3]
    expect(y).toBeCloseTo(7.5 - 0.3, 5);
  });
  it('maps a track position to the shared TRACK cell (+0.5 centering)', () => {
    const rel = 3;
    const cell = TRACK[((SEAT_START4[1] ?? 0) + rel) % TRACK_LEN]!;
    expect(tokenXY4(1, 0, rel)).toEqual([cell[0] + 0.5, cell[1] + 0.5]);
  });
  it('maps a home-column position to its home cell', () => {
    const rel = LAST_TRACK_REL + 2; // second home-column cell
    const home = HOME_COLUMNS4[0]![rel - (LAST_TRACK_REL + 1)]!;
    expect(tokenXY4(0, 0, rel)).toEqual([home[0] + 0.5, home[1] + 0.5]);
  });
  it('falls back to the centre for an out-of-range seat', () => {
    expect(tokenXY4(9, 0, -1)).toEqual([7.5, 7.5]); // no base slot → centre
  });
  it('finished token with an out-of-range seat has no offset', () => {
    expect(tokenXY4(9, 0, FINISHED)).toEqual([7.5, 7.5]); // off[seat] ?? [0,0]
  });
  it('home-column position with an out-of-range seat falls back to centre cell', () => {
    expect(tokenXY4(9, 0, LAST_TRACK_REL + 1)).toEqual([7.5, 7.5]); // HOME_COLUMNS4[seat] ?? [7,7]
  });
});

describe('legalMoves4 edge cases', () => {
  it('an empty seat row yields no moves', () => {
    const g = { ...base(), positions: [] } as unknown as Game4;
    expect(legalMoves4(g, 0, 6)).toEqual([]);
  });
});
