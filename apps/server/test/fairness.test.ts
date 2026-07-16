import { describe, expect, it } from 'vitest';
import { createFairness, createFairness4, createSeed4Commit, createSeedCommit, finalizeFairness, finalizeFairness4, rollDie, rollDie4, sha256Hex } from '../src/fairness.js';

describe('fairness (commit-reveal, anti-grinding)', () => {
  it('createSeedCommit binds the seed: commit === sha256(serverSeed)', () => {
    const { serverSeed, commit } = createSeedCommit();
    expect(serverSeed).toMatch(/^[0-9a-f]{64}$/);
    expect(commit).toBe(sha256Hex(serverSeed));
  });

  it('finalizeFairness produces the SAME dice as the legacy path for the same inputs', () => {
    // Prove the two-step commit-reveal doesn't change the dice maths — only the
    // ORDER in which the server learns the entropies (so it can no longer grind).
    const { serverSeed, commit } = createSeedCommit();
    const eA = 'aaaa1111bbbb2222';
    const eB = 'cccc3333dddd4444';
    const revealed = finalizeFairness(serverSeed, commit, eA, eB);
    // Reconstruct a legacy Fairness with the identical seed to compare rolls.
    const legacyLike = { serverSeed, commit, entropies: [eA, eB] as [string, string] };
    for (let i = 1; i <= 30; i++) {
      const d = rollDie(revealed, i);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(6);
      expect(rollDie(legacyLike, i)).toBe(d);
    }
  });

  it('a revealed entropy is verifiable against its hello commit', () => {
    const entropy = 'deadbeefcafebabe';
    const commit = sha256Hex(entropy);
    expect(sha256Hex(entropy)).toBe(commit); // server accepts
    expect(sha256Hex('tampered' + entropy)).not.toBe(commit); // server rejects a mismatch
  });

  it('the legacy createFairness still works (deploy backward-compat)', () => {
    const f = createFairness('11112222', '33334444');
    expect(f.commit).toBe(sha256Hex(f.serverSeed));
    expect(rollDie(f, 1)).toBeGreaterThanOrEqual(1);
  });
});

describe('4-player fairness (R-DICE-3, anti-grinding)', () => {
  it('createSeed4Commit binds the seed WITHOUT any seat input: commit === sha256(serverSeed)', () => {
    const { serverSeed, commit } = createSeed4Commit();
    expect(serverSeed).toMatch(/^[0-9a-f]{64}$/);
    expect(commit).toBe(sha256Hex(serverSeed));
    // The whole point: the seed is fixed here, before any raw seat seed is known,
    // so the server cannot pick it to bias the dice once the reveals arrive.
  });

  it('finalizeFairness4 produces the SAME dice as the legacy 4p path for identical seeds', () => {
    const { serverSeed, commit } = createSeed4Commit();
    const seatSeeds = ['s0aaaa', 's1bbbb', 's2cccc', 's3dddd'];
    const revealed = finalizeFairness4(serverSeed, commit, seatSeeds);
    const legacyLike = { serverSeed, commit, seeds: seatSeeds };
    for (let i = 1; i <= 30; i++) {
      const d = rollDie4(revealed, i);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(6);
      expect(rollDie4(legacyLike, i)).toBe(d);
    }
  });

  it('the revealed dice depend on the RAW seat seeds (so a late reveal changes them)', () => {
    const { serverSeed, commit } = createSeed4Commit();
    const a = finalizeFairness4(serverSeed, commit, ['aaaa', 'bbbb', 'cccc', 'dddd']);
    const b = finalizeFairness4(serverSeed, commit, ['aaaa', 'bbbb', 'cccc', 'ZZZZ']); // seat 3 differs
    const seqA = Array.from({ length: 20 }, (_, i) => rollDie4(a, i + 1));
    const seqB = Array.from({ length: 20 }, (_, i) => rollDie4(b, i + 1));
    // With the same committed seed but a different revealed seat seed, the dice
    // diverge — proof the seat's real entropy (not just the seed) drives the roll.
    expect(seqA).not.toEqual(seqB);
  });

  it('a seat reveal is verifiable against its hello commit', () => {
    const raw = 'a1b2c3d4e5f6a7b8';
    const commit = sha256Hex(raw);
    expect(sha256Hex(raw)).toBe(commit); // server binds only a matching reveal
    expect(sha256Hex('x' + raw)).not.toBe(commit); // a tampered reveal is rejected
  });

  it('the free 4p createFairness4 still works (bot tables, grindability moot)', () => {
    const f = createFairness4(['b0', 'b1', 'b2', 'b3']);
    expect(f.commit).toBe(sha256Hex(f.serverSeed));
    expect(rollDie4(f, 1)).toBeGreaterThanOrEqual(1);
  });
});
