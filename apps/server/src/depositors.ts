/**
 * Depositor-identity check for the stake gate (R-SETTLE-3, 1v1 and 4p / G-4).
 *
 * An escrow going Active only means the seats are funded — NOT that the matched
 * players funded them. A party that learned the gameId could have deposited into
 * a seat. Playing a mismatched escrow means the winner may not be an on-chain
 * depositor (settle reverts) and the pot is stuck; so the gate voids + cancels a
 * game whose on-chain depositors are not exactly the matched players.
 */

/** True iff the on-chain depositor set equals the expected player set, comparing
 *  order- and case-insensitively (EVM addresses are case-insensitive; seat order
 *  on-chain need not match match order). */
export function sameDepositors(expected: readonly string[], onChain: readonly string[]): boolean {
  if (expected.length !== onChain.length) return false;
  const a = expected.map((w) => w.toLowerCase()).sort();
  const b = onChain.map((w) => w.toLowerCase()).sort();
  return a.every((w, i) => w === b[i]);
}
