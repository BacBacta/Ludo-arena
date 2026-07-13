/**
 * On-chain settlement for 4-player staked games via LudoEscrowN (N-seat escrow).
 * Mirrors the 2-player Arbiter but for the N-player contract: the settlement
 * DIGEST is identical (keccak256(chainid, escrow, gameId, winner), EIP-191), so
 * only the escrow address + ABI differ. Kept separate from settlement.ts so the
 * proven 1v1 money path is untouched.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS, gameIdToBytes32 } from './settlement.js';

/** Mirrors LudoEscrowN.Status (note: index 1 is Filling, not WaitingOpponent). */
export enum GameStatusN {
  None = 0,
  Filling = 1,
  Active = 2,
  Settled = 3,
  Refunded = 4,
}

/** LudoEscrowN.JOIN_TIMEOUT (seconds) before refundUnfilled is allowed. */
export const JOIN_TIMEOUT_N_S = 120;

const ESCROW_N_ABI = [
  { type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }, { name: 'winner', type: 'address' }, { name: 'sig', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'refundUnfilled', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'voidGame', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'seatsOf', stateMutability: 'view', inputs: [{ name: 'gameId', type: 'bytes32' }], outputs: [{ name: '', type: 'address[]' }] },
  {
    type: 'function', name: 'games', stateMutability: 'view', inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' },
      { name: 'seatCount', type: 'uint8' }, { name: 'joined', type: 'uint8' },
      { name: 'createdAt', type: 'uint40' }, { name: 'status', type: 'uint8' },
    ],
  },
] as const;

export interface GameN {
  status: GameStatusN;
  seatCount: number;
  joined: number;
  createdAt: number;
}

/** The N-player arbiter: signs + submits settlement / refunds for LudoEscrowN. */
export class ArbiterN {
  readonly chainId: number;
  readonly address: Address;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly chain: Chain;
  private readonly escrow: Address;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly walletClient: ReturnType<typeof createWalletClient>;

  constructor(privateKey: Hex, chain: Chain, escrow: Address, rpc?: string) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
    this.chain = chain;
    this.chainId = chain.id;
    this.escrow = escrow;
    const transport = http(rpc);
    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account: this.account, chain, transport });
  }

  /** EIP-191 signature over keccak256(abi.encode(chainid, escrow, gameId, winner)). */
  async signSettlement(gameId: string, winner: Address): Promise<Hex> {
    const inner = keccak256(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'address' }],
        [BigInt(this.chainId), this.escrow, gameIdToBytes32(gameId), winner],
      ),
    );
    return this.account.signMessage({ message: { raw: inner } });
  }

  /** On-chain game state — used to poll for all seats locked (Active). */
  async gameStatus(gameId: string): Promise<GameN> {
    const g = await this.publicClient.readContract({
      address: this.escrow,
      abi: ESCROW_N_ABI,
      functionName: 'games',
      args: [gameIdToBytes32(gameId)],
    });
    return { status: Number(g[5]) as GameStatusN, seatCount: Number(g[2]), joined: Number(g[3]), createdAt: Number(g[4]) };
  }

  /** The depositor addresses (seat order) — reconcile the winner against these. */
  async seatsOf(gameId: string): Promise<Address[]> {
    return (await this.publicClient.readContract({
      address: this.escrow,
      abi: ESCROW_N_ABI,
      functionName: 'seatsOf',
      args: [gameIdToBytes32(gameId)],
    })) as Address[];
  }

  private async submit(functionName: 'settle' | 'refundUnfilled' | 'voidGame', args: readonly unknown[]): Promise<Hex> {
    const hash = await this.walletClient.writeContract({
      account: this.account,
      chain: this.chain,
      address: this.escrow,
      abi: ESCROW_N_ABI,
      functionName,
      args,
    } as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted (tx ${hash})`);
    return hash;
  }

  async submitSettle(gameId: string, winner: Address): Promise<Hex> {
    const sig = await this.signSettlement(gameId, winner);
    return this.submit('settle', [gameIdToBytes32(gameId), winner, sig]);
  }

  /** Refund every depositor of a table that never filled (past JOIN_TIMEOUT). */
  async submitRefundUnfilled(gameId: string): Promise<Hex> {
    return this.submit('refundUnfilled', [gameIdToBytes32(gameId)]);
  }

  async healthcheck(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }
}

interface DeploymentN {
  chainId: number;
  escrowN?: Address;
}

/** Build the N-player arbiter from env (ARBITER_PRIVATE_KEY + CHAIN +
 *  ESCROW_N_ADDRESS or deployments.json escrowN), or null if not configured. */
export function createArbiterN(env: NodeJS.ProcessEnv = process.env): ArbiterN | null {
  const raw = env.ARBITER_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const chain = CHAINS[env.CHAIN?.trim() || 'celo-sepolia'];
  if (!chain) return null;

  let escrow = env.ESCROW_N_ADDRESS?.trim() as Address | undefined;
  if (!escrow) {
    const deploymentsPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'contracts', 'deployments.json');
    try {
      const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8')) as Record<string, DeploymentN>;
      escrow = Object.values(deployments).find((d) => d.chainId === chain.id)?.escrowN;
    } catch {
      /* no deployments file bundled */
    }
  }
  if (!escrow) return null; // N-player escrow not deployed yet → staked 4p stays off

  const pk = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
  return new ArbiterN(pk, chain, escrow, env.SETTLEMENT_RPC?.trim() || undefined);
}
