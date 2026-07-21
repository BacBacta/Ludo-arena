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

/** Per-wallet lifetime cap on gas-seed grants, as a multiple of the seed target.
 *  Balance-based top-ups (below) re-fund a wallet whose balance dropped, so an
 *  attacker cycling "receive seed → transfer out → ask again" could drain the
 *  pool through one wallet; this bounds that wallet's lifetime draw to
 *  seedCents × SEED_LIFETIME_MULT (the device fingerprint gates fresh wallets,
 *  the pool cap is the global backstop). 3 = the initial seed + two rescues. */
export const SEED_LIFETIME_MULT = 3;

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
  readonly quotaCents: number;
  readonly poolCents: number;
  readonly endsAt?: string;
  readonly jit: boolean;
  readonly perGameCents: number;
  readonly feeInStable: boolean;
  readonly seedCents: number;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly chain: Chain;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly walletClient: ReturnType<typeof createWalletClient>;
  private decimalsCache: number | null = null;

  constructor(chain: Chain, racePass: Address, stablecoin: Address, faucetKey: Hex, cfg: RaceConfig, rpc?: string) {
    this.chainId = chain.id;
    this.chain = chain;
    this.racePass = getAddress(racePass);
    this.stablecoin = getAddress(stablecoin);
    this.quotaCents = cfg.quotaCents;
    this.poolCents = cfg.poolCents;
    this.endsAt = cfg.endsAt;
    this.jit = cfg.jit;
    this.perGameCents = cfg.perGameCents;
    this.feeInStable = cfg.feeInStable;
    this.seedCents = cfg.seedCents;
    this.account = privateKeyToAccount(faucetKey);
    const transport = http(rpc);
    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account: this.account, chain, transport });
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
  async fund(to: Address, cents: number): Promise<Hex> {
    const amount = await this.toUnits(cents);
    // Celo fee abstraction: pay this transfer's gas in the stablecoin itself, so
    // the faucet wallet never needs native CELO (B1). `feeCurrency` is a Celo
    // (CIP-64) field — only set when configured, and viem carries it through on a
    // Celo chain. The cast keeps the generic Chain type quiet, same as settlement.
    const feeExtra = this.feeInStable ? { feeCurrency: this.stablecoin } : {};
    const hash = await this.walletClient.writeContract({
      account: this.account,
      chain: this.chain,
      address: this.stablecoin,
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [getAddress(to), amount],
      ...feeExtra,
    } as Parameters<typeof this.walletClient.writeContract>[0]);
    const r = await this.publicClient.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error('faucet transfer reverted');
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
  const perGameCents = Math.max(1, Number(env.RACE_PER_GAME_CENTS ?? '2')); // 1¢ stake + gas buffer
  // B1 (non-MiniPay launch): pay faucet gas in cUSD so the faucet wallet needs no
  // native CELO. Opt-in (Celo fee abstraction only), default off → unchanged.
  const feeInStable = (env.RACE_FEE_IN_STABLE ?? '').trim() === 'true';
  // B1 gas-seed: cents sent pre-mint so a burner can pay its own gas in cUSD.
  // Default 0 (off) → the seed endpoint is dormant unless a non-MiniPay launch
  // explicitly provisions it. Only meaningful with feeInStable on Celo.
  const seedCents = Math.max(0, Number(env.RACE_SEED_CENTS ?? '0'));
  const rpc = env.SETTLEMENT_RPC?.trim() || undefined;
  const pk = (key.startsWith('0x') ? key : `0x${key}`) as Hex;
  return new RaceFaucet(chain, racePass, stablecoin, pk, { quotaCents, poolCents, endsAt, jit, perGameCents, feeInStable, seedCents }, rpc);
}
