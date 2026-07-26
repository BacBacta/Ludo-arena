/**
 * Race Week entry decisions — pure, so the wallet-identity rules that burnt us
 * are unit-tested. THE BUG CLASS: outside MiniPay the entry silently used the
 * app burner whatever the player had connected, so "I connected a NEW MetaMask
 * address" changed nothing — same burner, same grant record, "already funded".
 * And the boot path re-installed the burner even when the player had explicitly
 * switched to their own wallet, which is why "the old wallet keeps coming back".
 *
 * The rules now:
 *   • MiniPay          → the ambient wallet (unchanged).
 *   • explicit switch  → THEIR wallet: the entry follows the CONNECTED address,
 *                        so a different address is a different entry. Its gas is
 *                        native CELO (no CIP-64 outside our own tx construction),
 *                        sponsored by the server's native seed.
 *   • default          → the app burner (gas in cUSD), unchanged.
 */
import type { Address } from 'viem';

export type RaceEntryWalletKind = 'ambient' | 'external' | 'burner';

/** Which wallet carries the Race entry. `prefersExternal` is the player's
 *  explicit TopBar switch — nothing else may flip the entry off the burner. */
export function raceEntryWalletKind(miniPay: boolean, prefersExternal: boolean): RaceEntryWalletKind {
  if (miniPay) return 'ambient';
  return prefersExternal ? 'external' : 'burner';
}

/** True when `addr` IS the app burner — the external path must drop a lingering
 *  burner from the wallet ref before pairing, else "already connected" short-
 *  circuits the connect and the entry lands on the burner again. Null-safe:
 *  unknown addresses are NOT the burner (never block on a failed read). */
export function isBurnerAddress(addr: string | undefined, burnerAddr: Address | null): boolean {
  if (!addr || !burnerAddr) return false;
  return addr.toLowerCase() === burnerAddr.toLowerCase();
}

/** Boot-time rule: restore the persisted burner ONLY when the player has not
 *  explicitly switched to their own wallet. Restoring it anyway is what made
 *  "the old wallet" reappear on every reload in external mode. (MiniPay never
 *  restores a burner — its wallet is ambient.) */
export function shouldRestoreBurnerAtBoot(miniPay: boolean, prefersExternal: boolean): boolean {
  return !miniPay && !prefersExternal;
}

/** Native-CELO floor under which we do NOT let an external wallet attempt the
 *  mint: ~2× a generous mint reservation (250k gas × 400 gwei ≈ 1e-4 CELO), and
 *  well under the 0.002 CELO sponsorship target so a sponsored wallet always
 *  clears it. Denominated in wei. */
export const MIN_MINT_GAS_NATIVE_WEI = 200_000_000_000_000n; // 0.0002 CELO

/** Should the mint be blocked for lack of gas? Each gas mode checks ITS OWN
 *  balance — the cUSD floor means nothing to a MetaMask wallet (its gas is
 *  native) and vice-versa. A null balance is a failed READ, not an empty
 *  wallet: fail OPEN and let the mint try (its own errors are precise). */
export function mintBlockedOnGas(
  payGasInStable: boolean,
  stableCents: number | null,
  minStableCents: number,
  nativeWei: bigint | null,
  minNativeWei: bigint = MIN_MINT_GAS_NATIVE_WEI,
): boolean {
  if (payGasInStable) return stableCents !== null && stableCents < minStableCents;
  return nativeWei !== null && nativeWei < minNativeWei;
}

/** The address the entry must run on: the wallet app's ACTIVE account when it
 *  differs from the one paired earlier. MetaMask signs with its active account
 *  whatever `from` the dapp announces — a player who switched accounts after
 *  pairing got the seed on address A and a mint popup signing with address B
 *  ("Awale owner 1", 0 CELO, blocked on fees). Following the active account at
 *  tap time keeps the seeded address and the signing address the same one.
 *  An unreadable active account (undefined) keeps the paired address. */
export function entrySigningAddress<T extends string>(paired: T, active: T | undefined): T {
  return active && active.toLowerCase() !== paired.toLowerCase() ? active : paired;
}

/** Which toast a race.claimed ack deserves. `selfFunded` (new) marks a FIRST
 *  registration that drew nothing because the wallet already covers a stake —
 *  telling that player "already funded" read as a refusal (the operator's own
 *  report while testing fresh addresses). */
export function raceClaimToastKey(alreadyFunded: boolean, selfFunded?: boolean): 'raceSelfFunded' | 'raceAlreadyFunded' | 'raceFunded' {
  if (selfFunded) return 'raceSelfFunded';
  return alreadyFunded ? 'raceAlreadyFunded' : 'raceFunded';
}
