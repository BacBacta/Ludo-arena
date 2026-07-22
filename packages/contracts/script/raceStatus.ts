/**
 * READ-ONLY Race Week faucet status: prints the faucet wallet's live cUSD (and
 * native CELO) balance on Celo, and estimates how many players it can still
 * fund. Sends NO transaction — it only needs the faucet ADDRESS, derived from
 * RACE_FAUCET_PRIVATE_KEY (repo secret; never printed) or passed as FAUCET_ADDRESS.
 *
 * Capacity math (JIT mainnet, the deployed config): a player draws, worst case,
 * their gas seed (RACE_SEED_CENTS) + their whole stake quota (RACE_QUOTA_CENTS),
 * plus the faucet's OWN gas for those cUSD transfers (paid in cUSD under
 * feeInStable). Balance-aware funding means most players draw far less (a
 * self-funded wallet takes only the seed; a winner refills from winnings), so
 * the "typical" row is the realistic planning number and the "worst case" row
 * is the floor guarantee.
 *
 * Usage:
 *   NETWORK=celo RACE_FAUCET_PRIVATE_KEY=0x… npm run race-status -w packages/contracts
 *   NETWORK=celo FAUCET_ADDRESS=0x… npm run race-status -w packages/contracts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, formatUnits, http, isAddress, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* rely on ambient env */
}
const env = (n: string): string | undefined => {
  const v = process.env[n];
  return v && v.trim() !== '' ? v.trim() : undefined;
};

const NETWORKS: Record<string, { chain: Chain; rpcEnv: string; defaultRpc: string }> = {
  'celo-sepolia': {
    chain: defineChain({ id: 11_142_220, name: 'Celo Sepolia', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } } }),
    rpcEnv: 'CELO_SEPOLIA_RPC',
    defaultRpc: 'https://forno.celo-sepolia.celo-testnet.org',
  },
  celo: {
    chain: defineChain({ id: 42_220, name: 'Celo', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: ['https://forno.celo.org'] } } }),
    rpcEnv: 'CELO_RPC',
    defaultRpc: 'https://forno.celo.org',
  },
};

const networkName = env('NETWORK') ?? 'celo';
const preset = NETWORKS[networkName];
if (!preset) {
  console.error(`race-status: set NETWORK to one of: ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}

// Faucet address: explicit, else derived from the key (read-only — no signing).
let faucet = env('FAUCET_ADDRESS') as Address | undefined;
if (!faucet) {
  const pk = env('RACE_FAUCET_PRIVATE_KEY');
  if (!pk) {
    console.error('race-status: set FAUCET_ADDRESS or RACE_FAUCET_PRIVATE_KEY.');
    process.exit(1);
  }
  faucet = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as Hex).address;
}
if (!isAddress(faucet)) {
  console.error(`race-status: invalid faucet address ${faucet}`);
  process.exit(1);
}

const deployments = JSON.parse(readFileSync(join(ROOT, 'deployments.json'), 'utf8')) as Record<string, { stablecoin: Address; stablecoinDecimals?: number }>;
const dep = deployments[networkName];
if (!dep?.stablecoin) {
  console.error(`race-status: no stablecoin in deployments.json for '${networkName}'.`);
  process.exit(1);
}
const cUSD = dep.stablecoin;
const decimals = Number(dep.stablecoinDecimals ?? 18);

const seedCents = Number(env('RACE_SEED_CENTS') ?? '10');
const quotaCents = Number(env('RACE_QUOTA_CENTS') ?? '10');
const poolCents = Number(env('RACE_POOL_CENTS') ?? '3000');
// Rough faucet self-gas per active player (a handful of cUSD transfers at Celo
// base fees). Tunable; a conservative planning constant, not an exact figure.
const gasPerPlayerCents = Number(env('RACE_GAS_PER_PLAYER_CENTS') ?? '3');

const rpc = env(preset.rpcEnv) ?? preset.defaultRpc;
const publicClient = createPublicClient({ chain: preset.chain, transport: http(rpc) });
const ERC20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;

const [cusdRaw, celoRaw] = await Promise.all([
  publicClient.readContract({ address: cUSD, abi: ERC20, functionName: 'balanceOf', args: [faucet] }) as Promise<bigint>,
  publicClient.getBalance({ address: faucet }),
]);
const cusdCents = Number((cusdRaw * 100n) / 10n ** BigInt(decimals));
const cusd = formatUnits(cusdRaw, decimals);
const celo = formatUnits(celoRaw, 18);

const worstPerPlayer = seedCents + quotaCents + gasPerPlayerCents; // floor guarantee
const typicalPerPlayer = seedCents + Math.ceil(quotaCents / 2) + gasPerPlayerCents; // balance-aware reality
const fmtUsd = (c: number): string => `$${(c / 100).toFixed(2)}`;

console.log(`\n[race-status] network=${networkName}  faucet=${faucet}`);
console.log(`  cUSD balance : ${cusd}  (${fmtUsd(cusdCents)})`);
console.log(`  CELO balance : ${celo}  (native gas; ~0 is fine when the faucet pays gas in cUSD)`);
console.log(`  pool cap     : ${fmtUsd(poolCents)}  (RACE_POOL_CENTS — a soft grant ceiling; the real limiter is the cUSD balance above)`);
console.log(`\n  Per-player draw (seed ${fmtUsd(seedCents)} + quota ${fmtUsd(quotaCents)} + ~${fmtUsd(gasPerPlayerCents)} faucet gas):`);
console.log(`    worst case ${fmtUsd(worstPerPlayer)}/player → can fund ~${Math.floor(cusdCents / worstPerPlayer)} players (floor guarantee)`);
console.log(`    typical    ${fmtUsd(typicalPerPlayer)}/player → can fund ~${Math.floor(cusdCents / typicalPerPlayer)} players (balance-aware reality)`);
if (cusdCents < worstPerPlayer * 5) console.log(`\n  ⚠ Low balance — refill the faucet wallet (${faucet}) with cUSD soon.`);
console.log('');
