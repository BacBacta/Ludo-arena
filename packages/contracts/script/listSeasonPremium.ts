/**
 * Lists the "season-premium" item on the already-deployed CosmeticsStore so the
 * premium season pass (Phase 2) is purchasable. One owner-only setPrice call — no
 * redeploy. itemId = keccak256("season-premium") and price = $1.50, both mirroring
 * shared's SEASON_PREMIUM ({ itemId: 'season-premium', cents: 150 }).
 *
 * Usage: NETWORK=celo-sepolia DEPLOYER_PRIVATE_KEY=0x… \
 *          npm run list-season-premium -w packages/contracts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  toBytes,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Mirror of shared SEASON_PREMIUM (kept in lockstep with packages/shared/protocol.ts).
const SEASON_PREMIUM = { itemId: 'season-premium', cents: 150 } as const;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* rely on ambient env */
}
function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : undefined;
}

const CHAINS: Record<string, { chain: Chain; defaultRpc: string; rpcEnv: string }> = {
  'celo-sepolia': {
    chain: defineChain({
      id: 11_142_220,
      name: 'Celo Sepolia',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } },
      blockExplorers: { default: { name: 'Blockscout', url: 'https://celo-sepolia.blockscout.com' } },
    }),
    defaultRpc: 'https://forno.celo-sepolia.celo-testnet.org',
    rpcEnv: 'CELO_SEPOLIA_RPC',
  },
};

const networkName = env('NETWORK') ?? 'celo-sepolia';
const preset = CHAINS[networkName];
if (!preset) {
  console.error(`list-season-premium only supports: ${Object.keys(CHAINS).join(', ')}`);
  process.exit(1);
}

const rawPk = env('DEPLOYER_PRIVATE_KEY');
if (!rawPk) {
  console.error('DEPLOYER_PRIVATE_KEY is required (must be the CosmeticsStore owner / deployer).');
  process.exit(1);
}
const pk = (rawPk.startsWith('0x') ? rawPk : `0x${rawPk}`) as Hex;
const account = privateKeyToAccount(pk);
const rpc = env(preset.rpcEnv) ?? preset.defaultRpc;
const publicClient = createPublicClient({ chain: preset.chain, transport: http(rpc) });
const walletClient = createWalletClient({ account, chain: preset.chain, transport: http(rpc) });

const deploymentsPath = join(ROOT, 'deployments.json');
const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8')) as Record<string, Record<string, unknown>>;
const dep = deployments[networkName];
if (!dep?.cosmeticsStore) {
  console.error(`No cosmeticsStore in deployments.json['${networkName}'] — deploy it first.`);
  process.exit(1);
}
const store = dep.cosmeticsStore as Address;
// price in the stablecoin's OWN decimals: cents * 10^(decimals-2)
const decimals = Number(dep.stablecoinDecimals ?? 6);
const price = BigInt(SEASON_PREMIUM.cents) * 10n ** BigInt(decimals - 2);
const itemId = keccak256(toBytes(SEASON_PREMIUM.itemId));

const STORE_ABI = [
  { type: 'function', name: 'setPrice', stateMutability: 'nonpayable', inputs: [{ name: 'itemId', type: 'bytes32' }, { name: 'price', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'priceOf', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
] as const;

console.log(`[list] network=${networkName} owner=${account.address} store=${store}`);
console.log(`[list] item="${SEASON_PREMIUM.itemId}" id=${itemId} price=${price} (${decimals}-dec, $${SEASON_PREMIUM.cents / 100})`);

const tx = await walletClient.writeContract({ account, chain: preset.chain, address: store, abi: STORE_ABI, functionName: 'setPrice', args: [itemId, price] });
await publicClient.waitForTransactionReceipt({ hash: tx });
console.log(`[list] setPrice tx ${tx}`);

// verify on-chain (retry: load-balanced RPCs may lag the write block)
let onChain = 0n;
for (let attempt = 0; attempt < 6; attempt++) {
  onChain = (await publicClient.readContract({ address: store, abi: STORE_ABI, functionName: 'priceOf', args: [itemId] })) as bigint;
  if (onChain === price) break;
  await new Promise((r) => setTimeout(r, 2_500));
}
if (onChain !== price) throw new Error(`verify failed: priceOf=${onChain}, expected ${price}`);
console.log(`[list] verified: season-premium listed at ${price} base units. Premium pass is now purchasable.`);
