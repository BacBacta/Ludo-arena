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
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const CHAINS: Record<string, Chain> = {
  localhost: defineChain({ id: 31_337, name: 'Localhost', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } } }),
  'celo-sepolia': defineChain({ id: 11_142_220, name: 'Celo Sepolia', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } } }),
  celo: defineChain({ id: 42_220, name: 'Celo', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: ['https://forno.celo.org'] } } }),
};

interface Deployment {
  chainId: number;
  escrow?: Address;
  stablecoin?: Address;
  stablecoinDecimals?: number;
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

  /** The client-shaped stake lock: approve + escrow.join, the exact tuple a human
   *  client sends (apps/web/src/lib/escrow.ts). Resolves once BOTH tx are mined,
   *  so the caller's pollStakeLock can then see the escrow go Active. Gas paid in
   *  cUSD (CIP-64 feeCurrency) when configured, so the bot needs no native CELO. */
  async lockStake(gameId: string, stakeCents: number, fairnessCommit: string): Promise<Hex> {
    const units = this.units(stakeCents);
    const gameId32 = gameIdToBytes32(gameId);
    const commit32 = `0x${fairnessCommit.replace(/^0x/, '')}` as Hex;
    const feeExtra = this.feeCurrency ? { feeCurrency: this.feeCurrency } : {};
    return this.serialize(async () => {
      const approveHash = await this.walletClient.writeContract({
        account: this.account, chain: this.chain, address: this.stablecoin, abi: ERC20_ABI, functionName: 'approve', args: [this.escrow, units], ...feeExtra,
      } as never);
      const ar = await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
      if (ar.status !== 'success') throw new Error(`house-bot approve reverted (tx ${approveHash})`);
      const joinHash = await this.walletClient.writeContract({
        account: this.account, chain: this.chain, address: this.escrow, abi: ESCROW_JOIN_ABI, functionName: 'join', args: [gameId32, this.stablecoin, units, commit32], ...feeExtra,
      } as never);
      const jr = await this.publicClient.waitForTransactionReceipt({ hash: joinHash });
      if (jr.status !== 'success') throw new Error(`house-bot join reverted (tx ${joinHash})`);
      return joinHash;
    });
  }

  /** Bot's cUSD balance (base units) — a low-funds monitor can alert before the
   *  wallet can no longer cover a 1¢ stake + gas. */
  async balance(): Promise<bigint> {
    return this.publicClient.readContract({ address: this.stablecoin, abi: ERC20_ABI, functionName: 'balanceOf', args: [this.address] }) as Promise<bigint>;
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
  const stablecoin = (env.FEE_CURRENCY?.trim() as Address | undefined) ?? dep?.stablecoin;
  if (!escrow || !stablecoin) {
    console.error(`[house-bot] no escrow/stablecoin for chain ${chain.id} — house bot DISABLED (server stays up).`);
    return null;
  }
  const decimals = Number(dep?.stablecoinDecimals ?? 18);
  // Pay gas in the stablecoin (CIP-64) when FEE_IN_STABLE — same switch the
  // arbiter uses, so the bot wallet needs no native CELO on mainnet.
  const feeCurrency = (env.FEE_IN_STABLE ?? '').trim() === 'true' ? stablecoin : undefined;
  const pk = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
  const bot = new HouseBot(pk, chain, escrow, stablecoin, decimals, env.SETTLEMENT_RPC?.trim() || undefined, feeCurrency);
  console.log(`[house-bot] ARMED on ${chainName} (${bot.address}) — fills matchmaking + absorbs flagged farmers; games score ZERO and are tagged is_house_bot.`);
  return bot;
}
