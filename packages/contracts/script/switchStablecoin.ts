/**
 * Switches the testnet stablecoin to a fresh 6-decimal MockUSDT WITHOUT
 * redeploying the escrows (they are token-agnostic — the token is chosen per
 * game at join time). Minimal-disruption migration:
 *   1. deploy MockUSDT (6 decimals),
 *   2. re-point the existing CosmeticsStore at it (setToken),
 *   3. re-seed the catalogue prices in the token's OWN decimals,
 *   4. rewrite deployments.json[network].stablecoin (+ web vendored copy).
 * Only the web then needs a rebuild; the server is token-agnostic (no change).
 *
 * Usage: NETWORK=celo-sepolia npm run switch-stablecoin -w packages/contracts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
import { compileAll } from './compile.js';

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
  console.error(`switch-stablecoin only supports: ${Object.keys(CHAINS).join(', ')}`);
  process.exit(1);
}

const rawPk = env('DEPLOYER_PRIVATE_KEY');
if (!rawPk) {
  console.error('DEPLOYER_PRIVATE_KEY is required.');
  process.exit(1);
}
const pk = (rawPk.startsWith('0x') ? rawPk : `0x${rawPk}`) as Hex;
const account = privateKeyToAccount(pk);
const rpc = env(preset.rpcEnv) ?? preset.defaultRpc;
const publicClient = createPublicClient({ chain: preset.chain, transport: http(rpc) });
const walletClient = createWalletClient({ account, chain: preset.chain, transport: http(rpc) });

// existing deployment (we KEEP escrow/escrowN/cosmeticsStore; only swap the token)
const deploymentsPath = join(ROOT, 'deployments.json');
const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8')) as Record<string, Record<string, unknown>>;
const dep = deployments[networkName];
if (!dep?.cosmeticsStore) {
  console.error(`No cosmeticsStore in deployments.json['${networkName}'] — run a full deploy first.`);
  process.exit(1);
}
const store = dep.cosmeticsStore as Address;

const STORE_ABI = [
  { type: 'function', name: 'setToken', stateMutability: 'nonpayable', inputs: [{ name: '_token', type: 'address' }], outputs: [] },
  { type: 'function', name: 'setPrices', stateMutability: 'nonpayable', inputs: [{ name: 'itemIds', type: 'bytes32[]' }, { name: 'prices', type: 'uint256[]' }], outputs: [] },
  { type: 'function', name: 'token', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;
const ERC20_DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

// mirrors shared PREMIUM_COSMETICS (id → cUSD price in cents)
const COSMETIC_SEED: Array<{ id: string; cents: number }> = [
  { id: 'obsidian', cents: 100 },
  { id: 'aurora', cents: 200 },
];

console.log(`[switch] network=${networkName} deployer=${account.address} store=${store}`);
const { MockUSDT } = compileAll();

// Load-balanced public RPCs may serve a read from a node that hasn't seen the
// deploy block yet — retry reads before giving up (mirrors deploy.ts readBack).
async function readWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 2_500));
    }
  }
  throw lastError;
}

// 1. reuse an already-deployed token (USDT_ADDRESS) or deploy a fresh MockUSDT
let usdt: Address;
let usdtTx: Hex | 'reused';
const reuse = env('USDT_ADDRESS') as Address | undefined;
if (reuse) {
  usdt = reuse;
  usdtTx = 'reused';
  console.log(`[switch] reusing token ${usdt}`);
} else {
  const tx = await walletClient.deployContract({ abi: MockUSDT.abi, bytecode: MockUSDT.bytecode, args: [] });
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (rcpt.status !== 'success' || !rcpt.contractAddress) throw new Error(`MockUSDT deploy failed (tx ${tx})`);
  usdt = rcpt.contractAddress;
  usdtTx = tx;
}
const decimals = Number(
  await readWithRetry(() => publicClient.readContract({ address: usdt, abi: ERC20_DECIMALS_ABI, functionName: 'decimals' })),
);
console.log(`[switch] MockUSDT ${usdt} (${decimals} decimals, tx ${usdtTx})`);

// 2. re-point the CosmeticsStore at the new token
const setTokenTx = await walletClient.writeContract({ account, chain: preset.chain, address: store, abi: STORE_ABI, functionName: 'setToken', args: [usdt] });
await publicClient.waitForTransactionReceipt({ hash: setTokenTx });
console.log(`[switch] CosmeticsStore.setToken(${usdt}) (tx ${setTokenTx})`);

// 3. re-seed prices in the token's OWN decimals: cents * 10^(decimals-2)
const unit = 10n ** BigInt(decimals - 2);
const seedTx = await walletClient.writeContract({
  account,
  chain: preset.chain,
  address: store,
  abi: STORE_ABI,
  functionName: 'setPrices',
  args: [COSMETIC_SEED.map((c) => keccak256(toBytes(c.id))), COSMETIC_SEED.map((c) => BigInt(c.cents) * unit)],
});
await publicClient.waitForTransactionReceipt({ hash: seedTx });
console.log(`[switch] re-seeded ${COSMETIC_SEED.length} prices in ${decimals}-dec (tx ${seedTx})`);

// verify on-chain
const onToken = await readWithRetry(() => publicClient.readContract({ address: store, abi: STORE_ABI, functionName: 'token' }));
if (String(onToken).toLowerCase() !== usdt.toLowerCase()) throw new Error('post-switch verify failed: store token mismatch');
console.log('[switch] verified: store token now MockUSDT');

// 4. update deployments.json (keep escrow/escrowN/cosmeticsStore; swap token only)
dep.stablecoin = usdt;
dep.stablecoinIsTestUSD = true;
if (usdtTx !== 'reused') dep.stablecoinTx = usdtTx;
dep.stablecoinDecimals = decimals;
const serialized = JSON.stringify(deployments, null, 2) + '\n';
writeFileSync(deploymentsPath, serialized);
const webCopy = join(ROOT, '..', '..', 'apps', 'web', 'src', 'deployments.json');
if (existsSync(join(ROOT, '..', '..', 'apps', 'web', 'src'))) writeFileSync(webCopy, serialized);
console.log(`[switch] deployments.json updated (stablecoin → ${usdt}); web needs a rebuild.`);
