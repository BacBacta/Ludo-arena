import { describe, expect, it } from 'vitest';
import { FINISHED } from '@ludo/game-engine';
import { countFinished, homeTier } from '../src/lib/homeCelebration';

// The A3 ladder: 1st pawn home = premium stinger, 2nd/3rd = brief progress
// cue, 4th = the win (playWin owns it), anything else = silence.

describe('countFinished — how many of a row\'s tokens are home', () => {
  it('counts exactly the FINISHED cells', () => {
    expect(countFinished([FINISHED, 3, FINISHED, -1])).toBe(2);
    expect(countFinished([FINISHED, FINISHED, FINISHED, FINISHED])).toBe(4);
  });

  it('an untouched row counts zero', () => {
    expect(countFinished([-1, -1, -1, -1])).toBe(0);
  });

  it('near-home is not home (55 is still on the runway)', () => {
    expect(countFinished([55, 54, 0, -1])).toBe(0);
  });

  it('null-safe: an unknown row is 0, never a crash', () => {
    expect(countFinished(undefined)).toBe(0);
    expect(countFinished(null)).toBe(0);
  });
});

describe('homeTier — the celebration ladder', () => {
  it('first pawn home → the premium moment', () => {
    expect(homeTier(0, 1)).toBe('first');
  });

  it('2nd and 3rd pawns → the brief progress cue', () => {
    expect(homeTier(1, 2)).toBe('progress');
    expect(homeTier(2, 3)).toBe('progress');
  });

  it('4th pawn → final: playWin() owns the win, the ladder stays silent', () => {
    expect(homeTier(3, 4)).toBe('final');
  });

  it('no new pawn home → none (plain moves, state resyncs)', () => {
    expect(homeTier(0, 0)).toBe('none');
    expect(homeTier(2, 2)).toBe('none');
  });

  it('a DECREASE is none — a capture sends a token back, never celebrates', () => {
    expect(homeTier(2, 1)).toBe('none');
    expect(homeTier(1, 0)).toBe('none');
  });

  it('a jump past the milestone still lands on the biggest tier reached', () => {
    // Defensive: counts only ever move by 1 in ludo, but the guard must hold.
    expect(homeTier(0, 2)).toBe('first');
    expect(homeTier(1, 4)).toBe('final');
  });
});
