import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyMove, applyRoll, FINISHED, newGame, pickAutoMove } from '../src/index.js';
import type { GameState } from '../src/index.js';
import { applyMove4, applyRoll4, newGame4, nextSeat4, pickAutoMove4, type Game4 } from '../src/ludo4.js';

// Property-based invariants (Phase 1): drive full games from random dice streams
// and assert the rules engine's structural guarantees hold after EVERY transition.
// fast-check shrinks any failing dice sequence to a minimal reproducer.

const TOKENS_2P = 2;
const TOKENS_4P = 4;
const diceStream = fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 1500 });

/** Every token position is a legal encoding: base (-1), track/home (0..55) or FINISHED. */
function positionsWellFormed(rows: number[][], tokensPerSeat: number): boolean {
  return rows.every((row) => row.length === tokensPerSeat && row.every((p) => p === -1 || (p >= 0 && p <= FINISHED)));
}

describe('2p engine invariants (fast-check)', () => {
  it('token count is conserved and every state stays well-formed through a whole game', () => {
    fc.assert(
      fc.property(diceStream, (dice) => {
        let g: GameState = newGame();
        let i = 0;
        let guard = 0;
        while (g.phase !== 'over' && guard++ < 6000) {
          const die = dice[i++ % dice.length]!;
          g = applyRoll(g, die);
          // INVARIANT: two rows of exactly TOKENS_2P, all positions legal.
          expect(g.positions).toHaveLength(2);
          expect(positionsWellFormed(g.positions, TOKENS_2P)).toBe(true);
          if (g.phase === 'awaiting-move') {
            const pick = pickAutoMove(g, g.turn, die) ?? g.legal[0]!;
            const { state, events } = applyMove(g, pick);
            // INVARIANT: a capture always sends exactly a lone opponent token to base.
            if (events.capture) {
              const opp = g.turn === 0 ? 1 : 0;
              expect(state.positions[opp]!.filter((p) => p === -1).length).toBeGreaterThan(g.positions[opp]!.filter((p) => p === -1).length);
            }
            // INVARIANT: no token ever exceeds FINISHED (exact-count rule).
            expect(state.positions.every((r) => r.every((p) => p <= FINISHED))).toBe(true);
            g = state;
          }
        }
        // INVARIANT: a declared winner really has all tokens home.
        if (g.winner !== null) {
          expect(g.positions[g.winner]!.every((p) => p === FINISHED)).toBe(true);
          expect(g.phase).toBe('over');
        }
      }),
      { numRuns: 50 },
    );
  });

  it('is deterministic: the same dice stream replays to an identical final state', () => {
    fc.assert(
      fc.property(diceStream, (dice) => {
        const play = (): GameState => {
          let g = newGame();
          let i = 0;
          let guard = 0;
          while (g.phase !== 'over' && guard++ < 6000) {
            const die = dice[i++ % dice.length]!;
            g = applyRoll(g, die);
            if (g.phase === 'awaiting-move') g = applyMove(g, pickAutoMove(g, g.turn, die) ?? g.legal[0]!).state;
          }
          return g;
        };
        expect(JSON.stringify(play())).toBe(JSON.stringify(play()));
      }),
      { numRuns: 30 },
    );
  });
});

describe('4p engine invariants (fast-check)', () => {
  it('token count is conserved, captures go to base, winner is legit, through a whole game', () => {
    fc.assert(
      fc.property(diceStream, (dice) => {
        let g: Game4 = newGame4();
        let i = 0;
        let guard = 0;
        while (g.phase !== 'over' && guard++ < 6000) {
          const die = dice[i++ % dice.length]!;
          g = applyRoll4(g, die);
          // INVARIANT: 4 rows of exactly TOKENS_4P, all positions legal.
          expect(g.positions).toHaveLength(4);
          expect(positionsWellFormed(g.positions, TOKENS_4P)).toBe(true);
          // INVARIANT: the turn is always a seat still in play.
          expect(g.positions[g.turn]!.every((p) => p === FINISHED)).toBe(false);
          if (g.phase === 'awaiting-move') {
            const before = g.positions.map((r) => r.filter((p) => p === -1).length);
            const { state, events } = applyMove4(g, pickAutoMove4(g, g.turn, die) ?? g.legal[0]!);
            if (events.capture) {
              const after = state.positions.map((r) => r.filter((p) => p === -1).length);
              // at least one OPPONENT seat gained a based token
              const gained = after.some((c, s) => s !== g.turn && c > before[s]!);
              expect(gained).toBe(true);
            }
            expect(state.positions.every((r) => r.every((p) => p <= FINISHED))).toBe(true);
            g = state;
          }
        }
        if (g.winner !== null) {
          expect(g.positions[g.winner]!.every((p) => p === FINISHED)).toBe(true);
        }
      }),
      { numRuns: 50 },
    );
  });

  it('nextSeat4 always returns a seat index in 0..3', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3 }), fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }), (seat, doneMask) => {
        const g: Game4 = { ...newGame4(), positions: doneMask.map((d) => (d ? [FINISHED, FINISHED, FINISHED, FINISHED] : [0, -1, -1, -1])) };
        const n = nextSeat4(g, seat);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(3);
      }),
      { numRuns: 100 },
    );
  });
});
