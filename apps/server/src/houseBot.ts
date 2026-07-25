/**
 * Race Week HOUSE BOT (operator-owned) — a server-side opponent that fills
 * matchmaking on demand and, crucially, absorbs suspected farmers.
 *
 * WHY it exists (two goals, one mechanism):
 *   1. Liveliness: a real player who launches a Race search always finds an
 *      opponent, even when no human is online.
 *   2. Anti-farm honeypot: `raceScore.ts` only awards points when BOTH players
 *      are Race participants (hold a `race:grant`). The house bot NEVER claims a
 *      grant, so any game it plays scores ZERO for everyone. Routing a flagged
 *      farmer to the bot therefore silently kills the wash-trade — they stake,
 *      they play, they generate on-chain volume, but they climb nothing, and
 *      their accomplice is left unpaired.
 *
 * It stakes REAL cUSD (the 1¢ Race micro-tier) from an operator-funded wallet —
 * NOT the player-subsidy faucet — so every bot game is a genuine on-chain match
 * (approve + escrow.join, then the arbiter settles the winner exactly as for two
 * humans). Economically ~net-neutral over volume (blitz Ludo is near 50/50); the
 * real cost is gas per game (paid in cUSD via CIP-64 feeCurrency, no CELO needed).
 *
 * INTEGRITY: every bot game is tagged `is_house_bot` in the games table, so the
 * operator can always report human-only volume (never presenting house-generated
 * transactions as organic usage). See raceAudit for the human/bot split.
 *
 * SAFETY: gated behind RACE_HOUSE_BOT_ENABLED (default OFF). createHouseBot
 * returns null unless it is explicitly enabled AND a key + chain + escrow all
 * resolve — a misconfig disables the bot, it never crashes the box or blocks
 * real play. Arm it deliberately (fund the wallet, set the secret + flag) via the
 * fly-ops `arm-house-bot` step, exactly like STAKING_ENABLED / arm-mainnet.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { feeReservationWei } from '@ludo/shared';
import { CHAINS } from './settlement.js';
import { createCip64FeeResolver, type Cip64Override } from './cip64Fees.js';

/** Cap multiplier on the CALIBRATED fee floor. Generous on purpose: the bot has
 *  no adaptive retry ladder, so one cap-too-low reject aborts a human's game —
 *  and on the calibrated floor even 6x reserves ~2c per lock (vs ~176c before). */
const HOUSE_BOT_CAP_MULT = 6n;

/** Cap multipliers tried in order when a lock is rejected. Start at the standing
 *  multiplier (cheap reservation), then pay for certainty: Celo moves the base
 *  fee 12.5% per 1s block, so a tx that waits in the pool can face several times
 *  the floor we read — that is what a cap-too-low reject means. The tx only ever
 *  PAYS base+tip (EIP-1559 refunds the rest), so escalating costs the bot
 *  reservation headroom, not fees, and it holds dollars rather than the burner's
 *  10c seed. At the calm mainnet floor 60x still reserves well under 1% of its
 *  balance. */
const HOUSE_BOT_CAP_LADDER = [HOUSE_BOT_CAP_MULT, 20n, 60n] as const;

/** Gas limit used to SIZE the node's fee reservation for one bot tx (approve or
 *  join). The real limit is estimated per tx; this is a deliberate upper bound so
 *  the affordability preflight errs on the side of declining a game it might not
 *  be able to pay for, never on the side of stranding a human mid-lock. */
const LOCK_GAS_LIMIT = 250_000n;

/** What one stake lock costs the bot's balance at `capWei`: the stake it hands
 *  to the escrow PLUS the fee the node RESERVES up front (gasLimit × cap, not
 *  the fee actually paid — EIP-1559 refunds the difference, but the reservation
 *  is what a thin balance is checked against). `capWei` null = gas is paid in the
 *  native coin, so only the stake comes out of the stablecoin balance.
 *  Pure, so the runway arithmetic is unit-testable without a chain. */
export function botLockRequirement(stakeWei: bigint, gasLimit: bigint, capWei: bigint | null): bigint {
  return capWei === null ? stakeWei : stakeWei + feeReservationWei(gasLimit, capWei);
}

/** How many further locks a balance covers at that requirement (0 = the bot must
 *  stop filling matchmaking). */
export function locksAffordable(balanceWei: bigint, requiredWei: bigint): number {
  if (requiredWei <= 0n) return Number.MAX_SAFE_INTEGER;
  if (balanceWei < requiredWei) return 0;
  return Number(balanceWei / requiredWei);
}

/** Solvency snapshot for one prospective lock — the gate the matchmaker consults
 *  BEFORE pairing a human with the bot. */
export interface BotAffordability {
  /** Can the bot fund a stake + its gas reservation right now? */
  ok: boolean;
  balanceWei: bigint;
  stakeWei: bigint;
  /** gasLimit × cap the node holds per tx (0 when gas is paid in the native coin). */
  reservationWei: bigint;
  requiredWei: bigint;
  /** Remaining locks at this price — the runway the low-balance watchdog alerts on. */
  locksLeft: number;
  capWei: bigint | null;
  /** Human-readable cause when !ok (or when the check itself could not run). */
  reason?: string;
}

// The bot rides the SAME chain definitions as the arbiter/faucet (settlement.ts):
// viem's real `celo` chain, which carries the CIP-64 serializers (so a
// `feeCurrency` tx is encoded as a type-0x7b Celo tx, gas payable in cUSD) AND a
// widened base-fee multiplier (so approve/join clear Celo's spiky base fee). A
// hand-rolled `defineChain` here had NEITHER — invisible on hardhat (no CIP-64),
// but on mainnet it broke the bot's stake lock: the `feeCurrency` field could not
// be serialized / the tx was rejected under base-fee spikes, aborting the match.

interface Deployment {
  chainId: number;
  escrow?: Address;
  stablecoin?: Address;
  stablecoinDecimals?: number;
  /** CIP-64 gas fee-currency ADAPTER, distinct from `stablecoin` when the stake
   *  token isn't 18-decimals (e.g. USD₮ = 6 dec ⇒ gas must use its 18-dec
   *  adapter, NOT the raw token). Absent for cUSD, where the token IS its own
   *  fee currency. See docs/DEPLOY.md §stablecoin-migration. */
  feeCurrencyAdapter?: Address;
}

function loadDeployment(chainId: number): Deployment | undefined {
  // Bundled in the server image at the same relative path settlement.ts uses.
  const p = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'contracts', 'deployments.json');
  try {
    const all = JSON.parse(readFileSync(p, 'utf8')) as Record<string, Deployment>;
    return Object.values(all).find((d) => d.chainId === chainId);
  } catch {
    return undefined;
  }
}

const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const ESCROW_JOIN_ABI = [
  { type: 'function', name: 'join', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }, { name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' }, { name: 'fairnessCommit', type: 'bytes32' }], outputs: [] },
  // Read back the seats: what makes a RETRY safe. A join whose receipt was lost
  // (or that mined after we gave up) must not be re-sent — it would revert and
  // turn a SUCCESSFUL lock into an aborted match.
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

/** Canonical server gameId (16 bytes hex) → bytes32 — must match web/escrow.ts
 *  and settlement.ts (left-pad to 64 hex chars). */
function gameIdToBytes32(gameId: string): Hex {
  return `0x${gameId.replace(/^0x/, '').padStart(64, '0')}` as Hex;
}

/**
 * The house bot's on-chain arm + stable identity. One EOA; writeContract calls
 * are serialized on it so approve/join never race on the nonce (same discipline
 * as the arbiter). Presents a believable, indistinguishable opponent identity
 * (per the operator's disclosure choice) — but is ALWAYS excluded from scoring
 * and tagged in the games table.
 */
export class HouseBot {
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly walletClient: ReturnType<typeof createWalletClient>;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  readonly chain: Chain;
  readonly escrow: Address;
  readonly stablecoin: Address;
  readonly decimals: number;
  private readonly feeCurrency?: Address;
  private nonceChain: Promise<unknown> = Promise.resolve();
  /** Shared CIP-64 cap derivation (same module the Race faucet uses). */
  private readonly feeResolver: (multOverride?: bigint) => Promise<Cip64Override>;

  constructor(privateKey: Hex, chain: Chain, escrow: Address, stablecoin: Address, decimals: number, rpc?: string, feeCurrency?: Address) {
    this.account = privateKeyToAccount(privateKey);
    this.chain = chain;
    this.escrow = escrow;
    this.stablecoin = stablecoin;
    this.decimals = decimals;
    this.feeCurrency = feeCurrency;
    const transport = http(rpc);
    this.publicClient = createPublicClient({ chain, transport, pollingInterval: 1_000 });
    this.walletClient = createWalletClient({ account: this.account, chain, transport });
    this.feeResolver = createCip64FeeResolver(this.publicClient as never, this.feeCurrency, HOUSE_BOT_CAP_MULT, 'house-bot');
  }

  get address(): Address {
    return this.account.address;
  }

  /** cents → token base units at the stablecoin's decimals (1¢ cUSD = 1e16). */
  private units(cents: number): bigint {
    return (BigInt(Math.round(cents)) * 10n ** BigInt(this.decimals)) / 100n;
  }

  /** Serialize writes on the bot EOA so concurrent games can't collide on nonce. */
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.nonceChain.then(run, run);
    this.nonceChain = next.catch(() => undefined);
    return next;
  }

  /**
   * CIP-64 fee override, derived from the CURRENT block base fee and the
   * FeeCurrencyDirectory rate — the exact inputs the node uses to VALIDATE the
   * cap. Verified live on mainnet (probe-fees, 2026-07-24): forno's
   * `eth_gasPrice [feeCurrency]` quote applies the directory rate in the WRONG
   * direction (base 200 gwei native → quoted 14.2 gwei-cUSD, while validation
   * demands base × den/num ≈ 2 850 gwei-cUSD), so every estimation routed
   * through the node quote under-caps ~200× and is rejected with "fee cap
   * cannot be lower than block base fee" — the house bot could never lock.
   * Direction guard: `calibratedBaseFloor` (@ludo/shared) picks the conversion
   * direction the NODE's own quote agrees with and never caps below it. The
   * earlier unconditional MAX-of-both-directions over-capped ~215×, which the tx
   * never PAID (EIP-1559 refunds) but the node RESERVED — ~176c per join, i.e.
   * under three locks of runway. Re-derived before EVERY tx: Celo has 1s blocks
   * and the base fee moves.
   */
  private cip64Fees(multOverride?: bigint): Promise<Cip64Override> {
    return this.feeResolver(multOverride);
  }

  /** Has this bot ALREADY deposited into `gameId`? Read before every lock attempt
   *  so a retry can never double-join (the join would revert and abort a match
   *  that was in fact already funded). Fails OPEN: an unreadable escrow returns
   *  false and the attempt proceeds, exactly as before this guard existed. */
  private async alreadyJoined(gameId32: Hex): Promise<boolean> {
    try {
      const g = (await this.publicClient.readContract({
        address: this.escrow, abi: ESCROW_JOIN_ABI, functionName: 'games', args: [gameId32],
      })) as readonly [Address, bigint, Address, Address, number, number];
      const me = this.address.toLowerCase();
      return g[2].toLowerCase() === me || g[3].toLowerCase() === me;
    } catch {
      return false;
    }
  }

  /** The client-shaped stake lock: approve + escrow.join, the exact tuple a human
   *  client sends (apps/web/src/lib/escrow.ts). Resolves once BOTH tx are mined,
   *  so the caller's pollStakeLock can then see the escrow go Active. Gas paid in
   *  cUSD (CIP-64 feeCurrency) when configured, so the bot needs no native CELO. */
  async lockStake(gameId: string, stakeCents: number, fairnessCommit: string): Promise<Hex> {
    const units = this.units(stakeCents);
    const gameId32 = gameIdToBytes32(gameId);
    const commit32 = `0x${fairnessCommit.replace(/^0x/, '')}` as Hex;
    return this.serialize(async () => {
      // ADAPTIVE LADDER. The bot used to fire a single attempt at one multiplier,
      // and a match needs BOTH seats locked — so one cap-too-low reject on the
      // bot's side aborted the human's game. Meanwhile the web client retries and
      // escalates to 10x, which left the bot as the weak seat (players saw only
      // ~1 staked match in 3 land during base-fee spikes). Same answer as the
      // client: re-derive from a FRESH floor each attempt and pay for certainty
      // on the retry. The bot is a FUNDED wallet, so a fat cap costs it only
      // reservation headroom — the burner's 10c ceiling does not apply here.
      let lastError: unknown;
      for (let attempt = 0; attempt < HOUSE_BOT_CAP_LADDER.length; attempt++) {
        const mult = HOUSE_BOT_CAP_LADDER[attempt]!;
        try {
          // Idempotency FIRST, on every attempt: a previous attempt's join may
          // have mined after we stopped waiting. Re-sending it would revert and
          // abort a game that is in fact already funded.
          if (await this.alreadyJoined(gameId32)) return '0x' as Hex;
          const approveHash = await this.walletClient.writeContract({
            account: this.account, chain: this.chain, address: this.stablecoin, abi: ERC20_ABI, functionName: 'approve', args: [this.escrow, units], ...(await this.cip64Fees(mult)),
          } as never);
          const ar = await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
          if (ar.status !== 'success') throw new Error(`house-bot approve reverted (tx ${approveHash})`);
          const joinHash = await this.walletClient.writeContract({
            account: this.account, chain: this.chain, address: this.escrow, abi: ESCROW_JOIN_ABI, functionName: 'join', args: [gameId32, this.stablecoin, units, commit32], ...(await this.cip64Fees(mult)),
          } as never);
          const jr = await this.publicClient.waitForTransactionReceipt({ hash: joinHash });
          if (jr.status !== 'success') throw new Error(`house-bot join reverted (tx ${joinHash})`);
          return joinHash;
        } catch (e) {
          lastError = e;
          if (attempt < HOUSE_BOT_CAP_LADDER.length - 1) {
            console.warn(`[house-bot] lock attempt ${attempt + 1} failed at ${mult}x — escalating:`, e instanceof Error ? e.message : e);
          }
        }
      }
      throw lastError;
    });
  }

  /** Bot's cUSD balance (base units) — a low-funds monitor can alert before the
   *  wallet can no longer cover a 1¢ stake + gas. */
  async balance(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.stablecoin, abi: ERC20_ABI, functionName: 'balanceOf', args: [this.address] }) as Promise<bigint>;
  }

  /**
   * Can the bot fund ONE more lock right now (stake + the node's fee
   * reservation)? This is the gate that turns the historical SILENT failure into
   * a refusal: when the wallet ran dry the bot was still paired with humans, its
   * lock was rejected on funds, and the match aborted + refunded — the player
   * saw "stake lock failed" and the operator saw nothing. Declining to be
   * summoned instead leaves the seeker in the queue for a real human.
   *
   * Read live (no caching): the balance moves with every game and a stale
   * "affordable" is exactly the state that strands a player. One RPC on a path
   * that already does several, and only on the Race tier.
   */
  async affordability(stakeCents: number): Promise<BotAffordability> {
    const stakeWei = this.units(stakeCents);
    try {
      const fees = await this.cip64Fees();
      // No feeCurrency (native-gas chains) or a failed derivation that fell back
      // to node estimation ⇒ no token-denominated cap to reserve against; only
      // the stake leaves the stablecoin balance.
      const capWei = 'maxFeePerGas' in fees ? (fees.maxFeePerGas as bigint) : null;
      const balanceWei = await this.balance();
      const requiredWei = botLockRequirement(stakeWei, LOCK_GAS_LIMIT, capWei);
      const reservationWei = capWei === null ? 0n : feeReservationWei(LOCK_GAS_LIMIT, capWei);
      const locksLeft = locksAffordable(balanceWei, requiredWei);
      return {
        ok: balanceWei >= requiredWei,
        balanceWei,
        stakeWei,
        reservationWei,
        requiredWei,
        locksLeft,
        capWei,
        reason: balanceWei >= requiredWei ? undefined : `balance ${balanceWei} < required ${requiredWei} (stake ${stakeWei} + reservation ${reservationWei})`,
      };
    } catch (e) {
      // The check itself failed (RPC hiccup). Fail OPEN — a transient read must
      // not take the bot out of matchmaking — but say so loudly enough to trace.
      const reason = `affordability check failed: ${e instanceof Error ? e.message : String(e)}`;
      console.warn(`[house-bot] ${reason} — allowing the summon (fail-open)`);
      return { ok: true, balanceWei: 0n, stakeWei, reservationWei: 0n, requiredWei: 0n, locksLeft: -1, capWei: null, reason };
    }
  }
}

/**
 * Build the house bot from env + deployments, or null when it is disabled or not
 * fully configured. Gated OFF by default: even with a key present, the bot is
 * inert unless RACE_HOUSE_BOT_ENABLED === 'true'. Fails SOFT on any misconfig
 * (unknown chain / no escrow / no stablecoin) so it can never take real play down.
 */
export function createHouseBot(env: NodeJS.ProcessEnv = process.env): HouseBot | null {
  if ((env.RACE_HOUSE_BOT_ENABLED ?? '').trim() !== 'true') return null;
  const raw = env.RACE_HOUSE_BOT_PRIVATE_KEY?.trim();
  if (!raw) {
    console.error('[house-bot] RACE_HOUSE_BOT_ENABLED=true but RACE_HOUSE_BOT_PRIVATE_KEY is unset — house bot DISABLED (server stays up).');
    return null;
  }
  const chainName = env.CHAIN?.trim() || 'celo-sepolia';
  const chain = CHAINS[chainName];
  if (!chain) {
    console.error(`[house-bot] unknown CHAIN '${chainName}' — house bot DISABLED (server stays up).`);
    return null;
  }
  const dep = loadDeployment(chain.id);
  const escrow = (env.ESCROW_ADDRESS?.trim() as Address | undefined) ?? dep?.escrow;
  // STAKE TOKEN — the raw ERC-20 the bot approves + joins with (balances too).
  // RACE_STABLECOIN_ADDRESS overrides the deployment. NOT FEE_CURRENCY: that is
  // the GAS token, which for a 6-dec stake token (USD₮) is a DIFFERENT address
  // (its 18-dec adapter). Conflating them made the bot try to stake the adapter.
  const stablecoin = (env.RACE_STABLECOIN_ADDRESS?.trim() as Address | undefined) ?? dep?.stablecoin;
  if (!escrow || !stablecoin) {
    console.error(`[house-bot] no escrow/stablecoin for chain ${chain.id} — house bot DISABLED (server stays up).`);
    return null;
  }
  const decimals = Number(dep?.stablecoinDecimals ?? 18);
  // Pay gas in the stablecoin (CIP-64) so the bot wallet needs NO native CELO.
  // Honour EITHER switch: FEE_IN_STABLE (the arbiter's) OR RACE_FEE_IN_STABLE
  // (the Race faucet's, race.ts) — mainnet sets the latter, and the house bot
  // rides the Race tier, so without this the bot silently fell back to native
  // CELO gas and would strand on a cUSD-only wallet.
  const feeInStable = (env.FEE_IN_STABLE ?? '').trim() === 'true' || (env.RACE_FEE_IN_STABLE ?? '').trim() === 'true';
  // GAS fee-currency = FEE_CURRENCY ?? the deployment's adapter ?? the stake token
  // itself (correct for 18-dec cUSD, which is its own fee currency). For USD₮ this
  // resolves to the 18-dec adapter while the stake stays the raw 6-dec token.
  const feeCurrency = feeInStable
    ? ((env.FEE_CURRENCY?.trim() as Address | undefined) ?? dep?.feeCurrencyAdapter ?? stablecoin)
    : undefined;
  const pk = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
  const bot = new HouseBot(pk, chain, escrow, stablecoin, decimals, env.SETTLEMENT_RPC?.trim() || undefined, feeCurrency);
  console.log(`[house-bot] ARMED on ${chainName} (${bot.address}) — fills matchmaking + absorbs flagged farmers; games score ZERO and are tagged is_house_bot.`);
  return bot;
}
