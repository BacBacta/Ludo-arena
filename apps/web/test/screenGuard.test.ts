import { describe, expect, it } from 'vitest';
import { initialState, reducer } from '../src/state/store';

// Regression — the blank-blue-screen trap. A production drop mid-staking made
// the app fall back to the lobby (match context nulled), and when the room then
// started, GAME_STATE flipped the screen to 'game' with NO match — GameScreen
// null-rendered a permanently empty page while the server auto-played the
// stranded player to a 3-miss forfeit of a REAL locked stake. The screen switch
// must therefore require the match context; every legitimate flow (queue,
// rematch, private table, bot practice, resume) dispatches MATCH_FOUND or
// RESUME before any state lands.

const match = {
  gameId: 'g1',
  seat: 0 as const,
  opponent: { name: 'Rival', elo: 1200, flag: '' },
  stakeCents: 1,
  potCents: 2,
  fairnessCommit: 'a'.repeat(64),
};
const game = { turn: 0, phase: 'awaiting-roll', positions: [[0, 0], [0, 0]], dice: null } as never;

describe('GAME_STATE screen guard', () => {
  it('with a match context, switches to the game screen', () => {
    const s = reducer({ ...initialState, match: match as never, screen: 'matchmaking' }, { type: 'GAME_STATE', game });
    expect(s.screen).toBe('game');
    expect(s.game).toBe(game);
  });

  it('WITHOUT a match context, never strands the player on a blank game screen', () => {
    const s = reducer({ ...initialState, match: null, screen: 'lobby' }, { type: 'GAME_STATE', game });
    expect(s.screen).toBe('lobby'); // stays somewhere functional
  });
});
