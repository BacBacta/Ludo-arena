import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { computeDie, sha256Hex, verifyFairness } from '../src/lib/fairnessVerify';

// Reference implementation copied from apps/server/src/fairness.ts — the
// client verifier must reproduce it exactly.
function serverSha(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
function serverRoll(seed: string, entropies: [string, string], index: number): number {
  const h = serverSha(`${seed}|${entropies[0]}|${entropies[1]}|${index}`);
  return 1 + (parseInt(h.slice(0, 12), 16) % 6);
}

describe('fairnessVerify (E5.1)', () => {
  const seed = randomBytes(32).toString('hex');
  const entropies: [string, string] = [randomBytes(16).toString('hex'), randomBytes(16).toString('hex')];

  it('sha256Hex matches Node crypto', async () => {
    expect(await sha256Hex(seed)).toBe(serverSha(seed));
  });

  it('computeDie matches the server rollDie for many indices', async () => {
    for (let i = 1; i <= 40; i++) {
      expect(await computeDie(seed, entropies, i)).toBe(serverRoll(seed, entropies, i));
    }
  });

  it('verifyFairness passes for genuine rolls', async () => {
    const commit = serverSha(seed);
    const dice = Array.from({ length: 10 }, (_, k) => ({ index: k + 1, value: serverRoll(seed, entropies, k + 1) }));
    const report = await verifyFairness(commit, { serverSeed: seed, entropies }, dice);
    expect(report.commitOk).toBe(true);
    expect(report.allOk).toBe(true);
    expect(report.rolls).toHaveLength(10);
  });

  it('flags a tampered commit', async () => {
    const dice = [{ index: 1, value: serverRoll(seed, entropies, 1) }];
    const report = await verifyFairness('deadbeef', { serverSeed: seed, entropies }, dice);
    expect(report.commitOk).toBe(false);
    expect(report.allOk).toBe(false);
  });

  it('flags a tampered roll', async () => {
    const commit = serverSha(seed);
    const real = serverRoll(seed, entropies, 1);
    const dice = [{ index: 1, value: ((real % 6) + 1) as number }]; // wrong value
    const report = await verifyFairness(commit, { serverSeed: seed, entropies }, dice);
    expect(report.commitOk).toBe(true);
    expect(report.rolls[0]!.ok).toBe(false);
    expect(report.allOk).toBe(false);
  });

  // R-DICE-1: a dishonest server that IGNORES our committed entropy and picks the
  // whole sequence itself would still pass commitOk + every roll (they're all
  // internally consistent with the seed it published). Only the own-entropy check
  // catches it — our real entropy is absent from the reveal at our seat.
  it('flags a reveal that dropped our own entropy (own-entropy grinding)', async () => {
    const commit = serverSha(seed);
    // The server pre-ground the seed with ITS OWN entropy at seat 0, not ours.
    const forged: [string, string] = [randomBytes(16).toString('hex'), entropies[1]];
    const dice = Array.from({ length: 5 }, (_, k) => ({ index: k + 1, value: serverRoll(seed, forged, k + 1) }));
    const report = await verifyFairness(commit, { serverSeed: seed, entropies: forged }, dice, { entropy: entropies[0], seat: 0 });
    expect(report.commitOk).toBe(true); // seed matches the commit…
    expect(report.rolls.every((r) => r.ok)).toBe(true); // …and every roll is self-consistent…
    expect(report.ownEntropyOk).toBe(false); // …but OUR entropy was never used
    expect(report.allOk).toBe(false); // so verification correctly FAILS
  });

  it('confirms our own entropy when the server bound it honestly', async () => {
    const commit = serverSha(seed);
    const dice = [{ index: 1, value: serverRoll(seed, entropies, 1) }];
    const report = await verifyFairness(commit, { serverSeed: seed, entropies }, dice, { entropy: entropies[0], seat: 0 });
    expect(report.ownEntropyOk).toBe(true);
    expect(report.allOk).toBe(true);
  });

  it('leaves ownEntropyOk null when we cannot check (no own entropy)', async () => {
    const commit = serverSha(seed);
    const dice = [{ index: 1, value: serverRoll(seed, entropies, 1) }];
    const report = await verifyFairness(commit, { serverSeed: seed, entropies }, dice);
    expect(report.ownEntropyOk).toBeNull();
    expect(report.allOk).toBe(true); // can't check → don't spuriously fail a replay
  });
});
