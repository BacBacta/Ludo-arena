/**
 * cUSD cosmetic purchases (rec 6). Players buy a dice skin / board theme with
 * cUSD on-chain via the CosmeticsStore contract; this verifier confirms the tx
 * really emitted Purchased(buyer, itemId) from that store before the server
 * grants ownership. Read-only (no key): it never moves funds — it only reads a
 * receipt. Dormant (createCosmeticsVerifier → null) until the store is deployed,
 * mirroring the staked-4p arbiter's deferred-deploy pattern.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, getAddress, http, keccak256, toBytes, type Address, type Chain, type Hex } from 'viem';
import { CHAINS } from './settlement.js';

/** topic0 of Purchased(address indexed buyer, bytes32 indexed itemId, uint256 price). */
const PURCHASED_TOPIC = keccak256(toBytes('Purchased(address,bytes32,uint256)')).toLowerCase();

/** The on-chain itemId for a cosmetic id — must match the contract + client. */
export function itemIdFor(id: string): string {
  return keccak256(toBytes(id)).toLowerCase();
}

export class CosmeticsVerifier {
  readonly chainId: number;
  readonly address: Address; // the CosmeticsStore
  private readonly publicClient: ReturnType<typeof createPublicClient>;

  constructor(chain: Chain, store: Address, rpc?: string) {
    this.chainId = chain.id;
    this.address = getAddress(store);
    this.publicClient = createPublicClient({ chain, transport: http(rpc) });
  }

  /** True iff `txHash` is a mined success that emitted Purchased(buyer, keccak(id))
   *  from THIS store — proof that `buyer` really paid cUSD for cosmetic `id`. */
  async verifyPurchase(txHash: Hex, buyer: Address, id: string): Promise<boolean> {
    const wantItem = itemIdFor(id);
    const wantBuyer = getAddress(buyer);
    let receipt: Awaited<ReturnType<typeof this.publicClient.getTransactionReceipt>>;
    try {
      receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
    } catch {
      return false; // unknown / unmined tx
    }
    if (receipt.status !== 'success') return false;
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== this.address) continue;
      if ((log.topics[0] ?? '').toLowerCase() !== PURCHASED_TOPIC) continue;
      const buyerTopic = log.topics[1];
      const itemTopic = log.topics[2];
      if (!buyerTopic || !itemTopic) continue;
      const logBuyer = getAddress(('0x' + buyerTopic.slice(26)) as Address);
      if (logBuyer === wantBuyer && itemTopic.toLowerCase() === wantItem) return true;
    }
    return false;
  }

  async healthcheck(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }
}

interface DeploymentC {
  chainId: number;
  cosmeticsStore?: Address;
}

/** Build the verifier from env (CHAIN + COSMETICS_STORE_ADDRESS or deployments.json
 *  cosmeticsStore), or null when the store isn't deployed → cUSD claims stay off.
 *  `deploymentsOverride` lets tests exercise the no-store branch without
 *  depending on which chains the CHECKED-IN deployments.json happens to cover
 *  (the localhost entry gained a full stack when the e2e race bench landed). */
export function createCosmeticsVerifier(env: NodeJS.ProcessEnv = process.env, deploymentsOverride?: Record<string, DeploymentC>): CosmeticsVerifier | null {
  const chain = CHAINS[env.CHAIN?.trim() || 'celo-sepolia'];
  if (!chain) return null;

  // Resolve BOTH sources so an env override that has drifted from the bundled
  // deployments.json screams at boot instead of silently verifying against a
  // store the CLIENT no longer buys on. (Exactly that happened in production:
  // a COSMETICS_STORE_ADDRESS secret from the first setup outlived two store
  // redeploys — every cUSD purchase failed its claim with "could not verify".)
  const override = env.COSMETICS_STORE_ADDRESS?.trim() as Address | undefined;
  let fromDeployments: Address | undefined;
  const deploymentsPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'contracts', 'deployments.json');
  try {
    const deployments = deploymentsOverride ?? (JSON.parse(readFileSync(deploymentsPath, 'utf8')) as Record<string, DeploymentC>);
    fromDeployments = Object.values(deployments).find((d) => d.chainId === chain.id)?.cosmeticsStore;
  } catch {
    /* no deployments file bundled */
  }
  if (override && fromDeployments && override.toLowerCase() !== fromDeployments.toLowerCase()) {
    console.warn(
      `[cosmetics] ⚠ COSMETICS_STORE_ADDRESS override (${override}) differs from deployments.json ` +
        `(${fromDeployments}) — the CLIENT buys on the deployments address, so cUSD claims will fail. ` +
        `Unset the secret (deployments.json is authoritative) or update it.`,
    );
  }
  const store = override ?? fromDeployments;
  if (!store) return null; // store not deployed yet → cUSD cosmetic claims disabled
  return new CosmeticsVerifier(chain, store, env.SETTLEMENT_RPC?.trim() || undefined);
}
