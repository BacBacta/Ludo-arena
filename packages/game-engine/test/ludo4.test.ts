import { describe, expect, it } from 'vitest';
import {
  applyMove4,
  applyRoll4,
  legalMoves4,
  newGame4,
  nextSeat4,
  pickAutoMove4,
  SEATS4,
  TOKENS4,
} from '../src/ludo4.js';
import { FINISHED } from '../src/constants.js';

describe('4-player engine', () => {
  it('starts 4 seats × 4 tokens, all in base', () => {
    const g = newGame4();
    expect(g.positions).toHaveLength(SEATS4);
    for (const row of g.positions) {
      expect(row).toHaveLength(TOKENS4);
      expect(row).toEqual([-1, -1, -1, -1]);
    }
    expect(g.turn).toBe(0);
  });

  it('a 6 exits every token from base; a low roll has no legal move', () => {
    const g = newGame4();
    expect(legalMoves4(g, 0, 6).sort()).toEqual([0, 1, 2, 3]);
    expect(legalMoves4(g, 0, 3)).toEqual([]);
  });

  it('rotates the turn 0→1→2→3→0 on a no-move roll (all base, roll ≠ 6)', () => {
    // force a state where seat 0 has no legal move
    let g = newGame4();
    g = { ...g, positions: g.positions.map((r, s) => (s === 0 ? [-1, -1, -1, -1] : [...r])) };
    const after = applyRoll4(g, 3); // seat 0 can't move → passes
    expect(after.turn).toBe(1);
    expect(after.phase).toBe('awaiting-roll');
  });

  it('nextSeat4 skips finished seats', () => {
    const g = newGame4();
    // seat 1 has all tokens home (56 = FINISHED) → rotation skips it
    const withDone = { ...g, positions: g.positions.map((r, s) => (s === 1 ? [56, 56, 56, 56] : [...r])) };
    expect(nextSeat4(withDone, 0)).toBe(2);
  });

  it('moving a token onto an opponent captures it back to base', () => {
    let g = newGame4();
    // seat 0 token 0 at rel 5 (abs cell 5); seat 2 token 0 parked on the same abs cell.
    // seat 2 start is 26, so rel r with (26+r)%52 === 5 → r = 31 (>LAST_TRACK_REL? 31<=50 ok)
    g = {
      ...g,
      positions: [
        [2, -1, -1, -1], // seat 0 token0 at rel 2 → will move +3 to rel 5 (abs 5)
        [-1, -1, -1, -1],
        [31, -1, -1, -1], // seat 2 token0 at abs (26+31)%52 = 5
        [-1, -1, -1, -1],
      ],
      turn: 0,
      dice: 3,
      legal: [0],
      phase: 'awaiting-move',
    };
    const { state, events } = applyMove4(g, 0);
    expect(events.capture).toBe(true);
    expect(state.positions[2]![0]).toBe(-1); // captured back to base
  });

  it('a stacked pair is protected from capture', () => {
    // seat 0 token 0 at rel 2 → +3 = abs 5; seat 2 has a pair on abs 5 (rel 31)
    const g = newGame4();
    const g2 = {
      ...g,
      positions: [[2, -1, -1, -1], [-1, -1, -1, -1], [31, 31, -1, -1], [-1, -1, -1, -1]],
      turn: 0,
      dice: 3,
      legal: [0],
      phase: 'awaiting-move' as const,
    };
    const { state, events } = applyMove4(g2, 0);
    expect(events.capture).toBe(false);
    expect(state.positions[2]!.slice(0, 2)).toEqual([31, 31]); // pair intact
  });

  it('exact count required to finish — an overshoot is not playable', () => {
    const g = newGame4();
    const g2 = { ...g, positions: g.positions.map((r, s) => (s === 0 ? [54, FINISHED, FINISHED, FINISHED] : [...r])) };
    expect(legalMoves4(g2, 0, 2)).toEqual([0]); // 54 + 2 = 56 exact
    expect(legalMoves4(g2, 0, 3)).toEqual([]); // overshoot → no move
  });

  it('bringing a token home grants another roll', () => {
    const g = newGame4();
    const g2 = {
      ...g,
      positions: g.positions.map((r, s) => (s === 0 ? [54, 10, -1, -1] : [...r])),
      dice: 2,
      legal: [0],
      phase: 'awaiting-move' as const,
    };
    const { state, events } = applyMove4(g2, 0);
    expect(events.finished).toBe(true);
    expect(events.extraTurn).toBe(true);
    expect(state.turn).toBe(0); // rolls again after a home
  });

  it('three consecutive 6s forfeit the turn', () => {
    let g = newGame4();
    g = { ...g, positions: g.positions.map((r, s) => (s === 0 ? [3, -1, -1, -1] : [...r])) };
    g = applyMove4(applyRoll4(g, 6), 0).state; // streak 1, extra turn
    g = applyMove4(applyRoll4(g, 6), 0).state; // streak 2, extra turn
    expect(g.turn).toBe(0);
    g = applyRoll4(g, 6); // streak 3 → forfeit
    expect(g.turn).toBe(1);
    expect(g.phase).toBe('awaiting-roll');
    expect(g.sixStreak).toBe(0);
  });

  it('a full random-ish game reaches "over" with a winner (bots auto-play)', () => {
    let g = newGame4();
    let dieSeq = 0;
    const dice = [6, 5, 6, 4, 3, 6, 2, 6, 6, 5, 4, 6, 3, 6, 2, 5, 6, 6, 4, 6];
    for (let step = 0; step < 4000 && g.phase !== 'over'; step++) {
      const die = dice[dieSeq++ % dice.length]!;
      g = applyRoll4(g, die);
      if (g.phase === 'awaiting-move') {
        const pick = pickAutoMove4(g, g.turn, die) ?? g.legal[0]!;
        g = applyMove4(g, pick).state;
      }
    }
    expect(g.phase).toBe('over');
    expect(g.winner).not.toBeNull();
  });
});
