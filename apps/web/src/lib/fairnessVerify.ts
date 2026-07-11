/**
 * Client-side verification of the provably-fair dice (E5.1).
 * Mirrors the server (apps/server/src/fairness.ts) using WebCrypto so a player
 * can independently recompute every roll from the revealed seed:
 *   commit = sha256(serverSeed)
 *   die #i = 1 + (first 12 hex of sha256(seed|entropyA|entropyB|i)) % 6
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function computeDie(seed: string, entropies: [string, string], index: number): Promise<number> {
  const h = await sha256Hex(`${seed}|${entropies[0]}|${entropies[1]}|${index}`);
  return 1 + (parseInt(h.slice(0, 12), 16) % 6); // 48 bits, matches the server
}

export interface RollCheck {
  index: number;
  played: number;
  computed: number;
  ok: boolean;
}

export interface FairnessReport {
  commitOk: boolean;
  rolls: RollCheck[];
  allOk: boolean;
}

/** Recompute commit + every recorded roll and compare to what was played. */
export async function verifyFairness(
  commit: string,
  reveal: { serverSeed: string; entropies: [string, string] },
  dice: Array<{ index: number; value: number }>,
): Promise<FairnessReport> {
  const commitOk = (await sha256Hex(reveal.serverSeed)) === commit;
  const rolls: RollCheck[] = [];
  for (const d of [...dice].sort((a, b) => a.index - b.index)) {
    const computed = await computeDie(reveal.serverSeed, reveal.entropies, d.index);
    rolls.push({ index: d.index, played: d.value, computed, ok: computed === d.value });
  }
  return { commitOk, rolls, allOk: commitOk && rolls.every((r) => r.ok) };
}
