import { describe, expect, it } from 'vitest';
import { jitClaimCents, jitTopUpCents, SEED_LIFETIME_MULT, seedDeficitCents, seedFpDrawCents, seedGrantCents } from '../src/race.js';

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

// The gas seed (B1) funds a burner's mint gas in cUSD. The grant keys on the
// wallet's LIVE balance, not on "was the target ever granted": a failed mint
// attempt still burns its gas, so a fully-granted wallet can end up below the
// mint's reservation — and the old granted-total idempotency refused to ever
// re-fund it (the drained-burner trap). These tests pin the deficit accounting.

describe('gas-seed deficit (balance-based)', () => {
  it('a fresh burner (0 balance) needs the full target', () => {
    expect(seedDeficitCents(10, 0)).toBe(10);
  });
  it('a topped-up burner needs nothing', () => {
    expect(seedDeficitCents(10, 10)).toBe(0);
    expect(seedDeficitCents(10, 25)).toBe(0);
  });
  it('a DRAINED burner (granted before, burned gas on failed mints) needs the gap', () => {
    // Granted 10 once, two failed mints left 4 on-chain → deficit is 6, not 0.
    expect(seedDeficitCents(10, 4)).toBe(6);
  });
});

describe('gas-seed grant bounds', () => {
  const cap = 10 * SEED_LIFETIME_MULT; // lifetime cap for a 10¢ target

  it('grants the full deficit when cap and pool allow', () => {
    expect(seedGrantCents(10, 0, cap, 0, 5000)).toBe(10);
  });
  it('re-funds a drained wallet (the self-heal the old logic refused)', () => {
    // Already drew 10, balance fell to 4 → deficit 6 fits under the 30¢ cap.
    expect(seedGrantCents(6, 10, cap, 10, 5000)).toBe(6);
  });
  it('stops at the lifetime cap (drain-and-reclaim abuse)', () => {
    expect(seedGrantCents(10, cap, cap, cap, 5000)).toBe(0);
  });
  it('clamps the last grant to the cap remainder', () => {
    // Drew 25 of the 30¢ cap → a 10¢ deficit only gets the 5¢ left.
    expect(seedGrantCents(10, 25, cap, 25, 5000)).toBe(5);
  });
  it('clamps to the pool remainder and returns 0 when the pool is dry', () => {
    expect(seedGrantCents(10, 0, cap, 4997, 5000)).toBe(3);
    expect(seedGrantCents(10, 0, cap, 5000, 5000)).toBe(0);
  });
  it('grants nothing when there is no deficit', () => {
    expect(seedGrantCents(0, 10, cap, 10, 5000)).toBe(0);
  });
});

// The per-DEVICE seed allowance replaced the one-shot fingerprint gate: "Clear
// site data" wipes the burner key but not the fingerprint, so a returning player
// arrives with a fresh 0-balance burner on an already-seeded device — the
// one-shot gate stranded them forever. seedFpDrawCents parses the device's
// cumulative draw, including the legacy rows that stored the wallet address.

describe('per-device seed draw parsing', () => {
  it('a never-seeded device (no row) has drawn 0', () => {
    expect(seedFpDrawCents(null, 10)).toBe(0);
  });
  it('a rolled-back row (empty string) has drawn 0', () => {
    expect(seedFpDrawCents('', 10)).toBe(0);
  });
  it('a legacy row (bare wallet address) counts as one full draw', () => {
    expect(seedFpDrawCents('0xabc0000000000000000000000000000000000def', 10)).toBe(10);
  });
  it('a JSON row returns its cumulative cents', () => {
    expect(seedFpDrawCents('{"cents":16,"wallet":"0xabc"}', 10)).toBe(16);
  });
  it('a malformed JSON row falls back to one full draw (never over-grants)', () => {
    expect(seedFpDrawCents('{"wallet":"0xabc"}', 10)).toBe(10);
  });
  it('the wiped-burner scenario: legacy device draw of 10 under the 30 cap leaves 20', () => {
    const cap = 10 * SEED_LIFETIME_MULT;
    const drawn = seedFpDrawCents('0xoldburner', 10);
    // A replacement burner (deficit 10) is re-seeded: min(wallet grant, device headroom).
    expect(Math.min(seedGrantCents(10, 0, cap, 20, 5000), Math.max(0, cap - drawn))).toBe(10);
  });
});
