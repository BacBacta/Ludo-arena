import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { finalizeFairness, rollDie, sha256Hex, type Fairness } from '../src/fairness.js';

/**
 * Statistical validation of the server dice RNG (Phase 1, R-DICE-2).
 *
 * SOURCE OF RANDOMNESS (documented): the dice are NOT Math.random. Each die is
 *   die #i = 1 + ( first 48 bits of sha256(serverSeed | entropyA | entropyB | i) ) % 6
 * i.e. a SHA-256 stream keyed by the commit-reveal inputs (fairness.ts:rollDie).
 * serverSeed is 256 bits of crypto randomness (node:crypto randomBytes) committed
 * before play; the per-index SHA-256 avalanche makes the face stream uniform and
 * serially independent. The %6 reduction over 48 bits has a bias of ~4/2^48 ≈
 * 1.4e-14 — far below anything these tests could detect.
 *
 * This is NOT a substitute for accredited RNG certification (iTech/GLI/eCOGRA),
 * which remains a required pre-mainnet human step (see TESTING_REPORT.md).
 */
describe('dice RNG statistics (R-DICE-2)', () => {
  const N = 1_000_000;
  // Chi-square critical values at alpha = 0.01 (reject uniformity/independence
  // only if the statistic EXCEEDS these — so a pass means p > 0.01).
  const CHI2_CRIT_DF5 = 15.0863; // goodness-of-fit, 6 faces → df = 5
  const CHI2_CRIT_DF25 = 44.3141; // 6x6 independence table → df = 25

  // Seeds are DETERMINISTIC by default so the test never flakes: at alpha=0.01 a
  // random-seed run false-fails ~1% of the time (two tests → ~2% per CI run), which
  // in a CI gate trains everyone to ignore a red. A fixed "nothing-up-my-sleeve"
  // seed (sha256 of a fixed label, not chosen to hide bias) makes a red a REAL,
  // reproducible bug. The RNG is a SHA-256 keyed stream, so any seed validates the
  // algorithm's uniformity; set DICE_STATS_RANDOM=1 locally to fuzz random seeds.
  const RANDOM = process.env.DICE_STATS_RANDOM === '1';
  function seedHex(label: string, bytes: number): string {
    if (RANDOM) return randomBytes(bytes).toString('hex');
    // Expand the label deterministically to `bytes` via chained SHA-256.
    let out = '';
    let cur = label;
    while (out.length < bytes * 2) {
      cur = sha256Hex(cur);
      out += cur;
    }
    return out.slice(0, bytes * 2);
  }
  function fairness(): Fairness {
    const seed = seedHex('ludo-arena/R-DICE-2/serverSeed', 32);
    const eA = seedHex('ludo-arena/R-DICE-2/entropyA', 16);
    const eB = seedHex('ludo-arena/R-DICE-2/entropyB', 16);
    return finalizeFairness(seed, '', eA, eB);
  }

  it('is uniform over 1,000,000 rolls (chi-square goodness-of-fit, p > 0.01)', () => {
    const f = fairness();
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 1; i <= N; i++) counts[rollDie(f, i) - 1]!++;

    const expected = N / 6;
    const chi2 = counts.reduce((acc, obs) => acc + (obs - expected) ** 2 / expected, 0);

    // every face actually appears near its expected share (sanity + no dead face)
    for (const c of counts) expect(c / N).toBeGreaterThan(0.16); // ~0.1667 expected
    expect(chi2).toBeLessThan(CHI2_CRIT_DF5);
  }, 30_000);

  it('successive rolls are independent (6x6 serial chi-square, p > 0.01)', () => {
    const f = fairness();
    const table = Array.from({ length: 6 }, () => [0, 0, 0, 0, 0, 0]);
    let prev = rollDie(f, 1);
    for (let i = 2; i <= N; i++) {
      const cur = rollDie(f, i);
      table[prev - 1]![cur - 1]!++;
      prev = cur;
    }

    const total = N - 1;
    const rowSums = table.map((r) => r.reduce((a, b) => a + b, 0));
    const colSums = [0, 1, 2, 3, 4, 5].map((c) => table.reduce((a, r) => a + r[c]!, 0));
    let chi2 = 0;
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        const exp = (rowSums[r]! * colSums[c]!) / total;
        chi2 += (table[r]![c]! - exp) ** 2 / exp;
      }
    }
    expect(chi2).toBeLessThan(CHI2_CRIT_DF25);
  }, 30_000);

  it('the fairness of the stream rests on the reveal==commit check (mismatch rejected)', () => {
    // The derivation is only as fair as the commit check feeding it: the server's
    // game.entropy handler refuses a reveal that does not hash to the hello commit
    // (index.ts). Prove the primitive that gate relies on.
    const raw = randomBytes(32).toString('hex');
    const commit = sha256Hex(raw);
    expect(sha256Hex(raw)).toBe(commit); // honest reveal → bound
    expect(sha256Hex(`x${raw}`)).not.toBe(commit); // tampered reveal → rejected
  });
});
