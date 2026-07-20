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

export interface RaceConfig {
  /** Cents funded to each eligible player (their whole quota for the event). */
  quotaCents: number;
  /** Total cents the event will ever fund (the provisioned pool). */
  poolCents: number;
}

export class RaceFaucet {
  readonly chainId: number;
  readonly racePass: Address;
  readonly stablecoin: Address;
  readonly quotaCents: number;
  readonly poolCents: number;
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

  /** The faucet wallet's remaining stablecoin balance, in cents (runway guard). */
  async faucetBalanceCents(): Promise<number> {
    const [bal, d] = await Promise.all([
      this.publicClient.readContract({ address: this.stablecoin, abi: ERC20_TRANSFER_ABI, functionName: 'balanceOf', args: [this.account.address] }) as Promise<bigint>,
      this.decimals(),
    ]);
    return Number((bal * 100n) / 10n ** BigInt(d));
  }

  /** Send `cents` of the stablecoin to `to`. Waits for the receipt so the caller
   *  only records the grant once it's actually mined. Throws on revert. */
  async fund(to: Address, cents: number): Promise<Hex> {
    const amount = await this.toUnits(cents);
    const hash = await this.walletClient.writeContract({
      account: this.account,
      chain: this.chain,
      address: this.stablecoin,
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [getAddress(to), amount],
    });
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

  const quotaCents = Number(env.RACE_QUOTA_CENTS ?? '20'); // 20¢ ≈ 20 games at 1¢
  const poolCents = Number(env.RACE_POOL_CENTS ?? '5000'); // $50 provisioned
  const rpc = env.SETTLEMENT_RPC?.trim() || undefined;
  const pk = (key.startsWith('0x') ? key : `0x${key}`) as Hex;
  return new RaceFaucet(chain, racePass, stablecoin, pk, { quotaCents, poolCents }, rpc);
}
