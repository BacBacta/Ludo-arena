/**
 * Provably fair dice (commit-reveal).
 * Before the game: commit = sha256(serverSeed) is sent to both clients.
 * Die #i = 1 + (first 6 bytes of sha256(serverSeed|entropyA|entropyB|i)) % 6.
 * At game end, serverSeed is revealed: anyone can recompute everything.
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
