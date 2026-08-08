/**
 * Race Week faucet (event onboarding). A player mints their soulbound RacePass
 * on-chain (see RacePass.sol); this module (1) VERIFIES that mint — read-only,
 * exactly like the cosmetics Purchased verifier — as the anti-sybil entry proof,
 * then (2) FUNDS a tiny stake budget to the player's wallet so they can play the
 * subsidised event games. Funding is bounded three ways: a per-player quota, a
 * total pool cap, and one grant per wallet (the Pass is soulbound → one per
 * MiniPay wallet → one per phone). Amounts are trivial (a few cents) so the
 * "claim and never play" risk is economically negligible and pool-capped.
 *
 * Testnet: fund with MockUSDT (the faucet wallet is pre-minted a balance).
 * Mainnet: fund with real cUSD from a pre-funded faucet wallet — same transfer
 * path, so no code change; only the token + the faucet's balance differ.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  toBytes,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS } from './settlement.js';
import { createCip64FeeResolver, type Cip64Override } from './cip64Fees.js';

/** topic0 of Minted(address indexed holder, uint256 indexed tokenId). */
const MINTED_TOPIC = keccak256(toBytes('Minted(address,uint256)')).toLowerCase();

const ERC20_TRANSFER_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

/** JIT initial grant at claim time: one stake (perGameCents), but never more
 *  than the wallet's whole quota. Pure so the accounting is unit-testable. */
export function jitClaimCents(perGameCents: number, quotaCents: number): number {
  return Math.max(0, Math.min(perGameCents, quotaCents));
}

/** JIT top-up after a COMPLETED event game: the next stake, bounded by (a) the
 *  wallet's remaining quota (quotaCents − already funded) and (b) the pool's
 *  remaining budget (poolCents − already spent). Returns 0 when the wallet has
 *  drawn its full quota or the pool is dry — the game still scores, it just isn't
 *  re-funded. Pure so the drip accounting is unit-testable without a chain. */
export function jitTopUpCents(perGameCents: number, funded: number, quotaCents: number, spent: number, poolCents: number): number {
  const remainingQuota = quotaCents - funded;
  const poolLeft = poolCents - spent;
  if (remainingQuota <= 0 || poolLeft <= 0) return 0;
  return Math.max(0, Math.min(perGameCents, remainingQuota, poolLeft));
}

/** Balance-aware JIT drip: the top-up is a SAFETY NET for a wallet that cannot
 *  afford the next event game, not an unconditional per-game payout — a player
 *  whose wallet already covers stake+gas (winners funding themselves from
 *  winnings) draws NOTHING, and a partially-drained wallet draws only its
 *  deficit. `balanceCents = null` (balance read failed) fails OPEN to the
 *  normal drip: an RPC hiccup must never freeze a legitimate player out of the
 *  event — quota + pool caps still bound the worst case. Unspent quota stays
 *  available for when the wallet really drains. */
export function jitDripCents(perGameCents: number, funded: number, quotaCents: number, spent: number, poolCents: number, balanceCents: number | null): number {
  const deficit = balanceCents === null ? perGameCents : seedDeficitCents(perGameCents, balanceCents);
  return Math.min(jitTopUpCents(perGameCents, funded, quotaCents, spent, poolCents), deficit);
}

/** Per-wallet lifetime cap on gas-seed grants, as a multiple of the seed target.
 *  Balance-based top-ups (below) re-fund a wallet whose balance dropped, so an
 *  attacker cycling "receive seed → transfer out → ask again" could drain the
 *  pool through one wallet; this bounds that wallet's lifetime draw to
 *  seedCents × SEED_LIFETIME_MULT (the device fingerprint gates fresh wallets,
 *  the pool cap is the global backstop). 3 = the initial seed + two rescues. */
export const SEED_LIFETIME_MULT = Math.max(1, Math.trunc(Number(process.env.RACE_SEED_WALLET_MULT ?? '3')) || 3);

/** Per-FINGERPRINT lifetime cap multiple (seed draws AND claim wallets). The
 *  client fingerprint is UA + language + screen + timezone + cores — two phones
 *  of the SAME popular model in the same region hash IDENTICALLY, so an
 *  "fingerprint" is really a device-model COHORT, not one device. When this cap
 *  equalled the per-wallet ×3, the first 3 players of a cohort consumed the
 *  allowance and every later new player on that phone model was refused the gas
 *  seed ("This device already used its gas-seed allowance") — their mint then
 *  died on funds (the campaign-launch incident). ×30 admits ~30 players per
 *  cohort; scripted abuse of one fingerprint stays bounded (seedCents × 30 =
 *  $3 lifetime) and the pool budget remains the global backstop. Env-tunable
 *  (RACE_SEED_FP_MULT) so ops can tighten/loosen without a deploy. */
export const SEED_FP_LIFETIME_MULT = Math.max(1, Number(process.env.RACE_SEED_FP_MULT ?? '30'));

/** How many cents the wallet is MISSING to reach the seed target, given its live
 *  on-chain balance. This — not "was the target ever granted" — must drive the
 *  seed: a failed mint attempt still burns its cUSD gas, so a wallet that drew
 *  its full grant can sit BELOW the mint's gas reservation with no way back
 *  (the drained-burner trap; the #54 top-up only covered a RAISED target). */
export function seedDeficitCents(targetCents: number, balanceCents: number): number {
  return Math.max(0, targetCents - balanceCents);
}

/** The cents to actually grant for `deficit`, bounded by (a) the wallet's
 *  remaining lifetime allowance (lifetimeCapCents − granted) and (b) the pool's
 *  remaining budget (poolCents − spent). 0 = nothing to grant (no deficit, cap
 *  reached, or pool dry). Pure so the accounting is unit-testable. */
export function seedGrantCents(deficit: number, granted: number, lifetimeCapCents: number, spent: number, poolCents: number): number {
  const capLeft = lifetimeCapCents - granted;
  const poolLeft = poolCents - spent;
  if (deficit <= 0 || capLeft <= 0 || poolLeft <= 0) return 0;
  return Math.max(0, Math.min(deficit, capLeft, poolLeft));
}

// The provisioned Race Week budget is spent along two dimensions:
//   • PRIZE — entry grants + JIT top-ups: cUSD that becomes a stake and can be
//     WON back through a game. This is the only dimension players see as the pool.
//   • GAS   — cUSD seeded to burners to pay their OWN gas: a pure operational cost
//     of the faucet wallet, never winnable.
// Both leave the one faucet wallet, so the budget CAP bounds their sum, but the
// gauge shows only the prize dimension (gas seeding must not read as "the faucet
// eats the prize pool" — the faucet is a distinct wallet).

/** Player-facing prize pool remaining = provisioned pool − PRIZE draws only.
 *  Gas seeds never reduce this. */
export function poolLeftCents(poolCents: number, prizeSpent: number): number {
  return Math.max(0, poolCents - prizeSpent);
}

/** Total budget headroom the faucet may still commit = provisioned pool − BOTH
 *  dimensions. Every draw (grant, JIT, gas seed) is bounded by this so the one
 *  faucet wallet never over-commits its provisioned budget. */
export function budgetLeftCents(poolCents: number, prizeSpent: number, seedSpent: number): number {
  return Math.max(0, poolCents - prizeSpent - seedSpent);
}

/** The cents a DEVICE has already drawn from the gas seed, parsed from its
 *  `race:seedfp:` meta row. Legacy rows stored the seeded wallet's address
 *  (the old one-shot gate) — parsed as one full draw of `targetCents`. Empty /
 *  missing rows (never seeded, or a rolled-back grant) are 0. */
export function seedFpDrawCents(raw: string | null, targetCents: number): number {
  if (!raw) return 0;
  try {
    const cents = (JSON.parse(raw) as { cents?: number }).cents;
    return typeof cents === 'number' && cents >= 0 ? cents : targetCents;
  } catch {
    return targetCents; // legacy row: the bare wallet address = one full draw
  }
}

// ---------------------------------------------------------------------------
// NATIVE gas sponsorship (external wallets). MetaMask/WalletConnect cannot sign
// CIP-64, so the cUSD seed is useless to them: their gas is native CELO or
// nothing. "The platform sponsors the mint" therefore means a second, tiny
// faucet dimension denominated in WEI, with the SAME shape as the cUSD seed —
// deficit-aware, wallet ×SEED_LIFETIME_MULT, device ×SEED_FP_LIFETIME_MULT,
// its own pool cap — but its own counters, because wei and cents must never be
// added together.
// ---------------------------------------------------------------------------

/** Wei the wallet is MISSING to reach the native sponsorship target, from its
 *  live balance. Mirrors seedDeficitCents: what the wallet HOLDS drives the
 *  grant, not what was ever granted (a failed mint still burnt its gas). */
export function nativeSeedDeficitWei(targetWei: bigint, balanceWei: bigint): bigint {
  return targetWei > balanceWei ? targetWei - balanceWei : 0n;
}

/** Wei to actually send for `deficit`, bounded by the wallet's remaining
 *  lifetime allowance and the sponsor pool's remaining budget. Mirrors
 *  seedGrantCents, in bigint (wei overflows Number). */
export function nativeSeedGrantWei(deficitWei: bigint, grantedWei: bigint, lifetimeCapWei: bigint, spentWei: bigint, poolWei: bigint): bigint {
  const capLeft = lifetimeCapWei - grantedWei;
  const poolLeft = poolWei - spentWei;
  if (deficitWei <= 0n || capLeft <= 0n || poolLeft <= 0n) return 0n;
  const bounded = deficitWei < capLeft ? deficitWei : capLeft;
  return bounded < poolLeft ? bounded : poolLeft;
}

/** Cumulative wei drawn, parsed from a `race:nseed:` / `race:nseedfp:` /
 *  spent-counter meta row. Rows store JSON `{ wei: "123" }` (stringified —
 *  JSON.stringify(bigint) throws and Number loses precision); a bare digit
 *  string is accepted for the plain spent counter. Empty / missing rows are 0:
 *  these rows are only ever written by this server in the two shapes below, so
 *  anything else is the rollback tombstone (''), which genuinely is 0. */
export function nativeDrawWei(raw: string | null): bigint {
  if (!raw) return 0n;
  if (/^\d+$/.test(raw.trim())) return BigInt(raw.trim());
  try {
    const wei = (JSON.parse(raw) as { wei?: unknown }).wei;
    return typeof wei === 'string' && /^\d+$/.test(wei) ? BigInt(wei) : 0n;
  } catch {
    return 0n;
  }
}

/** Parse a decimal-CELO env knob ("0.002") into wei, falling back on garbage —
 *  the same NaN hazard as policy.ts: a typo'd Fly secret must not turn into a
 *  0-wei (silently OFF) or a huge (pool-draining) sponsorship. */
export function parseCeloEnvWei(raw: string | undefined, fallbackWei: bigint): bigint {
  const v = raw?.trim();
  if (!v) return fallbackWei;
  if (!/^\d+(\.\d{1,18})?$/.test(v)) {
    console.warn(`[race] ignoring malformed CELO amount "${v}" — using default`);
    return fallbackWei;
  }
  const [whole, frac = ''] = v.split('.');
  return BigInt(whole!) * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}

/** The wallets a DEVICE has already claimed the Race Week grant with, parsed
 *  from its `race:fp:` meta row. Legacy rows stored one bare wallet address —
 *  parsed as that one wallet. Empty / missing rows (never claimed, or a
 *  rolled-back claim) are none. */
export function claimFpWallets(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const w = (JSON.parse(raw) as { wallets?: unknown }).wallets;
    return Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string') : [raw];
  } catch {
    return [raw]; // legacy row: the bare claiming-wallet address
  }
}

/** The player-facing message for a failed faucet transfer, shared by the seed
 *  and claim paths. Dry faucet (balance below the grant + a gas margin — the
 *  transfer's own gas is paid from the same balance under feeInStable) is the
 *  one failure retrying can never fix, so it is named explicitly; anything else
 *  surfaces the underlying cause (viem's shortMessage), truncated toast-size.
 *  An unreadable balance (null) never claims "dry". */
export function faucetFailureMessage(kind: 'seed' | 'claim', faucetCents: number | null, sendingCents: number, cause: string): string {
  if (faucetCents !== null && faucetCents < sendingCents + 5) {
    return 'Race Week faucet is out of funds — refill pending, check back soon.';
  }
  const label = kind === 'seed' ? 'Gas seed' : 'Funding';
  return `${label} failed — try again in a moment. (${cause.slice(0, 140)})`;
}

export interface RaceConfig {
  /** Cents funded to each eligible player (their whole quota for the event). */
  quotaCents: number;
  /** Total cents the event will ever fund (the provisioned pool). */
  poolCents: number;
  /** ISO end time for the client countdown (optional, display-only). */
  endsAt?: string;
  /** Anti-"claim-and-run" (mainnet): fund the quota ONE stake at a time instead of
   *  as a lump sum. The player gets `perGameCents` at entry, then a top-up after
   *  each COMPLETED event game (up to `quotaCents`). A player who claims and never
   *  plays keeps only that first `perGameCents` — the fund-and-run loss is bounded
   *  to one stake instead of the whole quota. Off (false) = legacy lump-sum grant. */
  jit: boolean;
  /** In JIT mode: cents granted per game (one stake + a small gas buffer). */
  perGameCents: number;
  /** Celo fee abstraction (B1, non-MiniPay launch): pay the faucet's own transfer
   *  gas in the STABLECOIN (`feeCurrency`) instead of native CELO. Lets the faucet
   *  wallet hold ONLY cUSD — no CELO to top up. Celo-only (CIP-64); leave false on
   *  chains without fee abstraction. */
  feeInStable: boolean;
  /** B1 gas-seed: cents of cUSD sent to a burner BEFORE its Pass mint so it can
   *  pay the mint + join gas (in cUSD). 0 disables the seed endpoint. Tiny — it
   *  only has to cover a few cents of Celo gas. */
  seedCents: number;
  /** NATIVE sponsorship target per external wallet, in wei (MetaMask/WC can't
   *  sign CIP-64 → their gas is CELO or nothing). 0n disables the native path.
   *  The faucet wallet must hold native CELO for this — feeInStable does not
   *  cover it. */
  nativeSeedWei: bigint;
  /** Total wei the native sponsorship may ever send (its own pool cap — wei and
   *  cents are never added together). */
  nativePoolWei: bigint;
}

/** Has the campaign passed its own announced end? `endsAt` used to be a
 *  display-only field while the event's `active` flag was hardcoded true, so a
 *  finished campaign kept running — card shown, Passes mintable, faucet
 *  seeding — until an operator remembered to disarm it by hand (Race Week ran a
 *  full day past its close). Every money path now reads this.
 *
 *  Unset or unparseable `endsAt` = NOT over: an open-ended campaign is the
 *  legacy behaviour, and a typo'd date must never silently kill a live event —
 *  the same fail-safe direction as parseCeloEnvWei. */
export function raceIsOver(endsAt: string | undefined, nowMs: number): boolean {
  if (!endsAt) return false;
  const end = Date.parse(endsAt);
  return Number.isFinite(end) && nowMs >= end;
}

/** Client-facing Race Week state (in hello.ok): whether the event is on, the
 *  funding quota, the end time, and whether THIS wallet already claimed. */
export interface RaceState {
  active: boolean;
  quotaCents: number;
  endsAt?: string;
  funded: boolean; // this wallet already received its one-time grant
  poolLeftCents: number;
  poolCents: number; // total provisioned pool (drives the client's gauge)
}

export class RaceFaucet {
  readonly chainId: number;
  readonly racePass: Address;
  readonly stablecoin: Address;
  /** CIP-64 gas token (adapter for a 6-dec stake token; == stablecoin for cUSD). */
  readonly feeCurrency: Address;
  readonly quotaCents: number;
  readonly poolCents: number;
  readonly endsAt?: string;
  readonly jit: boolean;
  readonly perGameCents: number;
  readonly feeInStable: boolean;
  readonly seedCents: number;
  readonly nativeSeedWei: bigint;
  readonly nativePoolWei: bigint;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly chain: Chain;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly walletClient: ReturnType<typeof createWalletClient>;
  private decimalsCache: number | null = null;
  /** Explicit CIP-64 cap for every faucet transfer (seed / grant / JIT drip). */
  private readonly cip64Fees: () => Promise<Cip64Override>;

  constructor(chain: Chain, racePass: Address, stablecoin: Address, faucetKey: Hex, cfg: RaceConfig, rpc?: string, feeCurrency?: Address) {
    this.chainId = chain.id;
    this.chain = chain;
    this.racePass = getAddress(racePass);
    this.stablecoin = getAddress(stablecoin);
    // Gas token: the adapter when given, else the stake token itself (cUSD case).
    this.feeCurrency = feeCurrency ? getAddress(feeCurrency) : this.stablecoin;
    this.quotaCents = cfg.quotaCents;
    this.poolCents = cfg.poolCents;
    this.endsAt = cfg.endsAt;
    this.jit = cfg.jit;
    this.perGameCents = cfg.perGameCents;
    this.feeInStable = cfg.feeInStable;
    this.seedCents = cfg.seedCents;
    this.nativeSeedWei = cfg.nativeSeedWei;
    this.nativePoolWei = cfg.nativePoolWei;
    this.account = privateKeyToAccount(faucetKey);
    const transport = http(rpc);
    // 1s receipt polling (Celo block time) — the default 4s made every faucet
    // transfer (gas seed, entry grant, JIT drip) read as UI lag to the player.
    this.publicClient = createPublicClient({ chain, transport, pollingInterval: 1_000 });
    this.walletClient = createWalletClient({ account: this.account, chain, transport });
    // 3x headroom: the faucet is a plain ERC-20 transfer (~100k gas), so even a
    // generous cap reserves a fraction of a cent — cheap insurance against a
    // base-fee spike between estimate and mine, which is what stranded the seed.
    this.cip64Fees = createCip64FeeResolver(this.publicClient as never, this.feeCurrency, 3n, 'race-faucet');
  }

  get address(): Address {
    return this.account.address;
  }

  /** True iff `txHash` is a mined success that emitted Minted(holder, tokenId)
   *  from THIS RacePass for `holder` — proof the wallet really holds a Pass. */
  async verifyPassMint(txHash: Hex, holder: Address): Promise<boolean> {
    const want = getAddress(holder);
    let receipt: Awaited<ReturnType<typeof this.publicClient.getTransactionReceipt>>;
    try {
      receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
    } catch {
      return false; // unknown / unmined
    }
    if (receipt.status !== 'success') return false;
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== this.racePass) continue;
      if ((log.topics[0] ?? '').toLowerCase() !== MINTED_TOPIC) continue;
      const holderTopic = log.topics[1];
      if (!holderTopic) continue;
      if (getAddress(('0x' + holderTopic.slice(26)) as Address) === want) return true;
    }
    return false;
  }

  private async decimals(): Promise<number> {
    if (this.decimalsCache !== null) return this.decimalsCache;
    const d = (await this.publicClient.readContract({ address: this.stablecoin, abi: ERC20_TRANSFER_ABI, functionName: 'decimals' })) as number;
    this.decimalsCache = d;
    return d;
  }

  /** cents → token base units (USDT 6dp: 1¢ = 10_000). */
  private async toUnits(cents: number): Promise<bigint> {
    const d = await this.decimals();
    // cents = dollars*100; base = dollars * 10^d = cents * 10^d / 100
    return (BigInt(cents) * 10n ** BigInt(d)) / 100n;
  }

  /** Any address's stablecoin balance, in cents. The gas-seed handler reads the
   *  BURNER's live balance with this — the top-up decision keys on what the wallet
   *  actually holds on-chain, not on what was ever granted (see seedDeficitCents). */
  async balanceCentsOf(addr: Address): Promise<number> {
    const [bal, d] = await Promise.all([
      this.publicClient.readContract({ address: this.stablecoin, abi: ERC20_TRANSFER_ABI, functionName: 'balanceOf', args: [getAddress(addr)] }) as Promise<bigint>,
      this.decimals(),
    ]);
    return Number((bal * 100n) / 10n ** BigInt(d));
  }

  /** The faucet wallet's remaining stablecoin balance, in cents (runway guard). */
  async faucetBalanceCents(): Promise<number> {
    return this.balanceCentsOf(this.account.address);
  }

  /** Send `cents` of the stablecoin to `to`. Waits for the receipt so the caller
   *  only records the grant once it's actually mined. Throws on revert. */
  async fund(to: Address, cents: number, retryDelayMs = 2500): Promise<Hex> {
    const amount = await this.toUnits(cents);
    // Celo fee abstraction: pay this transfer's gas in the stablecoin itself, so
    // the faucet wallet never needs native CELO (B1). `feeCurrency` is a Celo
    // (CIP-64) field — only set when configured, and viem carries it through on a
    // Celo chain. The cast keeps the generic Chain type quiet, same as settlement.
    // EXPLICIT CIP-64 cap (not viem's estimate). A bare `{ feeCurrency }` let the
    // node reject the transfer with "the fee cap cannot be lower than the block
    // base fee" — which players saw as "Gas seed failed — try again in a moment"
    // and which then stranded every Race stake lock, because the burner never
    // received the gas it needed to approve+join. See ./cip64Fees.
    const feeExtra = this.feeInStable ? await this.cip64Fees() : {};
    const send = (): Promise<Hex> =>
      this.walletClient.writeContract({
        account: this.account,
        chain: this.chain,
        address: this.stablecoin,
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [getAddress(to), amount],
        ...feeExtra,
      } as Parameters<typeof this.walletClient.writeContract>[0]);
    let hash: Hex;
    try {
      hash = await send();
    } catch {
      // A failed BROADCAST never reached the chain, so ONE retry is double-spend
      // safe — and once a hash exists we never resend (a resend there could pay
      // twice). This absorbs a load-balanced RPC's transient failures, above all
      // a stale pending nonce right after a previous faucet tx (the seed → claim
      // transfers land within a minute of each other): wait out a block so viem
      // re-derives nonce + fees from a fresh node view.
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      hash = await send();
    }
    const r = await this.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error('faucet transfer reverted');
    return hash;
  }

  /** Any address's NATIVE CELO balance in wei (the sponsorship dimension for
   *  external wallets — their gas is native, so the stablecoin read says
   *  nothing about whether they can mint). */
  async nativeBalanceWeiOf(addr: Address): Promise<bigint> {
    return this.publicClient.getBalance({ address: getAddress(addr) });
  }

  /** The faucet wallet's own native CELO, in wei. feeInStable keeps its cUSD
   *  runway independent of this — but the NATIVE sponsorship spends from here,
   *  and an ops top-up (plain CELO transfer to `address`) is what refills it. */
  async faucetNativeWei(): Promise<bigint> {
    return this.nativeBalanceWeiOf(this.account.address);
  }

  /** Send `wei` of native CELO to `to` (external-wallet gas sponsorship). Same
   *  contract as `fund`: waits for the receipt so the caller records the draw
   *  only once mined; one broadcast retry (double-spend safe — a failed
   *  broadcast never reached the chain, and once a hash exists we never
   *  resend). The transfer's OWN gas follows feeInStable, so the faucet's CELO
   *  runway is spent on sponsorships only, not on carrying them. */
  async fundNative(to: Address, wei: bigint, retryDelayMs = 2500): Promise<Hex> {
    const feeExtra = this.feeInStable ? await this.cip64Fees() : {};
    const send = (): Promise<Hex> =>
      this.walletClient.sendTransaction({
        account: this.account,
        chain: this.chain,
        to: getAddress(to),
        value: wei,
        ...feeExtra,
      } as Parameters<typeof this.walletClient.sendTransaction>[0]);
    let hash: Hex;
    try {
      hash = await send();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      hash = await send();
    }
    const r = await this.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error('native sponsorship transfer reverted');
    return hash;
  }

  async healthcheck(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }
}

interface DeploymentR {
  chainId: number;
  racePass?: Address;
  stablecoin?: Address;
  /** CIP-64 gas fee-currency adapter, distinct from `stablecoin` when the token
   *  isn't 18-dec (USD₮). Absent for cUSD (its own fee currency). */
  feeCurrencyAdapter?: Address;
}

/** Build the faucet from env + deployments.json, or null when Race Week isn't
 *  armed (RACE_WEEK_ACTIVE != true, no RACE_FAUCET_PRIVATE_KEY, or the RacePass
 *  isn't deployed on this chain) → the race.claim path stays dormant. */
export function createRaceFaucet(env: NodeJS.ProcessEnv = process.env): RaceFaucet | null {
  if ((env.RACE_WEEK_ACTIVE ?? '').trim() !== 'true') return null;
  const key = (env.RACE_FAUCET_PRIVATE_KEY ?? '').trim();
  if (!key) return null;
  const chain = CHAINS[env.CHAIN?.trim() || 'celo-sepolia'];
  if (!chain) return null;

  const deploymentsPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'contracts', 'deployments.json');
  let dep: DeploymentR | undefined;
  try {
    const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8')) as Record<string, DeploymentR>;
    dep = Object.values(deployments).find((d) => d.chainId === chain.id);
  } catch {
    /* no deployments file bundled */
  }
  const racePass = (env.RACE_PASS_ADDRESS?.trim() as Address | undefined) ?? dep?.racePass;
  const stablecoin = (env.RACE_STABLECOIN_ADDRESS?.trim() as Address | undefined) ?? dep?.stablecoin;
  if (!racePass || !stablecoin) return null; // RacePass not deployed here yet

  const quotaCents = Number(env.RACE_QUOTA_CENTS ?? '20'); // total per wallet
  const poolCents = Number(env.RACE_POOL_CENTS ?? '5000'); // $50 provisioned
  const endsAt = env.RACE_ENDS_AT?.trim() || undefined;
  // Anti-fund-and-run (mainnet): drip the quota one stake at a time instead of a
  // lump sum. Default OFF → the current lump-sum event is unaffected until armed.
  const jit = (env.RACE_JIT_FUNDING ?? '').trim() === 'true';
  // 4¢ = the 1¢ stake + real margin. At 2¢ an external (MetaMask) wallet sat
  // right at the edge and its wallet-side checks read "insufficient balance"
  // when trying to stake. Balance-aware drip: a wallet already covered draws
  // NOTHING, so the raise only helps wallets that actually need it.
  const perGameCents = Math.max(1, Number(env.RACE_PER_GAME_CENTS ?? '4'));
  // B1 (non-MiniPay launch): pay faucet gas in cUSD so the faucet wallet needs no
  // native CELO. Opt-in (Celo fee abstraction only), default off → unchanged.
  const feeInStable = (env.RACE_FEE_IN_STABLE ?? '').trim() === 'true';
  // B1 gas-seed: cents sent pre-mint so a burner can pay its own gas in cUSD.
  // Default 0 (off) → the seed endpoint is dormant unless a non-MiniPay launch
  // explicitly provisions it. Only meaningful with feeInStable on Celo.
  const seedCents = Math.max(0, Number(env.RACE_SEED_CENTS ?? '0'));
  // NATIVE sponsorship (external wallets): CELO sent pre-mint to a
  // MetaMask/WalletConnect wallet, which cannot pay gas in the stablecoin
  // (no CIP-64). Defaults ON at 0.002 CELO/wallet with a 0.5 CELO pool — a
  // mint reserves ~1e-4 CELO, so one target covers the mint plus the event's
  // approve+join txs, and the pool bounds total exposure to ~250 wallets.
  // Requires the faucet wallet to HOLD native CELO (ops top-up); a dry faucet
  // fails each request with a message naming its balance, spending nothing.
  // 0.03 CELO (~1.2¢): ~300× a real mint fee (~3e-5 CELO) and ~20% above even
  // MetaMask's most inflated fee DISPLAY observed in production ("<0.01 $US" ≈
  // up to 0.025 CELO). The ladder of this default: 0.002 was enough on-chain
  // but inside wallet-reservation range; 0.01 cleared honest reservations;
  // 0.03 clears the dishonest ones too. Wallets must never bounce a sponsored
  // player on fees again — that is the entire promise of this seed.
  // 0.05: staking chains TWO more wallet-priced txs (approve + join) after the
  // mint, each carrying its own inflated fee reservation — one target must
  // cover the trio with margin ("insufficient balance to stake" report).
  const nativeSeedWei = parseCeloEnvWei(env.RACE_NATIVE_SEED_CELO, 50_000_000_000_000_000n); // 0.05 CELO
  const nativePoolWei = parseCeloEnvWei(env.RACE_NATIVE_POOL_CELO, 4_000_000_000_000_000_000n); // 4 CELO (~80 wallets)
  const rpc = env.SETTLEMENT_RPC?.trim() || undefined;
  const pk = (key.startsWith('0x') ? key : `0x${key}`) as Hex;
  // Gas fee-currency = FEE_CURRENCY ?? the deployment's adapter ?? the stake token
  // (correct for 18-dec cUSD; the 18-dec adapter for a 6-dec USD₮ stake token).
  const feeCurrency = (env.FEE_CURRENCY?.trim() as Address | undefined) ?? dep?.feeCurrencyAdapter ?? stablecoin;
  return new RaceFaucet(chain, racePass, stablecoin, pk, { quotaCents, poolCents, endsAt, jit, perGameCents, feeInStable, seedCents, nativeSeedWei, nativePoolWei }, rpc, feeCurrency);
}
