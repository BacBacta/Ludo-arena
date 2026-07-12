/**
 * Provably fair dice (commit-reveal).
 * Before the game: commit = sha256(serverSeed) is sent to both clients.
 * Die #i = 1 + (first 6 bytes of sha256(serverSeed|entropyA|entropyB|i)) % 6.
 * At game end, serverSeed is revealed: anyone can recompute everything.
 *
 * KNOWN LIMITATION (audit HIGH-1 — not grinding-resistant): `createFairness`
 * runs at startGame, AFTER both players' entropy arrived in `hello`. Because the
 * house knows entropyA+entropyB before it picks/commits serverSeed, a malicious
 * operator could brute-force serverSeed to bias the sequence, then publish a
 * matching commit. Players can verify reveal==commit but cannot detect grinding.
 * The house's rake is outcome-neutral (limited motive), but before REAL-MONEY
 * launch this needs a true fix: players commit to their entropy first, the
 * server commits serverSeed, THEN players reveal — so no party sees the others'
 * inputs before committing. That is a protocol change (hello.entropyCommit +
 * a reveal step) and must land with the client verifier + tests together.
 * Tracked: do NOT ship mainnet stakes until closed.
 */
import { createHash, randomBytes } from 'node:crypto';

export interface Fairness {
  serverSeed: string;
  commit: string;
  entropies: [string, string];
}

export function createFairness(entropyA: string, entropyB: string): Fairness {
  const serverSeed = randomBytes(32).toString('hex');
  const commit = sha256Hex(serverSeed);
  return { serverSeed, commit, entropies: [entropyA, entropyB] };
}

export function rollDie(f: Fairness, index: number): number {
  const h = sha256Hex(`${f.serverSeed}|${f.entropies[0]}|${f.entropies[1]}|${index}`);
  const n = parseInt(h.slice(0, 12), 16); // 48 bits, negligible bias on %6
  return 1 + (n % 6);
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
