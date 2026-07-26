/**
 * MiniPay wallet integration via viem.
 * Official constraints: LEGACY transactions only, cUSD feeCurrency,
 * cUSD/USDC/USDT stablecoins. See docs/ARCHITECTURE.md §MiniPay.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { activeChain, chainTransport } from './chains';
import { deploymentForChain, feeCurrencyFor, racePassFor } from './deployments';
import { assertServerEscrow } from './settlementGuard';
import { buyCosmeticCusd, feeCurrencyBudgetWei, planFeeExtras, stakeInEscrow, stakeInEscrowN, tokenBalanceCents, type StakeStatus } from './escrow';
import { BALANCED, classifyTxFailure, InsufficientGasBudgetError, nextFeePlan, type FeePlan } from './feePlan';
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
  /** Whether this wallet's txs should pay gas in the stablecoin (Celo feeCurrency)
   *  instead of native CELO. True when WE control tx construction — MiniPay (which
   *  mandates it) and the app-minted burner (B1) — so the player never needs CELO.
   *  False for an external wallet (MetaMask/WalletConnect) that builds its own txs
   *  and can't be told to use feeCurrency → it pays in the native coin. */
  payGasInStable: boolean;
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
  // Celo mines ~1s blocks; viem's default 4s receipt polling quadruples the
  // wait on every approve/join — the bulk of the paired-players' staking lag.
  // chainTransport: forno + public fallbacks — forno alone rate-limits the
  // exact devices that retry the most (see chains.ts).
  const publicClient = createPublicClient({ chain: activeChain, transport: chainTransport(), pollingInterval: 1_000 });
  // Celo chains add custom tx/block formatters, so the inferred client types
  // diverge from viem's plain Wallet/PublicClient; flatten at this boundary.
  return {
    walletClient: walletClient as unknown as WalletClient,
    publicClient: publicClient as unknown as PublicClient,
    address,
    // MiniPay's injected provider pays gas in cUSD; a plain external wallet does not.
    payGasInStable: isMiniPay(),
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
    // Gas paid in stable (MiniPay / burner): the fee-currency ADAPTER for a 6-dec
    // stake token (USD₮), or the stake token itself when it's 18-dec (cUSD).
    feeCurrency: wallet.payGasInStable ? feeCurrencyFor(dep) : undefined,
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
    feeCurrency: wallet.payGasInStable ? feeCurrencyFor(dep) : undefined,
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
    feeCurrency: wallet.payGasInStable ? feeCurrencyFor(dep) : undefined,
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
  // Gas in cUSD when we control tx construction (MiniPay or the burner); a plain
  // external wallet builds its own tx and pays the native coin. Same fee policy
  // as the escrow lock (see feePlan.ts): explicit cap from the fresh native base
  // fee + explicit gas from a FEE-LESS estimate — fee fields in the estimation
  // request made the node apply a NATIVE-balance affordability cap, 0 for a
  // burner ("gas required exceeds allowance (0)").
  const feeCurrency = wallet.payGasInStable && dep ? feeCurrencyFor(dep) : undefined;
  const localSigner = !!wallet.walletClient.account;
  // THE BUDGET. This is the FIRST tx a new player ever sends, from the THINNEST
  // wallet in the app — a burner holding a 10c gas seed and nothing else. Two
  // silent degradations of the fee-floor read (no eth_gasPrice quote → the
  // conservative 215x conversion direction; no directory → the native base fee)
  // build a cap whose RESERVATION is 150c / 10.3c against that seed. Every
  // attempt then died on funds and the player was told their "entry is still
  // being funded" — forever, because the failure is deterministic. Handing the
  // balance to planFeeExtras lets it clamp the cap to what can actually mine,
  // and refuse outright (with real numbers) when nothing can.
  // MiniPay prices its own gas, so the budget only applies to a local signer.
  const budgetWei = feeCurrency && localSigner
    ? await feeCurrencyBudgetWei(wallet.publicClient, feeCurrency, wallet.address)
    : null;

  // Same ladder as the escrow lock (feePlan.ts): a single BALANCED attempt has
  // no answer to a base-fee spike or a degraded floor read, and the mint used to
  // be the ONE burner tx without it.
  let plan: FeePlan = BALANCED;
  let lastError: unknown;
  let hash: Hex | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      // The previous attempt may have MINED while its receipt was lost. The Pass
      // is soulbound and one-per-wallet, so re-minting would revert: if it
      // landed, hand back that tx instead of burning the seed again.
      const minted = await (wallet.publicClient.readContract({ address: racePass, abi: RACE_PASS_ABI, functionName: 'passOf', args: [wallet.address] }) as Promise<bigint>).catch(() => 0n);
      if (minted > 0n && hash) return hash;
    }
    try {
      const extras = await planFeeExtras(wallet.publicClient, feeCurrency, plan, {
        address: racePass,
        abi: RACE_PASS_ABI,
        functionName: 'mint',
        args: [],
        account: signer,
      }, localSigner, budgetWei);
      hash = await wallet.walletClient.writeContract({
        account: signer,
        chain,
        address: racePass,
        abi: RACE_PASS_ABI,
        functionName: 'mint',
        ...extras,
      });
      const r = await wallet.publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== 'success') throw new Error('race pass mint reverted');
      return hash;
    } catch (e) {
      // No cap can both clear the base fee and fit the balance — more attempts
      // only burn what little is left. Surface the numbers instead.
      if (e instanceof InsufficientGasBudgetError) throw e;
      lastError = e;
      plan = nextFeePlan(plan, classifyTxFailure(e));
    }
  }
  throw lastError;
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

/** Wallet NATIVE CELO balance in wei, or null on a failed read. The gas gauge
 *  for EXTERNAL wallets (MetaMask/WC): their txs pay gas in the native coin, so
 *  the stablecoin balance says nothing about whether they can mint. */
export async function walletNativeWei(wallet: Wallet): Promise<bigint | null> {
  try {
    return await wallet.publicClient.getBalance({ address: wallet.address });
  } catch {
    return null;
  }
}

/** Wallet stake-token balance in USD cents, or null if the chain has no deployment. */
export async function walletBalanceCents(wallet: Wallet): Promise<number | null> {
  const chainId = wallet.walletClient.chain?.id ?? activeChain.id;
  const dep = deploymentForChain(chainId);
  if (!dep) return null;
  return tokenBalanceCents(wallet.publicClient, dep.stablecoin, wallet.address);
}
