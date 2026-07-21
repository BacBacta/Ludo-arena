import { describe, expect, it } from 'vitest';
import { isMatchAborted, type ErrorCode } from '@ludo/shared';

// Regression: a matched player was TRAPPED on the "opponent found"/staking
// screen when the opponent left before staking. The server sent that abort as
// code 'INTERNAL', which the client only toasted (never left the screen). The
// fix routes on a DEDICATED code, and this predicate is the single source of
// truth both sides share so the code string can never drift between them.

describe('isMatchAborted (pre-game abort → return to lobby)', () => {
  it('is true ONLY for the dedicated abort code', () => {
    expect(isMatchAborted('MATCH_ABORTED')).toBe(true);
  });

  it('is false for a generic INTERNAL (must NOT yank the player off a live game)', () => {
    expect(isMatchAborted('INTERNAL')).toBe(false);
  });

  it('is false for benign gameplay-race codes', () => {
    const benign: ErrorCode[] = ['NOT_YOUR_TURN', 'ILLEGAL_MOVE', 'BAD_STATE', 'LIMIT_REACHED'];
    for (const c of benign) expect(isMatchAborted(c)).toBe(false);
  });
});

// onInfo passes `code` as ErrorCode | undefined (some notices carry no code).
// The predicate must treat undefined as "not an abort" so a code-less notice
// never yanks a player off a live game.
describe('isMatchAborted tolerates a missing code', () => {
  it('is false for undefined', () => {
    expect(isMatchAborted(undefined)).toBe(false);
  });
});
