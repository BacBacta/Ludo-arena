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
  /** R-DICE-1: whether OUR own committed entropy actually appears in the reveal at
   *  our seat. `null` when we can't check (no own entropy supplied — e.g. a replay
   *  of someone else's transcript). A dishonest server that ignored our entropy and
   *  pre-ground the seed would still pass commitOk + every roll, but fail this. */
  ownEntropyOk: boolean | null;
  rolls: RollCheck[];
  allOk: boolean;
}

/** Recompute commit + every recorded roll and compare to what was played. When
 *  `own` is supplied, ALSO verify our own committed entropy is the one bound at our
 *  seat — otherwise the "provably fair" check is blind to a server that silently
 *  dropped our entropy and chose the whole sequence itself (R-DICE-1). */
export async function verifyFairness(
  commit: string,
  reveal: { serverSeed: string; entropies: [string, string] },
  dice: Array<{ index: number; value: number }>,
  own?: { entropy: string; seat: number },
): Promise<FairnessReport> {
  const commitOk = (await sha256Hex(reveal.serverSeed)) === commit;
  const ownEntropyOk = own && own.entropy ? reveal.entropies[own.seat] === own.entropy : null;
  const rolls: RollCheck[] = [];
  for (const d of [...dice].sort((a, b) => a.index - b.index)) {
    const computed = await computeDie(reveal.serverSeed, reveal.entropies, d.index);
    rolls.push({ index: d.index, played: d.value, computed, ok: computed === d.value });
  }
  const allOk = commitOk && ownEntropyOk !== false && rolls.every((r) => r.ok);
  return { commitOk, ownEntropyOk, rolls, allOk };
}
