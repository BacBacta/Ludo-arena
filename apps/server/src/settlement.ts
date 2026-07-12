/**
 * On-chain settlement by the server arbiter (BACKLOG E3.3).
 * On game end, the arbiter signs (chainid, escrow, gameId, winner) — EIP-191,
 * matching LudoEscrow.settlementDigest — and submits settle(). Jobs are
 * durable (Store) and retried with backoff; the queue resumes pending jobs
 * at boot so a crash between game.over and payout does not lose the payout.
 *
 * Note: the contract verifies an EIP-191 personal-signed digest, not EIP-712;
 * the signature here matches the deployed contract (verified by the smoke test).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import type { Store, SettlementJob } from './store/index.js';

const celoSepolia = defineChain({
  id: 11_142_220,
  name: 'Celo Sepolia',
  nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
  rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } },
  testnet: true,
});

const CHAINS: Record<string, Chain> = { celo, 'celo-sepolia': celoSepolia };

const SETTLE_ABI = [
  { type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }, { name: 'winner', type: 'address' }, { name: 'sig', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'refundExpired', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }], outputs: [] },
  {
    type: 'function', name: 'games', stateMutability: 'view', inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' },
      { name: 'playerA', type: 'address' }, { name: 'playerB', type: 'address' },
      { name: 'createdAt', type: 'uint40' }, { name: 'status', type: 'uint8' },
    ],
  },
] as const;

const MAX_ATTEMPTS = 6;
/** Mirrors LudoEscrow.Status. */
export enum GameStatus {
  None = 0,
  WaitingOpponent = 1,
  Active = 2,
  Settled = 3,
  Refunded = 4,
}
/** LudoEscrow.JOIN_TIMEOUT (seconds) before refundExpired is allowed. */
export const JOIN_TIMEOUT_S = 120;

/** Canonical server gameId (16 bytes hex) → bytes32; must match web's escrow.ts. */
export function gameIdToBytes32(gameId: string): Hex {
  const hex = gameId.startsWith('0x') ? gameId.slice(2) : gameId;
  if (!/^[0-9a-fA-F]{1,64}$/.test(hex)) throw new Error(`gameId not hex: ${gameId}`);
  return pad(`0x${hex}` as Hex, { size: 32 });
}

interface Deployment {
  chainId: number;
  escrow: Address;
}

export class Arbiter {
  readonly chainId: number;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly chain: Chain;
  private readonly escrow: Address;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly walletClient: ReturnType<typeof createWalletClient>;

  constructor(privateKey: Hex, chain: Chain, escrow: Address, rpc?: string) {
    this.account = privateKeyToAccount(privateKey);
    this.chain = chain;
    this.escrow = escrow;
    this.chainId = chain.id;
    const transport = http(rpc);
    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account: this.account, chain, transport });
  }

  get address(): Address {
    return this.account.address;
  }

  /** Liveness ping for the readiness probe: a lightweight RPC round-trip that
   *  proves the chain endpoint is reachable. Returns the latest block number
   *  (throws if the RPC is down). */
  async healthcheck(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
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

  /** On-chain escrow status + creation time + the two depositor addresses
   *  (so settlement can reconcile the winner against the actual players). */
  async gameStatus(gameId: string): Promise<{ status: GameStatus; createdAt: number; playerA: Address; playerB: Address }> {
    const game = await this.publicClient.readContract({
      address: this.escrow,
      abi: SETTLE_ABI,
      functionName: 'games',
      args: [gameIdToBytes32(gameId)],
    });
    return {
      status: Number(game[5]) as GameStatus,
      createdAt: Number(game[4]),
      playerA: game[2] as Address,
      playerB: game[3] as Address,
    };
  }

  private async submit(functionName: 'settle' | 'refundExpired', args: readonly unknown[]): Promise<Hex> {
    const hash = await this.walletClient.writeContract({
      account: this.account,
      chain: this.chain,
      address: this.escrow,
      abi: SETTLE_ABI,
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

  /** Refund the lone staker of an expired game (opponent never joined). */
  async submitRefund(gameId: string): Promise<Hex> {
    return this.submit('refundExpired', [gameIdToBytes32(gameId)]);
  }
}

/**
 * Builds an Arbiter from env + deployments.json, or null when settlement is
 * not configured (no ARBITER_PRIVATE_KEY / no deployment for the chain).
 */
export function createArbiter(env: NodeJS.ProcessEnv = process.env): Arbiter | null {
  const raw = env.ARBITER_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const chainName = env.CHAIN?.trim() || 'celo-sepolia';
  const chain = CHAINS[chainName];
  if (!chain) throw new Error(`Unknown CHAIN '${chainName}' for settlement`);

  // ESCROW_ADDRESS wins; only fall back to deployments.json when it exists
  // (it is not shipped in the server image — the web vendors its own copy).
  let escrow = env.ESCROW_ADDRESS?.trim() as Address | undefined;
  if (!escrow) {
    const deploymentsPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'contracts', 'deployments.json');
    try {
      const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8')) as Record<string, Deployment>;
      escrow = Object.values(deployments).find((d) => d.chainId === chain.id)?.escrow;
    } catch {
      /* no deployments file bundled */
    }
  }
  if (!escrow) throw new Error(`No escrow address for chain ${chain.id}; set ESCROW_ADDRESS or deploy first`);

  const pk = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
  return new Arbiter(pk, chain, escrow, env.SETTLEMENT_RPC?.trim() || undefined);
}

/** The queue only needs these from an arbiter (stubbable in tests). */
export interface ArbiterLike {
  readonly chainId: number;
  gameStatus(gameId: string): Promise<{ status: GameStatus; createdAt: number; playerA: Address; playerB: Address }>;
  submitSettle(gameId: string, winner: Address): Promise<Hex>;
  submitRefund(gameId: string): Promise<Hex>;
}

export interface SettlementDeps {
  store: Store;
  arbiter: ArbiterLike;
  /** Notify the players once the payout tx is mined. */
  onSettled: (gameId: string, txHash: string) => void;
  /** Notify once the lone staker has been refunded (opponent never joined). */
  onRefunded: (gameId: string, txHash: string) => void;
  /** Money-critical alert (payout failed / stuck escrow) for an ops pager. */
  onAlert?: (message: string) => void;
  /** Wall-clock seconds; injectable for tests. */
  now?: () => number;
}

/** Persists and retries settlement jobs with exponential backoff. */
export class SettlementQueue {
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: SettlementDeps) {}

  /** Enqueue a new job and kick off processing (non-blocking). */
  async enqueue(gameId: string, winnerWallet: string): Promise<void> {
    const job: SettlementJob = {
      gameId,
      winnerWallet,
      chainId: this.deps.arbiter.chainId,
      status: 'pending',
      attempts: 0,
    };
    await this.deps.store.enqueueSettlement(job);
    void this.process(job);
  }

  /** Re-process jobs left pending by a previous run (call at boot). */
  async resumePending(): Promise<void> {
    const pending = await this.deps.store.listPendingSettlements();
    for (const job of pending) {
      if (job.chainId === this.deps.arbiter.chainId) void this.process(job);
    }
    if (pending.length > 0) console.log(`[settlement] resuming ${pending.length} pending job(s)`);
  }

  /** Cancel pending retries (shutdown). */
  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private nowS(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /** Re-run the job later without counting an attempt (used for the refund wait). */
  private reschedule(job: SettlementJob, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.process(job);
    }, delayMs);
    this.timers.add(timer);
  }

  private async process(job: SettlementJob): Promise<void> {
    const attempts = job.attempts + 1;
    try {
      const { status, createdAt, playerA, playerB } = await this.deps.arbiter.gameStatus(job.gameId);

      if (status === GameStatus.Active) {
        // Reconcile the reported winner against the actual on-chain depositors.
        // settle() reverts NotAPlayer otherwise, wasting gas and burning retries
        // until the pot is stuck in Active forever. Fail loudly instead.
        const winner = job.winnerWallet.toLowerCase();
        if (winner !== playerA.toLowerCase() && winner !== playerB.toLowerCase()) {
          await this.deps.store.markSettlement(job.gameId, 'failed', attempts);
          const msg = `[settlement][ALERT] winner ${job.winnerWallet} is not an on-chain player (A=${playerA}, B=${playerB}) for game ${job.gameId}. NOT settling; manual review — funds are locked in Active escrow.`;
          console.error(msg);
          this.deps.onAlert?.(msg);
          return;
        }
        const txHash = await this.deps.arbiter.submitSettle(job.gameId, job.winnerWallet as Address);
        await this.deps.store.markSettlement(job.gameId, 'settled', attempts, txHash);
        this.deps.onSettled(job.gameId, txHash);
        console.log(`[settlement] ${job.gameId} settled in tx ${txHash}`);
        return;
      }

      if (status === GameStatus.WaitingOpponent) {
        // Only one player staked: refund them once JOIN_TIMEOUT elapses (E3.4).
        const readyAt = createdAt + JOIN_TIMEOUT_S;
        const waitS = readyAt - this.nowS();
        if (waitS > 0) {
          console.log(`[settlement] ${job.gameId} awaiting refund window (${waitS}s)`);
          this.reschedule(job, (waitS + 3) * 1_000); // small buffer past the timeout
          return;
        }
        const txHash = await this.deps.arbiter.submitRefund(job.gameId);
        await this.deps.store.markSettlement(job.gameId, 'refunded', attempts, txHash);
        this.deps.onRefunded(job.gameId, txHash);
        console.log(`[settlement] ${job.gameId} refunded in tx ${txHash}`);
        return;
      }

      // Already resolved on-chain, or nobody staked (None): nothing to do.
      const terminal = status === GameStatus.Settled ? 'settled' : status === GameStatus.Refunded ? 'refunded' : 'failed';
      await this.deps.store.markSettlement(job.gameId, terminal, attempts);
      if (terminal === 'failed') console.warn(`[settlement] ${job.gameId} not stakeable (status ${status}); skipping`);
      return;
    } catch (e) {
      console.error(`[settlement] ${job.gameId} attempt ${attempts} failed:`, e instanceof Error ? e.message : e);
      if (attempts >= MAX_ATTEMPTS) {
        await this.deps.store.markSettlement(job.gameId, 'failed', attempts);
        // A winner was NOT paid after every retry — this needs a human. Emit a
        // loud, greppable alert (an error tracker / pager hooks in via onAlert).
        const msg = `[settlement][ALERT] PAYOUT FAILED after ${attempts} attempts — game ${job.gameId}, winner ${job.winnerWallet}, chain ${job.chainId}. Funds may be locked in escrow; manual settle/refund required.`;
        console.error(msg);
        this.deps.onAlert?.(msg);
        return;
      }
      await this.deps.store.markSettlement(job.gameId, 'pending', attempts);
      const backoff = Math.min(1_000 * 2 ** (attempts - 1), 30_000);
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void this.process({ ...job, attempts });
      }, backoff);
      this.timers.add(timer);
    }
  }
}
