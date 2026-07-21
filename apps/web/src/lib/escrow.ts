/**
 * LudoEscrow interaction from the client (BACKLOG E3.2).
 * Transport-agnostic: the caller passes a viem WalletClient (MiniPay custom
 * transport in the app, an http+key client in the verify script). Under
 * MiniPay, pass `feeCurrency` to pay gas in cUSD with a legacy tx.
 */
import { keccak256, pad, toBytes, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { BALANCED, classifyTxFailure, nextFeePlan, planCapWei, planGasLimit, type FeePlan } from './feePlan';

export const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

export const ESCROW_ABI = [
  { type: 'function', name: 'join', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }, { name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' }, { name: 'fairnessCommit', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'refundExpired', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }], outputs: [] },
  {
    type: 'function', name: 'games', stateMutability: 'view', inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'stake', type: 'uint96' },
      { name: 'playerA', type: 'address' },
      { name: 'playerB', type: 'address' },
      { name: 'createdAt', type: 'uint40' },
      { name: 'status', type: 'uint8' },
      // rakeBps (7th field on the hardened contract) omitted on purpose — unused here,
      // and a 6-output ABI decodes fine against both the 6- and 7-field getters.
    ],
  },
] as const;

/** LudoEscrowN (N-player) — join takes seatCount; seatsOf lists the depositors. */
export const ESCROW_N_ABI = [
  { type: 'function', name: 'join', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }, { name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' }, { name: 'seatCount', type: 'uint8' }, { name: 'fairnessCommit', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'seatsOf', stateMutability: 'view', inputs: [{ name: 'gameId', type: 'bytes32' }], outputs: [{ name: '', type: 'address[]' }] },
] as const;

/** CosmeticsStore — buy(itemId) pulls the cUSD price straight to the treasury. */
export const COSMETICS_STORE_ABI = [
  { type: 'function', name: 'buy', stateMutability: 'nonpayable', inputs: [{ name: 'itemId', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'priceOf', stateMutability: 'view', inputs: [{ name: '', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
] as const;

/** keccak256(bytes(id)) — the CosmeticsStore itemId for a cosmetic id (matches server). */
export function cosmeticItemId(id: string): Hex {
  return keccak256(toBytes(id));
}

/**
 * The server gameId is 16 random bytes (32 hex chars); the contract keys on
 * bytes32. Left-pad to 32 bytes — canonical, so E3.3 server settlement signs
 * the exact same value.
 */
/** The fairness commit (sha256 hex from match.found) as a bytes32 for `join`. */
export function commitToBytes32(commit: string): Hex {
  const hex = commit.startsWith('0x') ? commit.slice(2) : commit;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`fairnessCommit is not a 32-byte hex value, cannot stake: ${commit}`);
  }
  return `0x${hex}` as Hex;
}

export function gameIdToBytes32(gameId: string): Hex {
  const hex = gameId.startsWith('0x') ? gameId.slice(2) : gameId;
  if (!/^[0-9a-fA-F]{1,64}$/.test(hex)) {
    throw new Error(`gameId is not hex, cannot stake on-chain: ${gameId}`);
  }
  return pad(`0x${hex}` as Hex, { size: 32 });
}

/** USD cents → token base units (e.g. 25 cents, 18 decimals → 0.25e18). */
export function stakeUnits(stakeCents: number, decimals: number): bigint {
  if (decimals < 2) throw new Error('token decimals < 2 unsupported');
  return BigInt(stakeCents) * 10n ** BigInt(decimals - 2);
}

export type StakeStatus = 'approving' | 'joining' | 'locked';

export interface StakeParams {
  walletClient: WalletClient;
  publicClient: PublicClient;
  account: Address;
  escrow: Address;
  token: Address;
  gameId: string;
  stakeCents: number;
  /** Dice fairness commit (sha256(serverSeed) hex) from match.found — anchored
   *  on-chain at join so the reveal at settlement is publicly verifiable. */
  fairnessCommit: string;
  /** cUSD address for MiniPay legacy-tx gas; omit to pay in the native coin. */
  feeCurrency?: Address;
  onStatus?: (status: StakeStatus) => void;
  /** Wait before the single retry of a failed lock attempt (tests pass 0). */
  retryDelayMs?: number;
}

/** A wallet-prompt refusal (EIP-1193 4001 / "user rejected") — the ONE failure
 *  a lock retry must never repeat: retrying re-pops the wallet prompt at a user
 *  who just said no. Everything else (stale-node estimation revert, a mined
 *  revert, a lost receipt) is transient and money-safe to retry — a revert moves
 *  no funds, and each attempt re-checks the escrow before sending. */
function isUserRejection(e: unknown): boolean {
  return (e as { code?: number })?.code === 4001 || /user (rejected|denied)/i.test(String((e as Error)?.message ?? ''));
}

export interface StakeReceipt {
  gameId32: Hex;
  stake: bigint;
  approveTx?: Hex;
  joinTx: Hex;
}

/** An explicit `maxFeePerGas` for a feeCurrency tx: baseFee×multiplier + priority.
 *  Derived from the NATIVE base fee (getBlock().baseFeePerGas), so it is ALWAYS
 *  >= the base fee the node validates against — which is the whole point. Pure so
 *  the margin math is unit-testable without a chain. */
export function feeCapWei(baseFeePerGas: bigint, multiplier: bigint, priorityWei: bigint): bigint {
  return baseFeePerGas * multiplier + priorityWei;
}

/** Base-fee margin + priority floor for the explicit cap. 3× absorbs a sharp
 *  Celo base-fee spike between estimate and mine; EIP-1559 still charges only
 *  (base + priority) and refunds the rest of the cap, so a wide cap never
 *  overpays — it only stops the under-cap rejection. */
const FEE_MULTIPLIER = 3n;
const PRIORITY_FEE_WEI = 2_000_000_000n; // 2 gwei

/**
 * The tx overrides for a `feeCurrency` (gas-in-cUSD) transaction: `{}` when no
 * feeCurrency (pay in the native coin), else `{ feeCurrency, maxFeePerGas,
 * maxPriorityFeePerGas }` with an EXPLICIT cap.
 *
 * Why explicit (this reverses an earlier "let viem estimate" stance): under a
 * Celo base-fee spike viem's estimate for a feeCurrency (CIP-64) tx landed BELOW
 * the block base fee and the node rejected it ("the fee cap (maxFeePerGas gwei)
 * cannot be lower than the block base fee"). The earlier failed attempt derived a
 * cap from `eth_gasPrice(token)` — token-denominated, far below the native base
 * fee. We instead read the fresh NATIVE base fee (getBlock().baseFeePerGas) and
 * set baseFee×3 + priority, which is >= the base fee BY CONSTRUCTION, so it always
 * clears the check regardless of viem's estimator. Falls back to `{ feeCurrency }`
 * (viem estimate) only if the block read fails.
 */
export async function feeCurrencyExtra(
  _walletClient: WalletClient,
  publicClient: PublicClient,
  feeCurrency?: Address,
): Promise<Record<string, unknown>> {
  if (!feeCurrency) return {};
  try {
    const block = await publicClient.getBlock({ blockTag: 'latest' });
    const baseFee = block.baseFeePerGas ?? 0n;
    return {
      feeCurrency,
      maxFeePerGas: feeCapWei(baseFee, FEE_MULTIPLIER, PRIORITY_FEE_WEI),
      maxPriorityFeePerGas: PRIORITY_FEE_WEI,
    };
  } catch {
    return { feeCurrency }; // block read failed → let viem estimate (best effort)
  }
}

/**
 * An explicit gas limit for a feeCurrency tx, estimated WITHOUT any fee fields.
 * With explicit fees in the request (the #69 cap), eth_estimateGas also applies
 * an affordability cap — computed against the NATIVE balance on that path, which
 * is 0 for a burner (its gas lives in cUSD): "gas required exceeds allowance
 * (0)". A fee-less estimate skips the affordability cap entirely (pre-#69
 * behaviour); ×1.5 covers the CIP-64 fee-debit overhead and state drift between
 * estimate and mine. Returns {} when the estimate itself fails (e.g. a lagging
 * node that can't see a fresh allowance yet) — the send path then estimates,
 * and the lock retry (one attempt later) covers the transient. */
/**
 * All tx extras for one lock attempt under `plan` (see feePlan.ts for the C1..C4
 * constraint system): `{}` for a native-coin tx (viem's defaults are right for a
 * funded external wallet), else feeCurrency + an explicit cap derived from the
 * FRESH native base fee (C1) + an explicit gas limit from a FEE-LESS estimate
 * (C2: no affordability cap on the wrong balance) padded per the plan (C3),
 * with the plan's reservation posture bounding C4. Each fallback degrades to
 * letting viem/the node fill the blank — the attempt ladder covers transients.
 */
export async function planFeeExtras(
  publicClient: PublicClient,
  feeCurrency: Address | undefined,
  plan: FeePlan,
  estimateRequest: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; account: unknown },
): Promise<Record<string, unknown>> {
  if (!feeCurrency) return {};
  const out: Record<string, unknown> = { feeCurrency };
  try {
    const block = await publicClient.getBlock({ blockTag: 'latest' });
    out.maxFeePerGas = planCapWei(plan, block.baseFeePerGas ?? 0n);
    out.maxPriorityFeePerGas = plan.priorityWei;
  } catch {
    /* block read failed → let viem estimate the fees */
  }
  try {
    const estimated = await (publicClient as unknown as { estimateContractGas: (r: unknown) => Promise<bigint> }).estimateContractGas(estimateRequest);
    out.gas = planGasLimit(plan, estimated);
  } catch {
    /* estimate refused (lagging node) → let the send path estimate */
  }
  return out;
}

/**
 * Locks the caller's stake: approve (only if the allowance is short) then
 * join(gameId, token, stake). Idempotent: every attempt re-checks the escrow
 * first, so an address that already joined never locks a second time.
 *
 * ONE retry on any non-user-rejection failure (the 'Stake not locked —
 * reverted' incident): on a load-balanced RPC a lagging node can estimate the
 * join against a state where the approve isn't visible yet ('execution
 * reverted' before broadcast), and a spike-window tx can mine AS a revert.
 * Both are transient and both move NO funds, so a retry — with a fresh
 * escrow re-check and a fresh fee estimate — is money-safe by construction.
 */
export async function stakeInEscrow(params: StakeParams): Promise<StakeReceipt> {
  const { walletClient, publicClient, account, escrow, token, gameId, stakeCents, fairnessCommit, feeCurrency, onStatus, retryDelayMs = 3000 } = params;
  const gameId32 = gameIdToBytes32(gameId);
  const commit32 = commitToBytes32(fairnessCommit);
  const chain = walletClient.chain ?? null;

  const decimals = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' });
  const stake = stakeUnits(stakeCents, decimals);
  // A client with a bound account (local key) signs locally; otherwise the
  // injected wallet (MiniPay) signs the tx for the address.
  const signer = walletClient.account ?? account;

  let approveTx: Hex | undefined;
  let lastError: unknown;
  let plan: FeePlan = BALANCED;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    try {
      // Already joined this game (a resumed session, or the PREVIOUS attempt's
      // join landed but its receipt was lost)? Don't double-lock — this check
      // running at the top of EVERY attempt is what makes the retry safe.
      const game = await publicClient.readContract({ address: escrow, abi: ESCROW_ABI, functionName: 'games', args: [gameId32] });
      const [, , playerA, playerB] = game;
      if ([playerA, playerB].some((p) => p.toLowerCase() === account.toLowerCase())) {
        onStatus?.('locked');
        return { gameId32, stake, approveTx, joinTx: '0x' as Hex };
      }

      const allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account, escrow] });
      if (allowance < stake) {
        onStatus?.('approving');
        const approveExtras = await planFeeExtras(publicClient, feeCurrency, plan, { address: token, abi: ERC20_ABI, functionName: 'approve', args: [escrow, stake], account: signer });
        approveTx = await walletClient.writeContract({ account: signer, chain, address: token, abi: ERC20_ABI, functionName: 'approve', args: [escrow, stake], ...approveExtras });
        const r = await publicClient.waitForTransactionReceipt({ hash: approveTx });
        if (r.status !== 'success') throw new Error('approve reverted');
      }

      onStatus?.('joining');
      const joinExtras = await planFeeExtras(publicClient, feeCurrency, plan, { address: escrow, abi: ESCROW_ABI, functionName: 'join', args: [gameId32, token, stake, commit32], account: signer });
      const joinTx = await walletClient.writeContract({ account: signer, chain, address: escrow, abi: ESCROW_ABI, functionName: 'join', args: [gameId32, token, stake, commit32], ...joinExtras });
      const r = await publicClient.waitForTransactionReceipt({ hash: joinTx });
      if (r.status !== 'success') throw new Error('join reverted');

      onStatus?.('locked');
      return { gameId32, stake, approveTx, joinTx };
    } catch (e) {
      if (isUserRejection(e)) throw e; // never re-pop a prompt the user refused
      lastError = e;
      // Ladder: answer the CLASSIFIED failure (cap → pay more; reservation →
      // spend less; OOG → more gas; transient → same plan, fresh reads).
      plan = nextFeePlan(plan, classifyTxFailure(e));
    }
  }
  throw lastError;
}

/**
 * Locks the caller's stake in the N-player escrow (LudoEscrowN): approve (if the
 * allowance is short) then join(gameId, token, stake, seatCount). Same
 * retry-with-recheck shape as stakeInEscrow — every attempt re-checks seatsOf
 * first (never double-locks), one retry on any non-user-rejection failure.
 */
export async function stakeInEscrowN(params: StakeParams & { seatCount: number }): Promise<StakeReceipt> {
  const { walletClient, publicClient, account, escrow, token, gameId, stakeCents, fairnessCommit, feeCurrency, onStatus, seatCount, retryDelayMs = 3000 } = params;
  const gameId32 = gameIdToBytes32(gameId);
  const commit32 = commitToBytes32(fairnessCommit);
  const chain = walletClient.chain ?? null;

  const decimals = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' });
  const stake = stakeUnits(stakeCents, decimals);
  const signer = walletClient.account ?? account;

  let approveTx: Hex | undefined;
  let lastError: unknown;
  let plan: FeePlan = BALANCED;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    try {
      // Already deposited (resumed session, or a lost-receipt success)? Stop.
      const seats = (await publicClient.readContract({ address: escrow, abi: ESCROW_N_ABI, functionName: 'seatsOf', args: [gameId32] })) as readonly Address[];
      if (seats.some((p) => p.toLowerCase() === account.toLowerCase())) {
        onStatus?.('locked');
        return { gameId32, stake, approveTx, joinTx: '0x' as Hex };
      }

      const allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account, escrow] });
      if (allowance < stake) {
        onStatus?.('approving');
        const approveExtras = await planFeeExtras(publicClient, feeCurrency, plan, { address: token, abi: ERC20_ABI, functionName: 'approve', args: [escrow, stake], account: signer });
        approveTx = await walletClient.writeContract({ account: signer, chain, address: token, abi: ERC20_ABI, functionName: 'approve', args: [escrow, stake], ...approveExtras });
        const r = await publicClient.waitForTransactionReceipt({ hash: approveTx });
        if (r.status !== 'success') throw new Error('approve reverted');
      }

      onStatus?.('joining');
      const joinExtras = await planFeeExtras(publicClient, feeCurrency, plan, { address: escrow, abi: ESCROW_N_ABI, functionName: 'join', args: [gameId32, token, stake, seatCount, commit32], account: signer });
      const joinTx = await walletClient.writeContract({ account: signer, chain, address: escrow, abi: ESCROW_N_ABI, functionName: 'join', args: [gameId32, token, stake, seatCount, commit32], ...joinExtras });
      const r = await publicClient.waitForTransactionReceipt({ hash: joinTx });
      if (r.status !== 'success') throw new Error('join reverted');

      onStatus?.('locked');
      return { gameId32, stake, approveTx, joinTx };
    } catch (e) {
      if (isUserRejection(e)) throw e;
      lastError = e;
      plan = nextFeePlan(plan, classifyTxFailure(e));
    }
  }
  throw lastError;
}

export interface BuyCosmeticParams {
  walletClient: WalletClient;
  publicClient: PublicClient;
  account: Address;
  store: Address;
  token: Address;
  id: string;
  priceCents: number;
  feeCurrency?: Address;
  onStatus?: (status: StakeStatus) => void;
}

/**
 * Buy a cosmetic with cUSD (rec 6): approve (only if the allowance is short) then
 * buy(itemId), which pulls the price straight to the treasury. Returns the buy tx
 * hash — hand it to the server via `cosmetic.claim` to unlock ownership.
 */
export async function buyCosmeticCusd(params: BuyCosmeticParams): Promise<{ buyTxHash: Hex; approveTx?: Hex }> {
  const { walletClient, publicClient, account, store, token, id, priceCents, feeCurrency, onStatus } = params;
  const chain = walletClient.chain ?? null;
  const signer = walletClient.account ?? account;
  const extra = await feeCurrencyExtra(walletClient, publicClient, feeCurrency);

  const decimals = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' });
  const price = stakeUnits(priceCents, decimals);
  const itemId = cosmeticItemId(id);

  const allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account, store] });
  let approveTx: Hex | undefined;
  if (allowance < price) {
    onStatus?.('approving');
    approveTx = await walletClient.writeContract({ account: signer, chain, address: token, abi: ERC20_ABI, functionName: 'approve', args: [store, price], ...extra });
    const r = await publicClient.waitForTransactionReceipt({ hash: approveTx });
    if (r.status !== 'success') throw new Error('approve reverted');
  }

  onStatus?.('joining');
  const buyTxHash = await walletClient.writeContract({ account: signer, chain, address: store, abi: COSMETICS_STORE_ABI, functionName: 'buy', args: [itemId], ...extra });
  const r = await publicClient.waitForTransactionReceipt({ hash: buyTxHash });
  if (r.status !== 'success') throw new Error('cosmetic buy reverted');

  onStatus?.('locked');
  return { buyTxHash, approveTx };
}

/** Wallet token balance in USD cents (for the header display). */
export async function tokenBalanceCents(publicClient: PublicClient, token: Address, account: Address): Promise<number> {
  const [raw, decimals] = await Promise.all([
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }),
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }),
  ]);
  return Number((raw * 100n) / 10n ** BigInt(decimals));
}
