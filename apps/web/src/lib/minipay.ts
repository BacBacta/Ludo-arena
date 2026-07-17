/**
 * MiniPay wallet integration via viem.
 * Official constraints: LEGACY transactions only, cUSD feeCurrency,
 * cUSD/USDC/USDT stablecoins. See docs/ARCHITECTURE.md §MiniPay.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { activeChain } from './chains';
import { deploymentForChain } from './deployments';
import { assertServerEscrow } from './settlementGuard';
import { buyCosmeticCusd, stakeInEscrow, stakeInEscrowN, tokenBalanceCents, type StakeStatus } from './escrow';
import type { Hex } from 'viem';

declare global {
  interface Window {
    ethereum?: {
      isMiniPay?: boolean;
      request(args: { method: string; params?: unknown[] }): Promise<unknown>;
    };
  }
}

export const STABLES = {
  celo: {
    cUSD: '0x765DE816845861e75A25fCA122bb6898B8B1282a' as Address,
    USDC: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as Address,
    USDT: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' as Address,
  },
  alfajores: {
    cUSD: '0x874069Fa1Eb16D44d622F2e0Ca25eeA172369bC1' as Address,
  },
} as const;

export function isMiniPay(): boolean {
  return Boolean(window.ethereum?.isMiniPay);
}

export function hasInjectedWallet(): boolean {
  return Boolean(window.ethereum);
}

export interface Wallet {
  walletClient: WalletClient;
  publicClient: PublicClient;
  address: Address;
}

/** Connects the injected wallet on the active chain. null when none is present. */
export async function connectWallet(): Promise<Wallet | null> {
  if (!window.ethereum) return null;
  const walletClient = createWalletClient({ chain: activeChain, transport: custom(window.ethereum) });
  const [address] = await walletClient.requestAddresses();
  if (!address) return null;
  const publicClient = createPublicClient({ chain: activeChain, transport: http() });
  // Celo chains add custom tx/block formatters, so the inferred client types
  // diverge from viem's plain Wallet/PublicClient; flatten at this boundary.
  return {
    walletClient: walletClient as unknown as WalletClient,
    publicClient: publicClient as unknown as PublicClient,
    address,
  };
}

/**
 * Locks the stake in LudoEscrow for `gameId` (approve + join). Under MiniPay,
 * gas is paid in cUSD via a legacy tx (feeCurrency). Resolves the escrow +
 * token from deployments.json for the connected chain.
 */
export async function lockStake(
  wallet: Wallet,
  gameId: string,
  stakeCents: number,
  onStatus?: (s: StakeStatus) => void,
): Promise<void> {
  const chainId = wallet.walletClient.chain?.id ?? activeChain.id;
  const dep = deploymentForChain(chainId);
  if (!dep) throw new Error(`No LudoEscrow deployment for chain ${chainId}`);
  // Refuse to deposit into an escrow the server will not settle (G-2).
  assertServerEscrow(chainId, dep.escrow, '1v1');
  await stakeInEscrow({
    walletClient: wallet.walletClient,
    publicClient: wallet.publicClient,
    account: wallet.address,
    escrow: dep.escrow,
    token: dep.stablecoin,
    gameId,
    stakeCents,
    // MiniPay pays gas in cUSD; on Celo Sepolia the stake token doubles as gas token
    feeCurrency: isMiniPay() ? dep.stablecoin : undefined,
    onStatus,
  });
}

/**
 * Locks the per-seat stake in LudoEscrowN for a 4-player staked table (approve +
 * join with seatCount=4). Throws if the N-player escrow isn't deployed on the
 * connected chain (staked 4-player stays off until then).
 */
export async function lockStake4(
  wallet: Wallet,
  gameId: string,
  stakeCents: number,
  onStatus?: (s: StakeStatus) => void,
): Promise<void> {
  const chainId = wallet.walletClient.chain?.id ?? activeChain.id;
  const dep = deploymentForChain(chainId);
  if (!dep?.escrowN) throw new Error(`No LudoEscrowN deployment for chain ${chainId}`);
  // Refuse to deposit into an escrow the server will not settle (G-2).
  assertServerEscrow(chainId, dep.escrowN, '4p');
  await stakeInEscrowN({
    walletClient: wallet.walletClient,
    publicClient: wallet.publicClient,
    account: wallet.address,
    escrow: dep.escrowN,
    token: dep.stablecoin,
    gameId,
    stakeCents,
    seatCount: 4,
    feeCurrency: isMiniPay() ? dep.stablecoin : undefined,
    onStatus,
  });
}

/**
 * Buys a cosmetic with cUSD via the CosmeticsStore (rec 6): approve + buy(itemId),
 * paid straight to the treasury. Throws if the store isn't deployed on the
 * connected chain (cUSD cosmetics stay off until then). Returns the buy tx hash
 * to hand to the server for the ownership claim.
 */
export async function buyCosmetic(
  wallet: Wallet,
  id: string,
  priceCents: number,
  onStatus?: (s: StakeStatus) => void,
): Promise<{ buyTxHash: Hex; approveTx?: Hex }> {
  const chainId = wallet.walletClient.chain?.id ?? activeChain.id;
  const dep = deploymentForChain(chainId);
  if (!dep?.cosmeticsStore) throw new Error(`No CosmeticsStore deployment for chain ${chainId}`);
  return buyCosmeticCusd({
    walletClient: wallet.walletClient,
    publicClient: wallet.publicClient,
    account: wallet.address,
    store: dep.cosmeticsStore,
    token: dep.stablecoin,
    id,
    priceCents,
    feeCurrency: isMiniPay() ? dep.stablecoin : undefined,
    onStatus,
  });
}

/** Wallet stake-token balance in USD cents, or null if the chain has no deployment. */
export async function walletBalanceCents(wallet: Wallet): Promise<number | null> {
  const chainId = wallet.walletClient.chain?.id ?? activeChain.id;
  const dep = deploymentForChain(chainId);
  if (!dep) return null;
  return tokenBalanceCents(wallet.publicClient, dep.stablecoin, wallet.address);
}
