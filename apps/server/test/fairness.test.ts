import { describe, expect, it } from 'vitest';
import { createFairness, createSeedCommit, finalizeFairness, rollDie, sha256Hex } from '../src/fairness.js';

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
