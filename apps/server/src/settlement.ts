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

// Local dev chain (hardhat/anvil) — lets the full on-chain stack (settlement,
// cosmetics, Race Week faucet) run against a local node for E2E tests. Never a
// real deployment target; CHAIN=localhost is opt-in.
const localhost = defineChain({
  id: 31_337,
  name: 'Localhost',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [process.env.LOCAL_RPC?.trim() || 'http://127.0.0.1:8545'] } },
  testnet: true,
});

export const CHAINS: Record<string, Chain> = { celo, 'celo-sepolia': celoSepolia, localhost };

const SETTLE_ABI = [
  { type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }, { name: 'winner', type: 'address' }, { name: 'serverSeed', type: 'string' }, { name: 'entropyA', type: 'string' }, { name: 'entropyB', type: 'string' }, { name: 'sig', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'refundExpired', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'voidGame', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }], outputs: [] },
  {
    type: 'function', name: 'games', stateMutability: 'view', inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' },
      { name: 'playerA', type: 'address' }, { name: 'playerB', type: 'address' },
      { name: 'createdAt', type: 'uint40' }, { name: 'status', type: 'uint8' },
      // NB: the hardened contract appends rakeBps (7th field); we don't read it and a
      // 6-output ABI decodes fine against BOTH the current (6-field) and future
      // (7-field) getter, so this stays contract-version-agnostic.
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

/**
 * Per-key FIFO serialization. Both arbiters (2p + 4p) submit from the SAME EOA,
 * so concurrent writeContract calls would fetch the same nonce and collide (one
 * tx replaces/reverts the other). Chaining every submission for a given account
 * address through one promise makes them strictly one-at-a-time. Shared here so
 * settlement.ts and settlement4.ts serialize against the same key.
 */
const submitChains = new Map<string, Promise<unknown>>();
export function serializeByKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = submitChains.get(key) ?? Promise.resolve();
  // Run fn after prev settles either way — a prior failure must not block the chain.
  const next = prev.then(fn, fn);
  // Store a non-rejecting tail so one failed tx doesn't poison the next waiter.
  submitChains.set(key, next.then(() => {}, () => {}));
  return next;
}

export class Arbiter {
  readonly chainId: number;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly chain: Chain;
  readonly escrow: Address;
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

  private async submit(functionName: 'settle' | 'refundExpired' | 'voidGame', args: readonly unknown[]): Promise<Hex> {
    // Serialize on the arbiter EOA so 2p + 4p submissions never race on the nonce.
    return serializeByKey(this.account.address, async () => {
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
    });
  }

  /** Arbiter's native (gas) balance in wei — a monitor alerts when it runs low,
   *  since a broke arbiter silently stalls every payout until retries exhaust. */
  async nativeBalance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.account.address });
  }

  /** Settle the winner AND reveal the dice fairness on-chain. The reveal (serverSeed
   *  + both entropies) is money-flow-INDEPENDENT: absent → empty strings, the payout
   *  is identical, only the FairnessRevealed event differs. The signature is over the
   *  UNCHANGED digest (chainid, escrow, gameId, winner) — the seed is self-verifying. */
  async submitSettle(gameId: string, winner: Address, reveal?: { serverSeed: string; entropies: string[] }): Promise<Hex> {
    const sig = await this.signSettlement(gameId, winner);
    const seed = reveal?.serverSeed ?? '';
    const eA = reveal?.entropies?.[0] ?? '';
    const eB = reveal?.entropies?.[1] ?? '';
    return this.submit('settle', [gameIdToBytes32(gameId), winner, seed, eA, eB, sig]);
  }

  /** Refund the lone staker of an expired game (opponent never joined). */
  async submitRefund(gameId: string): Promise<Hex> {
    return this.submit('refundExpired', [gameIdToBytes32(gameId)]);
  }

  /** Return BOTH stakes to their depositors for an Active game the server
   *  decided must not proceed (e.g. a pre-Room abort that raced with both joins,
   *  or a squatted gameId whose depositors don't match the matched players). */
  async submitVoid(gameId: string): Promise<Hex> {
    return this.submit('voidGame', [gameIdToBytes32(gameId)]);
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
  submitSettle(gameId: string, winner: Address, reveal?: { serverSeed: string; entropies: string[] }): Promise<Hex>;
  submitRefund(gameId: string): Promise<Hex>;
  submitVoid(gameId: string): Promise<Hex>;
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
  /** Fired on EVERY terminal outcome (settled, refunded, failed, nothing-to-do),
   *  after any onSettled/onRefunded. The caller uses it to drop per-game bookkeeping
   *  it kept while the job was in flight. Without it, the outcomes that notify
   *  nobody (a `failed` payout, an already-resolved game, a no-op refund) would leak
   *  that bookkeeping forever — a slow leak only a long soak would surface. */
  onTerminal?: (gameId: string) => void;
  /** Wall-clock seconds; injectable for tests. */
  now?: () => number;
}

/** Persists and retries settlement jobs with exponential backoff. */
export class SettlementQueue {
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: SettlementDeps) {}

  /** Enqueue a winner payout for a completed game (durable, non-blocking). */
  async enqueue(gameId: string, winnerWallet: string, reveal?: { serverSeed: string; entropies: string[] }): Promise<void> {
    return this.add(gameId, winnerWallet, reveal);
  }

  /** Enqueue a refund for a staked 1v1 that must NOT proceed (winner unknown):
   *  a pre-Room abort, a disconnect during entropy reveal, or a squatted gameId.
   *  The queue reads the on-chain status and does the right thing — refund the
   *  lone staker (WaitingOpponent) or void both deposits (Active) — so a stranded
   *  deposit is recovered automatically instead of waiting for a manual call. */
  async enqueueRefund(gameId: string): Promise<void> {
    return this.add(gameId, '');
  }

  private async add(gameId: string, winnerWallet: string, reveal?: { serverSeed: string; entropies: string[] }): Promise<void> {
    const job: SettlementJob = {
      gameId,
      winnerWallet,
      chainId: this.deps.arbiter.chainId,
      status: 'pending',
      attempts: 0,
      variant: '2p',
      reveal,
    };
    await this.deps.store.enqueueSettlement(job);
    void this.process(job);
  }

  /** Re-process jobs left pending by a previous run (call at boot). */
  async resumePending(): Promise<void> {
    const pending = await this.deps.store.listPendingSettlements();
    // Only this chain's 1v1 jobs; 4p jobs (variant '4p') belong to SettlementQueue4.
    const mine = pending.filter((job) => (job.variant ?? '2p') === '2p' && job.chainId === this.deps.arbiter.chainId);
    for (const job of mine) void this.process(job);
    if (mine.length > 0) console.log(`[settlement] resuming ${mine.length} pending job(s)`);
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

  /** Runs the job and fires onTerminal exactly once when it reaches ANY terminal
   *  outcome. Wrapping processOnce (rather than sprinkling the call across seven
   *  return paths) makes it impossible to add a terminal branch that silently
   *  leaks the caller's per-game bookkeeping. */
  private async process(job: SettlementJob): Promise<void> {
    const terminal = await this.processOnce(job);
    if (terminal) this.deps.onTerminal?.(job.gameId);
  }

  /** @returns true when the job is DONE (any outcome); false when it rescheduled. */
  private async processOnce(job: SettlementJob): Promise<boolean> {
    const attempts = job.attempts + 1;
    // A refund-only job (no winner) recovers a stranded deposit: refund the lone
    // staker or void an Active game rather than pay anyone.
    const isRefund = job.winnerWallet === '';
    try {
      const { status, createdAt, playerA, playerB } = await this.deps.arbiter.gameStatus(job.gameId);

      if (status === GameStatus.Active) {
        if (isRefund) {
          // Both stakes locked but the match must not proceed → void, returning
          // each stake to its depositor (never pays a winner).
          const txHash = await this.deps.arbiter.submitVoid(job.gameId);
          await this.deps.store.markSettlement(job.gameId, 'refunded', attempts, txHash);
          this.deps.onRefunded(job.gameId, txHash);
          console.log(`[settlement] ${job.gameId} voided (refund) in tx ${txHash}`);
          return true;
        }
        // Reconcile the reported winner against the actual on-chain depositors.
        // settle() reverts NotAPlayer otherwise, wasting gas and burning retries
        // until the pot is stuck in Active forever. Fail loudly instead.
        const winner = job.winnerWallet.toLowerCase();
        if (winner !== playerA.toLowerCase() && winner !== playerB.toLowerCase()) {
          await this.deps.store.markSettlement(job.gameId, 'failed', attempts);
          const msg = `[settlement][ALERT] winner ${job.winnerWallet} is not an on-chain player (A=${playerA}, B=${playerB}) for game ${job.gameId}. NOT settling; manual review — funds are locked in Active escrow.`;
          console.error(msg);
          this.deps.onAlert?.(msg);
          return true;
        }
        const txHash = await this.deps.arbiter.submitSettle(job.gameId, job.winnerWallet as Address, job.reveal);
        await this.deps.store.markSettlement(job.gameId, 'settled', attempts, txHash);
        this.deps.onSettled(job.gameId, txHash);
        console.log(`[settlement] ${job.gameId} settled in tx ${txHash}`);
        return true;
      }

      if (status === GameStatus.WaitingOpponent) {
        // Only one player staked: refund them once JOIN_TIMEOUT elapses (E3.4).
        // Reached by both settle jobs (a game that finished lone-staked) and
        // refund jobs (a pre-Room abort where one side deposited).
        const readyAt = createdAt + JOIN_TIMEOUT_S;
        const waitS = readyAt - this.nowS();
        if (waitS > 0) {
          console.log(`[settlement] ${job.gameId} awaiting refund window (${waitS}s)`);
          this.reschedule(job, (waitS + 3) * 1_000); // small buffer past the timeout
          return false; // not terminal — will run again after the wait
        }
        const txHash = await this.deps.arbiter.submitRefund(job.gameId);
        await this.deps.store.markSettlement(job.gameId, 'refunded', attempts, txHash);
        this.deps.onRefunded(job.gameId, txHash);
        console.log(`[settlement] ${job.gameId} refunded in tx ${txHash}`);
        return true;
      }

      // A refund job that finds nobody staked (None) is a clean no-op: neither
      // matched player deposited, so there is nothing to recover.
      if (isRefund && status === GameStatus.None) {
        await this.deps.store.markSettlement(job.gameId, 'refunded', attempts);
        return true;
      }

      // Already resolved on-chain, or nobody staked (None): nothing to do.
      const terminal = status === GameStatus.Settled ? 'settled' : status === GameStatus.Refunded ? 'refunded' : 'failed';
      await this.deps.store.markSettlement(job.gameId, terminal, attempts);
      if (terminal === 'failed') console.warn(`[settlement] ${job.gameId} not stakeable (status ${status}); skipping`);
      return true;
    } catch (e) {
      console.error(`[settlement] ${job.gameId} attempt ${attempts} failed:`, e instanceof Error ? e.message : e);
      if (attempts >= MAX_ATTEMPTS) {
        await this.deps.store.markSettlement(job.gameId, 'failed', attempts);
        // A winner was NOT paid after every retry — this needs a human. Emit a
        // loud, greppable alert (an error tracker / pager hooks in via onAlert).
        const msg = `[settlement][ALERT] PAYOUT FAILED after ${attempts} attempts — game ${job.gameId}, winner ${job.winnerWallet || '(refund)'}, chain ${job.chainId}. Funds may be locked in escrow; manual settle/refund required.`;
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
      return false; // retrying — the retry's own run fires onTerminal
    }
  }
}
