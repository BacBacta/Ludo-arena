/**
 * Sets the per-tier rake override on the DEPLOYED escrows — the remediation for
 * the Race Week 1¢ tier: the contract reads a 0 tier override as "unset → fall
 * back to the global 900 bps", and the deploy script historically configured
 * only the 25/100/500¢ tiers — so every 1¢ race pot settled at the flat 9%
 * skim (winner received 1.82¢ of an announced 2¢, and the JIT faucet then
 * refilled what the rake had taken). This script sets the 1¢ tier to 1 bps
 * (≈ rake-free; an exact per-tier 0 is inexpressible in escrow V1).
 *
 * Owner-only (LudoEscrow.owner — the TREASURY when the roles were split at
 * deploy). Reads addresses from deployments.json for the target NETWORK.
 * Idempotent: skips a tier already at the requested bps. NOTE: the contract
 * snapshots the rake per game at `join`, so already-created games keep their
 * old rate; only games created AFTER this call settle rake-free.
 *
 * Usage (defaults to the Race tier, both escrows):
 *   NETWORK=celo DEPLOYER_PRIVATE_KEY=0x<owner> npm run set-tier-rake -w packages/contracts
 *   NETWORK=celo TIER_CENTS=1 TIER_BPS=1 DEPLOYER_PRIVATE_KEY=0x… npm run set-tier-rake -w packages/contracts
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* no .env file: rely on the ambient environment */
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : undefined;
}

const NETWORKS: Record<string, { chain: Chain; rpcEnv: string; defaultRpc: string }> = {
  localhost: {
    chain: defineChain({ id: 31_337, name: 'localhost', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } } }),
    rpcEnv: 'LOCAL_RPC',
    defaultRpc: 'http://127.0.0.1:8545',
  },
  'celo-sepolia': {
    chain: defineChain({
      id: 11_142_220,
      name: 'Celo Sepolia',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } },
    }),
    rpcEnv: 'CELO_SEPOLIA_RPC',
    defaultRpc: 'https://forno.celo-sepolia.celo-testnet.org',
  },
  celo: {
    chain: defineChain({
      id: 42_220,
      name: 'Celo',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: { default: { http: ['https://forno.celo.org'] } },
      blockExplorers: { default: { name: 'Celoscan', url: 'https://celoscan.io' } },
    }),
    rpcEnv: 'CELO_RPC',
    defaultRpc: 'https://forno.celo.org',
  },
};

const networkName = env('NETWORK') ?? '';
const preset = NETWORKS[networkName];
if (!preset) {
  console.error(`set-tier-rake: set NETWORK to one of: ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}

const tierCents = Number(env('TIER_CENTS') ?? '1');
const tierBps = Number(env('TIER_BPS') ?? '1');
if (!Number.isInteger(tierCents) || tierCents <= 0 || !Number.isInteger(tierBps) || tierBps < 0 || tierBps > 2000) {
  console.error('set-tier-rake: TIER_CENTS must be a positive integer, TIER_BPS an integer 0..2000.');
  process.exit(1);
}

const rawPk = env('DEPLOYER_PRIVATE_KEY');
if (!rawPk) {
  console.error('DEPLOYER_PRIVATE_KEY is required (must be the escrow OWNER — the treasury if roles were split).');
  process.exit(1);
}
const pk = (rawPk.startsWith('0x') ? rawPk : `0x${rawPk}`) as Hex;
const account = privateKeyToAccount(pk);
const rpc = env(preset.rpcEnv) ?? preset.defaultRpc;
const publicClient = createPublicClient({ chain: preset.chain, transport: http(rpc) });
const walletClient = createWalletClient({ account, chain: preset.chain, transport: http(rpc) });

const deploymentsPath = join(ROOT, 'deployments.json');
if (!existsSync(deploymentsPath)) {
  console.error('set-tier-rake: deployments.json not found.');
  process.exit(1);
}
const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8')) as Record<string, Record<string, unknown>>;
const dep = deployments[networkName];
if (!dep?.escrow || !dep?.stablecoin) {
  console.error(`set-tier-rake: no escrow/stablecoin in deployments.json for '${networkName}'.`);
  process.exit(1);
}
if (Number(dep.chainId) !== preset.chain.id) {
  console.error(`set-tier-rake: chainId mismatch (deployments ${String(dep.chainId)} != ${preset.chain.id}).`);
  process.exit(1);
}
const stablecoin = dep.stablecoin as Address;
const decimals = Number(dep.stablecoinDecimals ?? 18);
const stakeUnits = BigInt(tierCents) * 10n ** BigInt(decimals - 2);

const ESCROW_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'tierRakeBps', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint96' }], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'setTierRakeBps', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' }, { name: 'bps', type: 'uint16' }], outputs: [] },
] as const;

const targets: Array<[string, Address]> = [['LudoEscrow', dep.escrow as Address]];
if (dep.escrowN) targets.push(['LudoEscrowN', dep.escrowN as Address]);

console.log(`[set-tier-rake] network=${networkName} tier=${tierCents}¢ (${stakeUnits} units) → ${tierBps} bps, caller=${account.address}`);
for (const [name, addr] of targets) {
  const owner = (await publicClient.readContract({ address: addr, abi: ESCROW_ABI, functionName: 'owner' })) as Address;
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    console.error(`[set-tier-rake] ${name}: caller is NOT the owner (${owner}). Aborting.`);
    process.exit(1);
  }
  const current = (await publicClient.readContract({ address: addr, abi: ESCROW_ABI, functionName: 'tierRakeBps', args: [stablecoin, stakeUnits] })) as number;
  if (current === tierBps) {
    console.log(`[set-tier-rake] ${name}: tier already at ${tierBps} bps — nothing to do.`);
    continue;
  }
  const txHash = await walletClient.writeContract({ address: addr, abi: ESCROW_ABI, functionName: 'setTierRakeBps', args: [stablecoin, stakeUnits, tierBps] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`${name}: setTierRakeBps reverted (tx ${txHash})`);
  console.log(`[set-tier-rake] ${name}: ${current} bps → ${tierBps} bps (tx ${txHash})`);
}
console.log('[set-tier-rake] done. NOTE: rake is snapshotted per game at join — only games created from now on use the new rate.');
