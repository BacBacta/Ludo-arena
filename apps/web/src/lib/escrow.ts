/**
 * LudoEscrow interaction from the client (BACKLOG E3.2).
 * Transport-agnostic: the caller passes a viem WalletClient (MiniPay custom
 * transport in the app, an http+key client in the verify script). Under
 * MiniPay, pass `feeCurrency` to pay gas in cUSD with a legacy tx.
 */
import { pad, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';

export const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

export const ESCROW_ABI = [
  { type: 'function', name: 'join', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }, { name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' }], outputs: [] },
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
    ],
  },
] as const;

/** LudoEscrowN (N-player) — join takes seatCount; seatsOf lists the depositors. */
export const ESCROW_N_ABI = [
  { type: 'function', name: 'join', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }, { name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' }, { name: 'seatCount', type: 'uint8' }], outputs: [] },
  { type: 'function', name: 'seatsOf', stateMutability: 'view', inputs: [{ name: 'gameId', type: 'bytes32' }], outputs: [{ name: '', type: 'address[]' }] },
] as const;

/**
 * The server gameId is 16 random bytes (32 hex chars); the contract keys on
 * bytes32. Left-pad to 32 bytes — canonical, so E3.3 server settlement signs
 * the exact same value.
 */
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
 * Locks the caller's stake: approve (only if the allowance is short) then
 * join(gameId, token, stake). Idempotent-ish: if this address already joined
 * the game, returns without a second join.
 */
export async function stakeInEscrow(params: StakeParams): Promise<StakeReceipt> {
  const { walletClient, publicClient, account, escrow, token, gameId, stakeCents, feeCurrency, onStatus } = params;
  const gameId32 = gameIdToBytes32(gameId);
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

  const extra = feeCurrency ? { feeCurrency } : {};
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
  const joinTx = await walletClient.writeContract({ account: signer, chain, address: escrow, abi: ESCROW_ABI, functionName: 'join', args: [gameId32, token, stake], ...extra });
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
  const { walletClient, publicClient, account, escrow, token, gameId, stakeCents, feeCurrency, onStatus, seatCount } = params;
  const gameId32 = gameIdToBytes32(gameId);
  const chain = walletClient.chain ?? null;

  const decimals = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' });
  const stake = stakeUnits(stakeCents, decimals);

  // already deposited (e.g. a resumed session)? don't double-lock.
  const seats = (await publicClient.readContract({ address: escrow, abi: ESCROW_N_ABI, functionName: 'seatsOf', args: [gameId32] })) as readonly Address[];
  if (seats.some((p) => p.toLowerCase() === account.toLowerCase())) {
    onStatus?.('locked');
    return { gameId32, stake, joinTx: '0x' as Hex };
  }

  const extra = feeCurrency ? { feeCurrency } : {};
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
  const joinTx = await walletClient.writeContract({ account: signer, chain, address: escrow, abi: ESCROW_N_ABI, functionName: 'join', args: [gameId32, token, stake, seatCount], ...extra });
  const r = await publicClient.waitForTransactionReceipt({ hash: joinTx });
  if (r.status !== 'success') throw new Error('join reverted');

  onStatus?.('locked');
  return { gameId32, stake, approveTx, joinTx };
}

/** Wallet token balance in USD cents (for the header display). */
export async function tokenBalanceCents(publicClient: PublicClient, token: Address, account: Address): Promise<number> {
  const [raw, decimals] = await Promise.all([
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] }),
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }),
  ]);
  return Number((raw * 100n) / 10n ** BigInt(decimals));
}
