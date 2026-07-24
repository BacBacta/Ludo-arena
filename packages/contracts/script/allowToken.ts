/**
 * Whitelists a stake token on the DEPLOYED escrows (LudoEscrow + LudoEscrowN) via
 * the owner-only `setTokenAllowed(token, true)`. The escrow refuses `join` for a
 * token that isn't allowed (TokenNotAllowed), so this is the FIRST cutover step
 * of the cUSD→USD₮ migration — additive and idempotent: it does NOT disable the
 * current token, so cUSD play keeps working until the deployment config flips.
 *
 * Owner-only (LudoEscrow.owner — the TREASURY when roles were split at deploy).
 * Reads escrow addresses from deployments.json for the target NETWORK.
 *
 * Usage:
 *   NETWORK=celo TOKEN_ADDRESS=0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e \
 *     DEPLOYER_PRIVATE_KEY=0x<owner> npm run allow-token -w packages/contracts
 *   ALLOWED=false to REVOKE a token instead.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, getAddress, http, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* no .env: rely on the ambient environment */
}
const env = (n: string): string | undefined => {
  const v = process.env[n];
  return v && v.trim() !== '' ? v.trim() : undefined;
};

const NETWORKS: Record<string, { chain: Chain; rpcEnv: string; defaultRpc: string }> = {
  localhost: { chain: defineChain({ id: 31_337, name: 'localhost', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } } }), rpcEnv: 'LOCAL_RPC', defaultRpc: 'http://127.0.0.1:8545' },
  'celo-sepolia': { chain: defineChain({ id: 11_142_220, name: 'Celo Sepolia', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } } }), rpcEnv: 'CELO_SEPOLIA_RPC', defaultRpc: 'https://forno.celo-sepolia.celo-testnet.org' },
  celo: { chain: defineChain({ id: 42_220, name: 'Celo', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: ['https://forno.celo.org'] } } }), rpcEnv: 'CELO_RPC', defaultRpc: 'https://forno.celo.org' },
};

const networkName = env('NETWORK') ?? '';
const preset = NETWORKS[networkName];
if (!preset) {
  console.error(`allow-token: set NETWORK to one of: ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}
const rawToken = env('TOKEN_ADDRESS');
if (!rawToken) {
  console.error('allow-token: TOKEN_ADDRESS is required (the stake token to whitelist).');
  process.exit(1);
}
let token: Address;
try {
  token = getAddress(rawToken);
} catch {
  console.error(`allow-token: TOKEN_ADDRESS is not a valid address: ${rawToken}`);
  process.exit(1);
}
const allowed = (env('ALLOWED') ?? 'true') !== 'false';

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
  console.error('allow-token: deployments.json not found.');
  process.exit(1);
}
const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8')) as Record<string, Record<string, unknown>>;
const dep = deployments[networkName];
if (!dep?.escrow) {
  console.error(`allow-token: no escrow in deployments.json for '${networkName}'.`);
  process.exit(1);
}
if (Number(dep.chainId) !== preset.chain.id) {
  console.error(`allow-token: chainId mismatch (deployments ${String(dep.chainId)} != ${preset.chain.id}).`);
  process.exit(1);
}

const ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'allowedToken', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setTokenAllowed', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'allowed', type: 'bool' }], outputs: [] },
] as const;

const targets: Array<[string, Address]> = [['LudoEscrow', dep.escrow as Address]];
if (dep.escrowN) targets.push(['LudoEscrowN', dep.escrowN as Address]);

console.log(`[allow-token] network=${networkName} token=${token} → allowed=${allowed}, caller=${account.address}`);
for (const [name, addr] of targets) {
  const owner = (await publicClient.readContract({ address: addr, abi: ABI, functionName: 'owner' })) as Address;
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    console.error(`[allow-token] ${name}: caller is NOT the owner (${owner}). Aborting.`);
    process.exit(1);
  }
  const current = (await publicClient.readContract({ address: addr, abi: ABI, functionName: 'allowedToken', args: [token] })) as boolean;
  if (current === allowed) {
    console.log(`[allow-token] ${name}: already allowed=${allowed} — nothing to do.`);
    continue;
  }
  const txHash = await walletClient.writeContract({ address: addr, abi: ABI, functionName: 'setTokenAllowed', args: [token, allowed] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`${name}: setTokenAllowed reverted (tx ${txHash})`);
  console.log(`[allow-token] ${name}: allowed ${current} → ${allowed} (tx ${txHash})`);
}
console.log('[allow-token] done. NOTE: additive — the previous token stays allowed until you revoke it.');
