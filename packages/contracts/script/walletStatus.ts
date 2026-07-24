/**
 * READ-ONLY balance probe for an arbitrary wallet on Celo: prints its cUSD and
 * native CELO balance, and how many 1c Race stakes it can cover. Sends NO
 * transaction. Used to confirm the house-bot wallet is funded before/after
 * arming (WALLET_ADDRESS = the house bot address).
 *
 *   NETWORK=celo WALLET_ADDRESS=0x… npm run wallet-status -w packages/contracts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, formatUnits, http, isAddress, type Address, type Chain } from 'viem';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* ambient env */
}
const env = (n: string): string | undefined => {
  const v = process.env[n];
  return v && v.trim() !== '' ? v.trim() : undefined;
};

const NETWORKS: Record<string, { chain: Chain; defaultRpc: string }> = {
  'celo-sepolia': { chain: defineChain({ id: 11_142_220, name: 'Celo Sepolia', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } } }), defaultRpc: 'https://forno.celo-sepolia.celo-testnet.org' },
  celo: { chain: defineChain({ id: 42_220, name: 'Celo', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: ['https://forno.celo.org'] } } }), defaultRpc: 'https://forno.celo.org' },
};

const networkName = env('NETWORK') ?? 'celo';
const preset = NETWORKS[networkName];
if (!preset) {
  console.error(`wallet-status: set NETWORK to one of: ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}
const addr = env('WALLET_ADDRESS') as Address | undefined;
if (!addr || !isAddress(addr)) {
  console.error(`wallet-status: set WALLET_ADDRESS to a valid address (got ${addr ?? '<unset>'})`);
  process.exit(1);
}

const deployments = JSON.parse(readFileSync(join(ROOT, 'deployments.json'), 'utf8')) as Record<string, { stablecoin: Address; stablecoinDecimals?: number }>;
const dep = deployments[networkName];
if (!dep?.stablecoin) {
  console.error(`wallet-status: no stablecoin in deployments.json for '${networkName}'.`);
  process.exit(1);
}
const decimals = Number(dep.stablecoinDecimals ?? 18);
const rpc = env('CELO_RPC') ?? preset.defaultRpc;
const client = createPublicClient({ chain: preset.chain, transport: http(rpc) });
const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;

const [cusdRaw, celoRaw] = await Promise.all([
  client.readContract({ address: dep.stablecoin, abi: ERC20, functionName: 'balanceOf', args: [addr] }) as Promise<bigint>,
  client.getBalance({ address: addr }),
]);
const cusdCents = Number((cusdRaw * 100n) / 10n ** BigInt(decimals));
const feeInStable = (env('FEE_IN_STABLE') ?? '').trim() === 'true' || (env('RACE_FEE_IN_STABLE') ?? '').trim() === 'true';

console.log(`\n[wallet-status] network=${networkName}  wallet=${addr}`);
console.log(`  cUSD balance : ${formatUnits(cusdRaw, decimals)}  (${(cusdCents / 100).toFixed(2)} USD)`);
console.log(`  CELO balance : ${formatUnits(celoRaw, 18)}  (native gas)`);
console.log(`  gas mode     : ${feeInStable ? 'cUSD (CIP-64) — no native CELO needed' : 'native CELO — this wallet MUST hold CELO'}`);
console.log(`  1c stakes covered by cUSD: ~${cusdCents} (before gas)`);
if (cusdCents <= 0) console.log('  ⚠ NOT FUNDED — send cUSD to this wallet before it can stake.');
else if (!feeInStable && celoRaw === 0n) console.log('  ⚠ has cUSD but NO CELO, and gas mode is native — its tx will revert until funded with CELO.');
else console.log('  ✓ funded and ready to stake.');
console.log('');
