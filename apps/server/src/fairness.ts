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

/** Legacy path (a client that still sends raw entropy in hello): the server
 *  already knows both entropies here, so this is the grindable flow — kept only
 *  for backward compatibility during a deploy. */
export function createFairness(entropyA: string, entropyB: string): Fairness {
  const serverSeed = randomBytes(32).toString('hex');
  const commit = sha256Hex(serverSeed);
  return { serverSeed, commit, entropies: [entropyA, entropyB] };
}

/**
 * Anti-grinding commit-reveal, step 1: the server generates its seed and its
 * commit knowing ONLY the players' entropy COMMITS (hashes) — not the values —
 * so it cannot brute-force serverSeed to bias the sequence. Published in
 * match.found; the players then reveal their raw entropy (verified against their
 * hello commit) before the game is finalized.
 */
export function createSeedCommit(): { serverSeed: string; commit: string } {
  const serverSeed = randomBytes(32).toString('hex');
  return { serverSeed, commit: sha256Hex(serverSeed) };
}

/** Step 2: bind the (already-committed) seed to the now-revealed entropies. */
export function finalizeFairness(serverSeed: string, commit: string, entropyA: string, entropyB: string): Fairness {
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

// ---- 4-player fairness (ticket games) ------------------------------------
// v1: dice = H(serverSeed | seat0seed | … | seatNseed | index). serverSeed is
// committed at match and revealed at game over so anyone can recompute. Each
// seat contributes its hello entropyCommit (humans) or a server-random value
// (bots). NOTE: like the 2-player legacy path this is verifiable but not fully
// grinding-resistant (the server sees the seat seeds before committing). That's
// acceptable for TICKET games (no real money); the full commit-reveal lands if
// 4-player ever takes real cUSD.

export interface Fairness4 {
  serverSeed: string;
  commit: string;
  seeds: string[]; // per-seat contribution
}

export function createFairness4(seatSeeds: string[]): Fairness4 {
  const serverSeed = randomBytes(32).toString('hex');
  return { serverSeed, commit: sha256Hex(serverSeed), seeds: [...seatSeeds] };
}

export function rollDie4(f: Fairness4, index: number): number {
  const h = sha256Hex(`${f.serverSeed}|${f.seeds.join('|')}|${index}`);
  return 1 + (parseInt(h.slice(0, 12), 16) % 6);
}

/** A random per-seat seed for a bot (or a human with no entropy). */
export function randomSeatSeed(): string {
  return randomBytes(16).toString('hex');
}
