/**
 * Deploys ONLY the RacePass (Race Week entry NFT) and merges its address into the
 * EXISTING deployments.json entry for the target network — WITHOUT touching the
 * live escrow / cosmetics / stablecoin addresses (the full `deploy` script
 * redeploys everything, which would clobber the running app).
 *
 * Use this to add the RacePass to an already-deployed network:
 *   NETWORK=celo-sepolia DEPLOYER_PRIVATE_KEY=0x… npm run deploy-racepass -w packages/contracts
 *
 * The mint window is CLOSED at deploy; the owner (deployer) arms the event later
 * with setMintOpen(true). RACE_PASS_URI = the shared metadata JSON for the art.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compileAll } from './compile.js';

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
  'celo-sepolia': {
    chain: defineChain({
      id: 11_142_220,
      name: 'Celo Sepolia',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } },
      blockExplorers: { default: { name: 'Blockscout', url: 'https://celo-sepolia.blockscout.com' } },
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
  console.error(`deploy-racepass: set NETWORK to one of: ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}

const rawPk = env('DEPLOYER_PRIVATE_KEY');
if (!rawPk) {
  console.error('DEPLOYER_PRIVATE_KEY is required (fund it with testnet CELO for gas first).');
  process.exit(1);
}
const pk = (rawPk.startsWith('0x') ? rawPk : `0x${rawPk}`) as Hex;
const account = privateKeyToAccount(pk);
const rpc = env(preset.rpcEnv) ?? preset.defaultRpc;
const publicClient = createPublicClient({ chain: preset.chain, transport: http(rpc) });
const walletClient = createWalletClient({ account, chain: preset.chain, transport: http(rpc) });

const deploymentsPath = join(ROOT, 'deployments.json');
const deployments: Record<string, Record<string, unknown>> = existsSync(deploymentsPath)
  ? (JSON.parse(readFileSync(deploymentsPath, 'utf8')) as Record<string, Record<string, unknown>>)
  : {};
const existing = deployments[networkName];
if (!existing) {
  console.error(`deploy-racepass: no existing '${networkName}' entry in deployments.json — run the full deploy first.`);
  process.exit(1);
}
if (existing.racePass) {
  console.error(`deploy-racepass: '${networkName}' already has racePass ${String(existing.racePass)} — refusing to overwrite. Remove it first to redeploy.`);
  process.exit(1);
}
if (Number(existing.chainId) !== preset.chain.id) {
  console.error(`deploy-racepass: chainId mismatch (deployments ${String(existing.chainId)} != ${preset.chain.id}).`);
  process.exit(1);
}

const uri = env('RACE_PASS_URI') ?? 'https://www.ludoarena.xyz/race-pass.json';
console.log(`[deploy-racepass] network=${networkName} chainId=${preset.chain.id} rpc=${rpc}`);
console.log(`[deploy-racepass] deployer=${account.address} uri=${uri}`);

const bal = await publicClient.getBalance({ address: account.address });
console.log(`[deploy-racepass] deployer balance = ${bal} wei`);

const { RacePass } = compileAll();
const txHash = await walletClient.deployContract({ abi: RacePass.abi, bytecode: RacePass.bytecode, args: [uri] });
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
if (receipt.status !== 'success' || !receipt.contractAddress) {
  throw new Error(`RacePass deployment failed (tx ${txHash})`);
}
const racePass = receipt.contractAddress as Address;
console.log(`[deploy-racepass] RacePass → ${racePass} (tx ${txHash})`);

// Sanity read-back: owner is the deployer (so it can arm the mint window later),
// mint window is CLOSED at deploy. Retried — load-balanced public RPCs may serve
// the read from a node that has not yet seen the deployment block.
const OWNER_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'mintOpen', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const;
async function readBack<T>(functionName: 'owner' | 'mintOpen'): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return (await publicClient.readContract({ address: racePass, abi: OWNER_ABI, functionName })) as T;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 2_500));
    }
  }
  throw lastError;
}
const [owner, mintOpen] = [await readBack<Address>('owner'), await readBack<boolean>('mintOpen')];
console.log(`[deploy-racepass] owner=${owner} mintOpen=${mintOpen}`);
if (owner.toLowerCase() !== account.address.toLowerCase()) throw new Error('owner mismatch');
if (mintOpen) throw new Error('mint window should be CLOSED at deploy');

// Merge ONLY racePass + racePassTx into the existing entry — every other field
// (escrow, escrowN, cosmeticsStore, stablecoin, arbiter, treasury, rake) is left
// byte-for-byte as it was, so the live app is unaffected.
existing.racePass = racePass;
existing.racePassTx = txHash;
const serialized = JSON.stringify(deployments, null, 2) + '\n';
writeFileSync(deploymentsPath, serialized);
const webCopy = join(ROOT, '..', '..', 'apps', 'web', 'src', 'deployments.json');
if (existsSync(join(ROOT, '..', '..', 'apps', 'web', 'src'))) writeFileSync(webCopy, serialized);
console.log(`[deploy-racepass] merged racePass into deployments.json + apps/web/src ('${networkName}')`);
console.log(`[deploy-racepass] NEXT: arm the event with setMintOpen(true) once the server secrets are set.`);
