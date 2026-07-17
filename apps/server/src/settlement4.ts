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
import { CHAINS, gameIdToBytes32, serializeByKey } from './settlement.js';
import type { Store, SettlementJob } from './store/index.js';

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
      // rakeBps (7th field on the hardened contract) intentionally omitted — unused,
      // and a 6-output ABI decodes fine against both the 6- and 7-field getters.
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
  readonly escrow: Address;
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
    // Same EOA as the 1v1 arbiter → serialize on the account to avoid nonce races.
    return serializeByKey(this.account.address, async () => {
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
    });
  }

  /** Arbiter's native (gas) balance in wei (same EOA as the 1v1 arbiter). */
  async nativeBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.account.address });
  }

  async submitSettle(gameId: string, winner: Address): Promise<Hex> {
    const sig = await this.signSettlement(gameId, winner);
    return this.submit('settle', [gameIdToBytes32(gameId), winner, sig]);
  }

  /** Refund every depositor of a table that never filled (past JOIN_TIMEOUT). */
  async submitRefundUnfilled(gameId: string): Promise<Hex> {
    return this.submit('refundUnfilled', [gameIdToBytes32(gameId)]);
  }

  /** Return every stake of an ACTIVE (all-seats-deposited) game to its depositor.
   *  The 4p analogue of the 1v1 voidGame: needed when a table filled on-chain but
   *  the game never started (e.g. a seat never revealed its fairness entropy).
   *  refundUnfilled reverts on an Active escrow (it requires Filling), so without
   *  this the pot would be stuck until the 24 h permissionless refundActive. */
  async submitVoid(gameId: string): Promise<Hex> {
    return this.submit('voidGame', [gameIdToBytes32(gameId)]);
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

const MAX_ATTEMPTS_4 = 6;

/** The queue only needs these from the N-player arbiter (stubbable in tests). */
export interface ArbiterNLike {
  readonly chainId: number;
  gameStatus(gameId: string): Promise<GameN>;
  seatsOf(gameId: string): Promise<Address[]>;
  submitSettle(gameId: string, winner: Address): Promise<Hex>;
  submitRefundUnfilled(gameId: string): Promise<Hex>;
  submitVoid(gameId: string): Promise<Hex>;
}

export interface Settlement4Deps {
  store: Store;
  arbiter: ArbiterNLike;
  /** Notify the seats once the payout tx is mined. */
  onSettled: (gameId: string, txHash: string) => void;
  /** Notify once an unfilled table has been refunded to every depositor. */
  onRefunded: (gameId: string, txHash: string) => void;
  /** Money-critical alert (payout failed / stuck escrow) for an ops pager. */
  onAlert?: (message: string) => void;
  /** Fired on EVERY terminal outcome — the caller drops per-game bookkeeping it
   *  held while the job was in flight (mirrors SettlementQueue.onTerminal). */
  onTerminal?: (gameId: string) => void;
  /** Wall-clock seconds; injectable for tests. */
  now?: () => number;
}

/**
 * Durable settlement for 4-player staked games (LudoEscrowN) — the N-player
 * mirror of {@link SettlementQueue}. Jobs are persisted (variant '4p') and
 * resumed at boot, so a crash between game-over and payout never loses a 4p
 * payout (the pre-existing in-memory setTimeout path did). A settle job carries
 * the winner wallet; a refund-unfilled job carries winnerWallet '' and is
 * processed once the table is still Filling past the join window.
 */
export class SettlementQueue4 {
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: Settlement4Deps) {}

  /** Enqueue a winner payout for a completed 4p game (durable, non-blocking). */
  async enqueue(gameId: string, winnerWallet: string): Promise<void> {
    return this.add(gameId, winnerWallet);
  }

  /** Enqueue a full refund for a table that never filled (winner unknown). */
  async enqueueRefundUnfilled(gameId: string): Promise<void> {
    return this.add(gameId, '');
  }

  private async add(gameId: string, winnerWallet: string): Promise<void> {
    const job: SettlementJob = {
      gameId,
      winnerWallet,
      chainId: this.deps.arbiter.chainId,
      status: 'pending',
      attempts: 0,
      variant: '4p',
    };
    await this.deps.store.enqueueSettlement(job);
    void this.process(job);
  }

  /** Re-process 4p jobs left pending by a previous run (call at boot). */
  async resumePending(): Promise<void> {
    const pending = await this.deps.store.listPendingSettlements();
    const mine = pending.filter((j) => j.variant === '4p' && j.chainId === this.deps.arbiter.chainId);
    for (const job of mine) void this.process(job);
    if (mine.length > 0) console.log(`[settlement4] resuming ${mine.length} pending job(s)`);
  }

  /** Cancel pending retries (shutdown). */
  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private nowS(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private reschedule(job: SettlementJob, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.process(job);
    }, delayMs);
    this.timers.add(timer);
  }

  /** Wraps processOnce so onTerminal fires exactly once on ANY terminal outcome —
   *  no terminal branch can silently leak the caller's per-game bookkeeping. */
  private async process(job: SettlementJob): Promise<void> {
    const terminal = await this.processOnce(job);
    if (terminal) this.deps.onTerminal?.(job.gameId);
  }

  /** @returns true when DONE (any outcome); false when it rescheduled/retried. */
  private async processOnce(job: SettlementJob): Promise<boolean> {
    const attempts = job.attempts + 1;
    try {
      const { status, createdAt } = await this.deps.arbiter.gameStatus(job.gameId);

      if (status === GameStatusN.Active) {
        // A refund job (winnerWallet === '') on an Active escrow means the table
        // filled on-chain but the game never started (e.g. a seat never revealed).
        // voidGame returns every stake to its depositor; refundUnfilled would
        // revert here (it requires Filling). Without this the pot sat in Active
        // until the 24 h refundActive — the 4p gap the 1v1 void path already closes.
        if (job.winnerWallet === '') {
          const txHash = await this.deps.arbiter.submitVoid(job.gameId);
          await this.deps.store.markSettlement(job.gameId, 'refunded', attempts, txHash);
          this.deps.onRefunded(job.gameId, txHash);
          console.log(`[settlement4] ${job.gameId} voided (Active, refund) in tx ${txHash}`);
          return true;
        }
        // Reconcile the winner against the actual on-chain seats; settle() reverts
        // NotAPlayer otherwise, burning retries until the pot is stuck in Active.
        const seats = await this.deps.arbiter.seatsOf(job.gameId);
        const winner = job.winnerWallet.toLowerCase();
        if (!seats.some((s) => s.toLowerCase() === winner)) {
          await this.deps.store.markSettlement(job.gameId, 'failed', attempts);
          const msg = `[settlement4][ALERT] winner ${job.winnerWallet} is not an on-chain seat (${seats.join(', ')}) for 4p game ${job.gameId}. NOT settling; manual review — funds locked in Active escrow.`;
          console.error(msg);
          this.deps.onAlert?.(msg);
          return true;
        }
        const txHash = await this.deps.arbiter.submitSettle(job.gameId, job.winnerWallet as Address);
        await this.deps.store.markSettlement(job.gameId, 'settled', attempts, txHash);
        this.deps.onSettled(job.gameId, txHash);
        console.log(`[settlement4] ${job.gameId} settled in tx ${txHash}`);
        return true;
      }

      if (status === GameStatusN.Filling) {
        // Table never filled: refund every depositor once JOIN_TIMEOUT elapses.
        const readyAt = createdAt + JOIN_TIMEOUT_N_S;
        const waitS = readyAt - this.nowS();
        if (waitS > 0) {
          console.log(`[settlement4] ${job.gameId} awaiting refund window (${waitS}s)`);
          this.reschedule(job, (waitS + 3) * 1_000);
          return false; // not terminal — runs again after the wait
        }
        const txHash = await this.deps.arbiter.submitRefundUnfilled(job.gameId);
        await this.deps.store.markSettlement(job.gameId, 'refunded', attempts, txHash);
        this.deps.onRefunded(job.gameId, txHash);
        console.log(`[settlement4] ${job.gameId} refundUnfilled in tx ${txHash}`);
        return true;
      }

      // Already resolved on-chain (Settled/Refunded), or nobody staked (None).
      const terminal = status === GameStatusN.Settled ? 'settled' : status === GameStatusN.Refunded ? 'refunded' : 'failed';
      await this.deps.store.markSettlement(job.gameId, terminal, attempts);
      if (terminal === 'failed') console.warn(`[settlement4] ${job.gameId} not stakeable (status ${status}); skipping`);
      return true;
    } catch (e) {
      console.error(`[settlement4] ${job.gameId} attempt ${attempts} failed:`, e instanceof Error ? e.message : e);
      if (attempts >= MAX_ATTEMPTS_4) {
        await this.deps.store.markSettlement(job.gameId, 'failed', attempts);
        const msg = `[settlement4][ALERT] PAYOUT FAILED after ${attempts} attempts — 4p game ${job.gameId}, winner ${job.winnerWallet || '(refund)'}, chain ${job.chainId}. Funds may be locked in LudoEscrowN; manual settle/refund required.`;
        console.error(msg);
        this.deps.onAlert?.(msg);
        return true;
      }
      await this.deps.store.markSettlement(job.gameId, 'pending', attempts);
      const backoff = Math.min(1_000 * 2 ** (attempts - 1), 30_000);
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void this.process({ ...job, attempts });
      }, backoff);
      this.timers.add(timer);
      return false; // retrying
    }
  }
}
