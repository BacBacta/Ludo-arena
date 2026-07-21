/**
 * Arms (or closes) the RacePass event mint window — the LAUNCH step that opens
 * the Race Week pass for minting. The pass is deployed with the window CLOSED
 * (see deployRacePass.ts); the owner (deployer) flips it with setMintOpen(true)
 * once the server secrets are live, then setMintOpen(false) to end the event.
 *
 * Owner-only (RacePass.owner == the deployer). Reads the RacePass address from
 * deployments.json for the target NETWORK — never takes an address argument, so
 * it can only touch the canonical deployed pass.
 *
 * Usage:
 *   NETWORK=celo OPEN=true  DEPLOYER_PRIVATE_KEY=0x… npm run set-mint-open -w packages/contracts
 *   NETWORK=celo OPEN=false DEPLOYER_PRIVATE_KEY=0x… npm run set-mint-open -w packages/contracts
 *
 * Env:
 *   NETWORK               celo | celo-sepolia (selects RPC + deployments.json entry)
 *   OPEN                  true to arm the window, false to close it (required)
 *   DEPLOYER_PRIVATE_KEY  the RacePass owner key (required to send the tx)
 *   CELO_RPC / CELO_SEPOLIA_RPC   optional RPC override
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
  console.error(`set-mint-open: set NETWORK to one of: ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}

const openRaw = env('OPEN')?.toLowerCase();
if (openRaw !== 'true' && openRaw !== 'false') {
  console.error('set-mint-open: set OPEN=true (arm) or OPEN=false (close).');
  process.exit(1);
}
const open = openRaw === 'true';

const rawPk = env('DEPLOYER_PRIVATE_KEY');
if (!rawPk) {
  console.error('DEPLOYER_PRIVATE_KEY is required (must be the RacePass owner).');
  process.exit(1);
}
const pk = (rawPk.startsWith('0x') ? rawPk : `0x${rawPk}`) as Hex;
const account = privateKeyToAccount(pk);
const rpc = env(preset.rpcEnv) ?? preset.defaultRpc;
const publicClient = createPublicClient({ chain: preset.chain, transport: http(rpc) });
const walletClient = createWalletClient({ account, chain: preset.chain, transport: http(rpc) });

const deploymentsPath = join(ROOT, 'deployments.json');
if (!existsSync(deploymentsPath)) {
  console.error('set-mint-open: deployments.json not found.');
  process.exit(1);
}
const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8')) as Record<string, Record<string, unknown>>;
const existing = deployments[networkName];
if (!existing?.racePass) {
  console.error(`set-mint-open: no racePass address in deployments.json for '${networkName}'. Deploy it first.`);
  process.exit(1);
}
if (Number(existing.chainId) !== preset.chain.id) {
  console.error(`set-mint-open: chainId mismatch (deployments ${String(existing.chainId)} != ${preset.chain.id}).`);
  process.exit(1);
}
const racePass = existing.racePass as Address;

const RACE_PASS_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'mintOpen', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'setMintOpen', stateMutability: 'nonpayable', inputs: [{ name: 'open', type: 'bool' }], outputs: [] },
] as const;

console.log(`[set-mint-open] network=${networkName} chainId=${preset.chain.id} rpc=${rpc}`);
console.log(`[set-mint-open] racePass=${racePass} caller=${account.address}`);

const owner = (await publicClient.readContract({ address: racePass, abi: RACE_PASS_ABI, functionName: 'owner' })) as Address;
if (owner.toLowerCase() !== account.address.toLowerCase()) {
  console.error(`[set-mint-open] caller ${account.address} is NOT the RacePass owner (${owner}). Aborting.`);
  process.exit(1);
}

const before = (await publicClient.readContract({ address: racePass, abi: RACE_PASS_ABI, functionName: 'mintOpen' })) as boolean;
console.log(`[set-mint-open] current mintOpen=${before} → requested ${open}`);
if (before === open) {
  console.log('[set-mint-open] already in the requested state — nothing to do.');
  process.exit(0);
}

const txHash = await walletClient.writeContract({ address: racePass, abi: RACE_PASS_ABI, functionName: 'setMintOpen', args: [open] });
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
if (receipt.status !== 'success') throw new Error(`setMintOpen(${open}) reverted (tx ${txHash})`);
console.log(`[set-mint-open] tx ${txHash} → ${receipt.status}`);

// Read-back is load-balancer tolerant: a public RPC may serve the read from a
// node that hasn't applied the block yet — retry until it reflects the new state.
let after = before;
for (let attempt = 0; attempt < 6 && after !== open; attempt++) {
  if (attempt > 0) await new Promise((r) => setTimeout(r, 2_500));
  after = (await publicClient.readContract({ address: racePass, abi: RACE_PASS_ABI, functionName: 'mintOpen' })) as boolean;
}
console.log(`[set-mint-open] mintOpen is now ${after} — Race Week pass minting is ${after ? 'OPEN ✅' : 'CLOSED'}.`);
if (after !== open) {
  console.error('[set-mint-open] read-back did not reflect the new state yet (RPC lag) — verify on the explorer.');
  process.exit(1);
}
