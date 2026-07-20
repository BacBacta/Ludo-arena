/**
 * On-chain addresses per network, sourced from the single source of truth
 * written by the deploy script (packages/contracts/deployments.json).
 */
import type { Address } from 'viem';
// Vendored copy of packages/contracts/deployments.json (kept in sync by the
// deploy script) so the web build has no dependency on the contracts workspace.
import raw from '../deployments.json';

export interface Deployment {
  chainId: number;
  escrow: Address;
  /** N-player escrow (LudoEscrowN) for staked 4-player games; absent until deployed. */
  escrowN?: Address;
  /** CosmeticsStore (cUSD cosmetic purchases → treasury); absent until deployed. */
  cosmeticsStore?: Address;
  /** RacePass (soulbound event entry NFT); absent until the Race Week deploy. */
  racePass?: Address;
  stablecoin: Address;
  arbiter: Address;
  treasury: Address;
  rakeBps: number;
}

const deployments = raw as Record<string, Deployment>;

/** Deployment for a chainId, or null when the contracts are not deployed there. */
export function deploymentForChain(chainId: number): Deployment | null {
  return Object.values(deployments).find((d) => d.chainId === chainId) ?? null;
}

/** True once LudoEscrowN is deployed somewhere → staked 4-player can be offered.
 *  Until then the 4-player table stays free (no wallet prompt, no "coming soon"). */
export const staked4Available = Object.values(deployments).some((d) => !!d.escrowN);

/** CosmeticsStore address for a chain, or null until it's deployed there. */
export function cosmeticsStoreFor(chainId: number): Address | null {
  return Object.values(deployments).find((d) => d.chainId === chainId)?.cosmeticsStore ?? null;
}

/** True once the CosmeticsStore is deployed → cosmetics can be bought with cUSD.
 *  Until then the store shows ticket unlocks only and cUSD buttons stay "soon". */
export const cosmeticsCusdAvailable = Object.values(deployments).some((d) => !!d.cosmeticsStore);

/** RacePass address for a chain, or null until the Race Week deploy lands there.
 *  The client only ever mints when the server also reports the event as armed
 *  (hello.ok race.active), so this is a client-side guard for the mint tx path. */
export function racePassFor(chainId: number): Address | null {
  return Object.values(deployments).find((d) => d.chainId === chainId)?.racePass ?? null;
}
