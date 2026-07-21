/**
 * LudoEscrow interaction from the client (BACKLOG E3.2).
 * Transport-agnostic: the caller passes a viem WalletClient (MiniPay custom
 * transport in the app, an http+key client in the verify script). Under
 * MiniPay, pass `feeCurrency` to pay gas in cUSD with a legacy tx.
 */
import { keccak256, pad, toBytes, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';

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
}

export interface StakeReceipt {
  gameId32: Hex;
  stake: bigint;
  approveTx?: Hex;
  joinTx: Hex;
}

/**
 * The tx overrides for a `feeCurrency` (gas-in-cUSD) transaction: `{ feeCurrency }`
 * when set, else `{}` (pay in the native coin).
 *
 * We deliberately do NOT set explicit 1559 caps. Celo's node validates
 * `maxFeePerGas` against the NATIVE base fee (CELO), which moves independently of
 * — and can be an order of magnitude above — the cUSD gas price. A cap derived
 * from `eth_gasPrice(token)` (e.g. gp×2) therefore lands far below the native base
 * fee whenever it spikes, and the node rejects the tx ("max fee per gas less than
 * block base fee"). viem's own estimate for a feeCurrency tx sets the caps
 * correctly against the native base fee — let it. Verified on Celo mainnet: with
 * feeCurrency only, a funded burner's mint clears the gas check (fails just on
 * balance when unfunded); an explicit gp×N cap is rejected once the base fee rises.
 * (walletClient/publicClient kept in the signature for call-site symmetry.)
 */
export async function feeCurrencyExtra(
  _walletClient: WalletClient,
  _publicClient: PublicClient,
  feeCurrency?: Address,
): Promise<Record<string, unknown>> {
  return feeCurrency ? { feeCurrency } : {};
}

/**
 * Locks the caller's stake: approve (only if the allowance is short) then
 * join(gameId, token, stake). Idempotent-ish: if this address already joined
 * the game, returns without a second join.
 */
export async function stakeInEscrow(params: StakeParams): Promise<StakeReceipt> {
  const { walletClient, publicClient, account, escrow, token, gameId, stakeCents, fairnessCommit, feeCurrency, onStatus } = params;
  const gameId32 = gameIdToBytes32(gameId);
  const commit32 = commitToBytes32(fairnessCommit);
  const chain = walletClient.chain ?? null;

  const decimals = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' });
  const stake = stakeUnits(stakeCents, decimals);

  // already joined this game (e.g. a resumed session)? don't double-lock.
  const game = await publicClient.readContract({ address: escrow, abi: ESCROW_ABI, functionName: 'games', args: [gameId32] });
  const [, , playerA, playerB] = game;
  const already = [playerA, playerB].some((p) => p.toLowerCase() === account.toLowerCase());
  if (already) {
    onStatus?.('locked');
    return { gameId32, stake, joinTx: '0x' as Hex };
  }

  const extra = await feeCurrencyExtra(walletClient, publicClient, feeCurrency);
  // A client with a bound account (local key) signs locally; otherwise the
  // injected wallet (MiniPay) signs the tx for the address.
  const signer = walletClient.account ?? account;

  const allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account, escrow] });
  let approveTx: Hex | undefined;
  if (allowance < stake) {
    onStatus?.('approving');
    approveTx = await walletClient.writeContract({ account: signer, chain, address: token, abi: ERC20_ABI, functionName: 'approve', args: [escrow, stake], ...extra });
    const r = await publicClient.waitForTransactionReceipt({ hash: approveTx });
    if (r.status !== 'success') throw new Error('approve reverted');
  }

  onStatus?.('joining');
  const joinTx = await walletClient.writeContract({ account: signer, chain, address: escrow, abi: ESCROW_ABI, functionName: 'join', args: [gameId32, token, stake, commit32], ...extra });
  const r = await publicClient.waitForTransactionReceipt({ hash: joinTx });
  if (r.status !== 'success') throw new Error('join reverted');

  onStatus?.('locked');
  return { gameId32, stake, approveTx, joinTx };
}

/**
 * Locks the caller's stake in the N-player escrow (LudoEscrowN): approve (if the
 * allowance is short) then join(gameId, token, stake, seatCount). Idempotent-ish:
 * if this address already deposited, returns without a second join.
 */
export async function stakeInEscrowN(params: StakeParams & { seatCount: number }): Promise<StakeReceipt> {
  const { walletClient, publicClient, account, escrow, token, gameId, stakeCents, fairnessCommit, feeCurrency, onStatus, seatCount } = params;
  const gameId32 = gameIdToBytes32(gameId);
  const commit32 = commitToBytes32(fairnessCommit);
  const chain = walletClient.chain ?? null;

  const decimals = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' });
  const stake = stakeUnits(stakeCents, decimals);

  // already deposited (e.g. a resumed session)? don't double-lock.
  const seats = (await publicClient.readContract({ address: escrow, abi: ESCROW_N_ABI, functionName: 'seatsOf', args: [gameId32] })) as readonly Address[];
  if (seats.some((p) => p.toLowerCase() === account.toLowerCase())) {
    onStatus?.('locked');
    return { gameId32, stake, joinTx: '0x' as Hex };
  }

  const extra = await feeCurrencyExtra(walletClient, publicClient, feeCurrency);
  const signer = walletClient.account ?? account;

  const allowance = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account, escrow] });
  let approveTx: Hex | undefined;
  if (allowance < stake) {
    onStatus?.('approving');
    approveTx = await walletClient.writeContract({ account: signer, chain, address: token, abi: ERC20_ABI, functionName: 'approve', args: [escrow, stake], ...extra });
    const r = await publicClient.waitForTransactionReceipt({ hash: approveTx });
    if (r.status !== 'success') throw new Error('approve reverted');
  }

  onStatus?.('joining');
  const joinTx = await walletClient.writeContract({ account: signer, chain, address: escrow, abi: ESCROW_N_ABI, functionName: 'join', args: [gameId32, token, stake, seatCount, commit32], ...extra });
  const r = await publicClient.waitForTransactionReceipt({ hash: joinTx });
  if (r.status !== 'success') throw new Error('join reverted');

  onStatus?.('locked');
  return { gameId32, stake, approveTx, joinTx };
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
