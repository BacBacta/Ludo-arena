/**
 * Syncs the ENTIRE shared cosmetics catalogue onto the already-deployed
 * CosmeticsStore: every cUSD-priced PREMIUM_COSMETICS item + the season-premium
 * pass. Reads current on-chain prices first and batches ONE setPrices call for
 * the missing/mispriced items only (idempotent — re-running is a no-op).
 *
 * This replaces per-item scripts as the catalogue grows: the source of truth is
 * imported STRAIGHT from packages/shared/src/protocol.ts (type-only deps, safe
 * under tsx), so listings can never drift from what the client displays.
 *
 * Usage: NETWORK=celo-sepolia DEPLOYER_PRIVATE_KEY=0x… \
 *          npm run list-cosmetics -w packages/contracts
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
import { PREMIUM_COSMETICS, SEASON_PREMIUM } from '../../shared/src/protocol.js';

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
  console.error(`list-cosmetics only supports: ${Object.keys(CHAINS).join(', ')}`);
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
const decimals = Number(dep.stablecoinDecimals ?? 6);
const priceUnit = 10n ** BigInt(decimals - 2); // cents → base units

// The want-list: every cUSD-priced catalogue item + the premium season pass.
const WANT: Array<{ id: string; cents: number }> = [
  ...PREMIUM_COSMETICS.filter((c) => c.cents > 0).map((c) => ({ id: c.id, cents: c.cents })),
  { id: SEASON_PREMIUM.itemId, cents: SEASON_PREMIUM.cents },
];

const STORE_ABI = [
  { type: 'function', name: 'setPrices', stateMutability: 'nonpayable', inputs: [{ name: 'itemIds', type: 'bytes32[]' }, { name: 'prices', type: 'uint256[]' }], outputs: [] },
  { type: 'function', name: 'priceOf', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

console.log(`[list] network=${networkName} signer=${account.address} store=${store} items=${WANT.length}`);
const owner = (await publicClient.readContract({ address: store, abi: STORE_ABI, functionName: 'owner' })) as Address;
if (owner.toLowerCase() !== account.address.toLowerCase()) {
  console.error(`[list] signer is NOT the store owner (owner=${owner}) — setPrices would revert.`);
  process.exit(1);
}

// Diff against the chain: only write what's missing or mispriced.
const pending: Array<{ id: string; itemId: Hex; price: bigint; had: bigint }> = [];
for (const w of WANT) {
  const itemId = keccak256(toBytes(w.id));
  const want = BigInt(w.cents) * priceUnit;
  const had = (await publicClient.readContract({ address: store, abi: STORE_ABI, functionName: 'priceOf', args: [itemId] })) as bigint;
  if (had === want) {
    console.log(`[list] ✓ ${w.id} already listed at ${had} ($${(w.cents / 100).toFixed(2)})`);
  } else {
    pending.push({ id: w.id, itemId, price: want, had });
    console.log(`[list] → ${w.id}: ${had} → ${want} ($${(w.cents / 100).toFixed(2)})`);
  }
}

if (pending.length === 0) {
  console.log('[list] catalogue already in sync — nothing to write.');
  process.exit(0);
}

const tx = await walletClient.writeContract({
  account,
  chain: preset.chain,
  address: store,
  abi: STORE_ABI,
  functionName: 'setPrices',
  args: [pending.map((p) => p.itemId), pending.map((p) => p.price)],
});
await publicClient.waitForTransactionReceipt({ hash: tx });
console.log(`[list] setPrices(${pending.length} items) tx ${tx}`);

// verify on-chain (retry: load-balanced RPCs may lag the write block)
for (const p of pending) {
  let onChain = 0n;
  for (let attempt = 0; attempt < 6; attempt++) {
    onChain = (await publicClient.readContract({ address: store, abi: STORE_ABI, functionName: 'priceOf', args: [p.itemId] })) as bigint;
    if (onChain === p.price) break;
    await new Promise((r) => setTimeout(r, 2_500));
  }
  if (onChain !== p.price) throw new Error(`verify failed for ${p.id}: priceOf=${onChain}, expected ${p.price}`);
}
console.log(`[list] verified: ${pending.length} item(s) listed. The cUSD rail covers the full catalogue.`);
