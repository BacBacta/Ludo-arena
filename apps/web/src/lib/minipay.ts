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
import { deploymentForChain, racePassFor } from './deployments';
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

/** Minimal EIP-1193 provider shape viem's `custom()` transport needs. Both the
 *  injected wallet (window.ethereum) and a WalletConnect provider satisfy it. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** Builds a Wallet on the active chain from ANY EIP-1193 provider (injected or
 *  WalletConnect). Returns null when the provider yields no account. */
export async function connectWalletWith(provider: Eip1193Provider): Promise<Wallet | null> {
  const walletClient = createWalletClient({ chain: activeChain, transport: custom(provider) });
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

/** Connects the injected wallet on the active chain. null when none is present. */
export async function connectWallet(): Promise<Wallet | null> {
  if (!window.ethereum) return null;
  return connectWalletWith(window.ethereum);
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
  fairnessCommit: string,
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
    fairnessCommit,
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
  fairnessCommit: string,
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
    fairnessCommit,
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

/** RacePass (soulbound event entry NFT) — mint() is free + once per address;
 *  passOf reads the holder's tokenId (0 = none) so we never re-send a mint that
 *  would revert AlreadyMinted. */
const RACE_PASS_ABI = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'passOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

/**
 * Ensure the connected wallet is on the app's active chain (Celo Sepolia). A plain
 * browser wallet (WalletConnect / MetaMask) is usually on some OTHER network, so a
 * tx built for the active chain would just fail "wrong chain". Prompt the wallet to
 * switch — and if it doesn't know the chain yet (a new testnet), add it first, then
 * switch. Skipped for MiniPay (it manages its own network and has no switch RPC).
 * Throws WRONG_CHAIN:<current>:<wanted> when the user declines, so the caller can
 * show a precise "switch to Celo Sepolia" message instead of a raw viem error.
 */
export async function ensureActiveChain(wallet: Wallet): Promise<void> {
  if (isMiniPay()) return;
  let current: number;
  try {
    current = await wallet.walletClient.getChainId();
  } catch {
    return; // can't read the chain → let the tx surface the real error
  }
  if (current === activeChain.id) return;
  try {
    await wallet.walletClient.switchChain({ id: activeChain.id });
  } catch {
    // 4902 / unrecognised chain → add Celo Sepolia (rpc + explorer + CELO), then switch.
    try {
      await wallet.walletClient.addChain({ chain: activeChain });
      await wallet.walletClient.switchChain({ id: activeChain.id });
    } catch {
      throw new Error(`WRONG_CHAIN:${current}:${activeChain.id}`);
    }
  }
}

/**
 * Mint the caller's Race Week Pass (the anti-sybil event entry): a free, soulbound
 * ERC-721, one per wallet. Returns the mint tx hash to hand to the server, which
 * verifies the Minted event before funding the stake quota. Throws if the RacePass
 * isn't deployed on the connected chain (the caller only calls this when the server
 * reports the event armed). Under MiniPay, gas is paid in the stake token (legacy tx).
 */
export async function mintRacePass(wallet: Wallet): Promise<Hex> {
  await ensureActiveChain(wallet); // switch/add Celo Sepolia before the tx
  const chainId = wallet.walletClient.chain?.id ?? activeChain.id;
  const racePass = racePassFor(chainId);
  if (!racePass) throw new Error(`No RacePass deployment for chain ${chainId}`);
  const dep = deploymentForChain(chainId);
  const chain = wallet.walletClient.chain ?? null;
  const signer = wallet.walletClient.account ?? wallet.address;
  // MiniPay legacy-tx gas is paid in the stake token; browsers pay the native coin.
  const extra = isMiniPay() && dep ? { feeCurrency: dep.stablecoin } : {};
  const hash = await wallet.walletClient.writeContract({
    account: signer,
    chain,
    address: racePass,
    abi: RACE_PASS_ABI,
    functionName: 'mint',
    ...extra,
  });
  const r = await wallet.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('race pass mint reverted');
  return hash;
}

/** The caller's RacePass tokenId on the connected chain (0 = not minted yet), or
 *  null when the RacePass isn't deployed there. Lets the join flow skip a mint that
 *  would revert (AlreadyMinted) and reuse a prior-session mint tx instead. */
export async function racePassTokenId(wallet: Wallet): Promise<bigint | null> {
  const chainId = wallet.walletClient.chain?.id ?? activeChain.id;
  const racePass = racePassFor(chainId);
  if (!racePass) return null;
  return wallet.publicClient.readContract({ address: racePass, abi: RACE_PASS_ABI, functionName: 'passOf', args: [wallet.address] }) as Promise<bigint>;
}

/** Wallet stake-token balance in USD cents, or null if the chain has no deployment. */
export async function walletBalanceCents(wallet: Wallet): Promise<number | null> {
  const chainId = wallet.walletClient.chain?.id ?? activeChain.id;
  const dep = deploymentForChain(chainId);
  if (!dep) return null;
  return tokenBalanceCents(wallet.publicClient, dep.stablecoin, wallet.address);
}
