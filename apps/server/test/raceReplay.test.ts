/**
 * Invalidating farmed games (void-race-games) — the replay that rebuilds the
 * Race Week board without them.
 *
 * The property that matters: the rebuilt board must be EXACTLY the board the
 * event would have had if the voided games had never been played. That is
 * stronger than "subtract their points", because the award rule is stateful —
 * the per-opponent / per-day caps a farmed game consumed have to come back too,
 * or an honest game that was capped out behind the farm stays unrewarded.
 */
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memory.js';
import {
  awardForGame,
  replayRaceBoard,
  scoreEventGame,
  raceLeaderboard,
  DEFAULT_RACE_SCORE,
  type ReplayGame,
} from '../src/raceScore.js';

const DAY = '2026-07-20';
const NEXT = '2026-07-21';
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);
const NAMES: Record<string, string> = { [A]: 'Ada', [B]: 'Bo', [C]: 'Cy' };

function game(id: string, winner: string, loser: string, reason: ReplayGame['reason'] = 'finish', day = DAY): ReplayGame {
  return { id, winnerWallet: winner, winnerName: NAMES[winner]!, loserWallet: loser, loserName: NAMES[loser]!, reason, day };
}
const pts = (b: Record<string, { points: number }>, w: string): number => b[w.toLowerCase()]?.points ?? 0;

describe('replayRaceBoard (void-race-games)', () => {
  it('reproduces the live board exactly when nothing is voided', async () => {
    // The fidelity gate the ops script refuses to APPLY without: the replay must
    // rebuild what live scoring actually produced, or the "correction" is wrong.
    const s = new MemoryStore();
    for (const w of [A, B, C]) await s.setMeta(`race:grant:${w}`, JSON.stringify({ cents: 20, at: 1 }));
    const history: ReplayGame[] = [
      game('g1', A, B),
      game('g2', A, B),
      game('g3', A, B), // 3rd vs the same opponent — capped for A, B still gets +1
      game('g4', C, A, 'resign'), // abandon-win: C +1, A (thrower) +0
      game('g5', A, C),
      game('g6', A, B, 'finish', NEXT), // caps reset on a new day
    ];
    for (const g of history) {
      await scoreEventGame(s, {
        winnerWallet: g.winnerWallet,
        winnerName: g.winnerName,
        loserWallet: g.loserWallet,
        loserName: g.loserName,
        reason: g.reason,
        day: g.day,
      });
    }
    const live = await raceLeaderboard(s, undefined, 50);
    const { board } = replayRaceBoard(history, new Set());
    expect(Object.fromEntries(live.top.map((e) => [e.wallet, e.points]))).toEqual(
      Object.fromEntries(Object.entries(board).map(([w, v]) => [w, v.points])),
    );
  });

  it('voiding a farmed game GIVES BACK the cap it consumed, so the honest game behind it scores', () => {
    // A farms two wins off accomplice B, which burns A's 2-per-opponent budget;
    // A's third game vs B (the honest one, here won on a real finish) scored 0.
    const history = [game('farm1', A, B), game('farm2', A, B), game('honest', A, B)];
    expect(pts(replayRaceBoard(history, new Set()).board, A)).toBe(6); // 3+3, third capped

    // Void the two farmed games: A must keep the honest game's 3 — not 0.
    // (Subtracting 6 from the live total would have left A at 0 and punished
    // the honest game twice.)
    const { board } = replayRaceBoard(history, new Set(['farm1', 'farm2']));
    expect(pts(board, A)).toBe(3);
    expect(pts(board, B)).toBe(1); // one participation point, from the honest game
  });

  it('voiding every game a player is in removes them from the board entirely', () => {
    const history = [game('g1', A, B), game('g2', B, A)];
    const { board } = replayRaceBoard(history, new Set(['g1', 'g2']));
    expect(board).toEqual({});
  });

  it('leaves players who were never in a voided game untouched', () => {
    const history = [game('farm1', A, B), game('farm2', A, B), game('clean', C, A)];
    const full = replayRaceBoard(history, new Set()).board;
    const pruned = replayRaceBoard(history, new Set(['farm1', 'farm2'])).board;
    expect(pts(pruned, C)).toBe(pts(full, C)); // C's win stands
    // A keeps ONLY the participation point from the clean game it lost.
    expect(pts(pruned, A)).toBe(1);
    expect(pts(full, A)).toBe(7); // 3 + 3 farmed + 1 participation
  });

  it('is idempotent and order-independent in the voided set', () => {
    const history = [game('g1', A, B), game('g2', A, C), game('g3', C, B)];
    const once = replayRaceBoard(history, new Set(['g2'])).board;
    const twice = replayRaceBoard(history, new Set(['g2', 'g2'])).board;
    const reversed = replayRaceBoard(history, new Set(['g2'])).board;
    expect(twice).toEqual(once);
    expect(reversed).toEqual(once);
  });

  it('un-voiding restores the exact original board', () => {
    const history = [game('g1', A, B), game('g2', A, B), game('g3', C, A)];
    const original = replayRaceBoard(history, new Set()).board;
    const voided = replayRaceBoard(history, new Set(['g1'])).board;
    expect(voided).not.toEqual(original);
    expect(replayRaceBoard(history, new Set()).board).toEqual(original); // UNVOID=1 path
  });

  it('ignores ids that are not in the history (a stale or mistyped id is a no-op)', () => {
    const history = [game('g1', A, B)];
    expect(replayRaceBoard(history, new Set(['nope'])).board).toEqual(replayRaceBoard(history, new Set()).board);
  });

  it('honours the daily cap and returns the counters the live path must be resynced to', () => {
    const cfg = { ...DEFAULT_RACE_SCORE, maxScoredPerDay: 2 };
    const history = [game('g1', A, B), game('g2', A, C), game('g3', A, B)];
    const { board, daily, vs } = replayRaceBoard(history, new Set(), cfg);
    expect(pts(board, A)).toBe(6); // 3rd scored game of the day is capped
    expect(daily.get(`${A}:${DAY}`)).toBe(2);
    expect(vs.get(`${A}:${B}:${DAY}`)).toBe(1); // only g1 counted vs B
    // Voiding the first game frees the daily slot the third one wanted.
    const after = replayRaceBoard(history, new Set(['g1']), cfg);
    expect(pts(after.board, A)).toBe(6);
    expect(after.vs.get(`${A}:${B}:${DAY}`)).toBe(1); // now g3 is the one that counted
  });
});

describe('awardForGame (the rule live scoring and the replay share)', () => {
  it('matches scoreEventGame decision for decision', async () => {
    const s = new MemoryStore();
    for (const w of [A, B]) await s.setMeta(`race:grant:${w}`, JSON.stringify({ cents: 20, at: 1 }));
    const counters = { winnerDaily: 0, winnerVsLoser: 0, loserDaily: 0 };
    for (let i = 0; i < 4; i++) {
      const expected = awardForGame('finish', { ...counters });
      const actual = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', reason: 'finish', day: DAY });
      expect(actual).toEqual(expected);
      if (expected.winnerGained > 0) {
        counters.winnerDaily += 1;
        counters.winnerVsLoser += 1;
      }
      if (expected.loserGained > 0) counters.loserDaily += 1;
    }
  });

  it('is pure — same inputs, same answer, no hidden state', () => {
    const c = { winnerDaily: 1, winnerVsLoser: 1, loserDaily: 1 };
    expect(awardForGame('finish', c)).toEqual(awardForGame('finish', c));
    expect(awardForGame('resign', c)).toEqual({ winnerGained: 1, loserGained: 0 });
  });
});
