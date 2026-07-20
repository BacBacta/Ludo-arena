import { describe, expect, it } from 'vitest';
import { jitClaimCents, jitTopUpCents } from '../src/race.js';

// JIT (just-in-time) funding is the mainnet anti-"claim-and-run" model: instead
// of granting a wallet its whole quota up front, the faucet drips one stake at a
// time — one at claim, then one after each COMPLETED event game. A wallet that
// claims and vanishes keeps only that first stake, not the quota. These tests
// pin the pure accounting (the transfer path is exercised by the E2E).

describe('JIT claim grant', () => {
  it('grants one stake (perGameCents) at claim', () => {
    expect(jitClaimCents(2, 10)).toBe(2);
  });
  it('never exceeds the whole quota when the stake is larger', () => {
    expect(jitClaimCents(20, 10)).toBe(10);
  });
  it('is non-negative for a degenerate quota', () => {
    expect(jitClaimCents(2, 0)).toBe(0);
  });
});

describe('JIT top-up after a finished game', () => {
  it('drips the next stake when quota and pool both allow', () => {
    // funded=2 of quota=10, spent=2 of pool=3000 → next stake fits.
    expect(jitTopUpCents(2, 2, 10, 2, 3000)).toBe(2);
  });

  it('stops once the wallet has drawn its whole quota', () => {
    expect(jitTopUpCents(2, 10, 10, 20, 3000)).toBe(0);
  });

  it('clamps the last drip to the quota remainder (no over-fund)', () => {
    // funded=9 of quota=10 → only 1¢ of headroom left even though a stake is 2¢.
    expect(jitTopUpCents(2, 9, 10, 18, 3000)).toBe(1);
  });

  it('clamps to the pool remainder when the pool is nearly dry', () => {
    // pool has only 1¢ left → the drip is 1¢, not a full 2¢ stake.
    expect(jitTopUpCents(2, 2, 10, 2999, 3000)).toBe(1);
  });

  it('returns 0 when the pool is exhausted', () => {
    expect(jitTopUpCents(2, 2, 10, 3000, 3000)).toBe(0);
  });

  it('the full lifecycle drips exactly quotaCents over the wallet, no more', () => {
    const quota = 10;
    const perGame = 2;
    const pool = 3000;
    let funded = jitClaimCents(perGame, quota); // claim grant
    let spent = funded;
    let games = 0;
    // Simulate finished games until the wallet stops being funded.
    for (let i = 0; i < 100; i++) {
      const drip = jitTopUpCents(perGame, funded, quota, spent, pool);
      if (drip <= 0) break;
      funded += drip;
      spent += drip;
      games++;
    }
    expect(funded).toBe(quota); // never funded past the quota
    expect(games).toBe(4); // 2 (claim) + 4×2 = 10 = quota
  });
});
