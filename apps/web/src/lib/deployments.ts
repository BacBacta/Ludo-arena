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
