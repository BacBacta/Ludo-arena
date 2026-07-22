/**
 * READ-ONLY on-chain activity report for the Proof of Ship metric: counts the
 * transactions our mainnet deployment has generated on Celo. Sends NO
 * transaction — it only reads a public block explorer (Blockscout API v2, no
 * key) with a raw-RPC nonce fallback.
 *
 * What it counts, and why the split matters:
 *   • dapp contracts (escrow, escrowN, cosmeticsStore, racePass) — the number
 *     of transactions sent TO each contract. This is the canonical Proof of
 *     Ship figure: every player action that touched our code on-chain
 *     (join / settle / settleBatch / cancel / mint / purchase / admin).
 *   • operational wallets (arbiter, treasury, faucet) — the number of
 *     transactions each EOA has BROADCAST (its nonce). NOTE: arbiter
 *     settlements are calls to the escrow, so they are ALSO counted in the
 *     escrow contract totals above — the wallet rows are shown separately and
 *     are NOT added into the dapp-contract headline to avoid double counting.
 *
 * User approvals target Celo's shared cUSD token (not our contract), so they
 * cannot be attributed to us and are excluded.
 *
 * Usage:
 *   NETWORK=celo npm run onchain-activity -w packages/contracts
 *   NETWORK=celo FAUCET_ADDRESS=0x… npm run onchain-activity -w packages/contracts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, http, isAddress, type Address, type Chain, type Hex } from 'viem';
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

const NETWORKS: Record<string, { chain: Chain; rpcEnv: string; defaultRpc: string; blockscout: string }> = {
  'celo-sepolia': {
    chain: defineChain({ id: 11_142_220, name: 'Celo Sepolia', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } } }),
    rpcEnv: 'CELO_SEPOLIA_RPC',
    defaultRpc: 'https://forno.celo-sepolia.celo-testnet.org',
    blockscout: 'https://celo-sepolia.blockscout.com',
  },
  celo: {
    chain: defineChain({ id: 42_220, name: 'Celo', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: ['https://forno.celo.org'] } } }),
    rpcEnv: 'CELO_RPC',
    defaultRpc: 'https://forno.celo.org',
    blockscout: 'https://celo.blockscout.com',
  },
};

const networkName = env('NETWORK') ?? 'celo';
const preset = NETWORKS[networkName];
if (!preset) {
  console.error(`onchain-activity: set NETWORK to one of: ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}

type Dep = { escrow?: Address; escrowN?: Address; cosmeticsStore?: Address; racePass?: Address; arbiter?: Address; treasury?: Address };
const deployments = JSON.parse(readFileSync(join(ROOT, 'deployments.json'), 'utf8')) as Record<string, Dep>;
const dep = deployments[networkName];
if (!dep) {
  console.error(`onchain-activity: no deployment block for '${networkName}' in deployments.json.`);
  process.exit(1);
}

// Faucet address (optional): explicit, else derived from the key (read-only).
let faucet = env('FAUCET_ADDRESS') as Address | undefined;
if (!faucet) {
  const pk = env('RACE_FAUCET_PRIVATE_KEY');
  if (pk) faucet = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as Hex).address;
}

const rpc = env(preset.rpcEnv) ?? preset.defaultRpc;
const publicClient = createPublicClient({ chain: preset.chain, transport: http(rpc) });
const BLOCKSCOUT = env('BLOCKSCOUT_URL') ?? preset.blockscout;

// Blockscout v2 counters — transactions_count is every tx to/from the address.
// Returns null on any failure so we can fall back to the RPC nonce.
async function blockscoutTxCount(addr: Address): Promise<number | null> {
  try {
    const res = await fetch(`${BLOCKSCOUT}/api/v2/addresses/${addr}/counters`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const j = (await res.json()) as { transactions_count?: string };
    if (j.transactions_count == null) return null;
    const n = Number(j.transactions_count);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

type Row = { label: string; addr: Address; kind: 'contract' | 'wallet'; count: number | null; source: 'explorer' | 'rpc-nonce' | 'unavailable' };

async function measure(label: string, addr: Address | undefined, kind: 'contract' | 'wallet'): Promise<Row | null> {
  if (!addr || !isAddress(addr)) return null;
  const explorer = await blockscoutTxCount(addr);
  if (explorer != null) return { label, addr, kind, count: explorer, source: 'explorer' };
  // Fallback: the RPC nonce = txs the address SENT. Meaningful for wallets;
  // for a contract it undercounts (incoming calls don't bump the nonce), so we
  // flag it rather than pass it off as the real figure.
  try {
    const nonce = await publicClient.getTransactionCount({ address: addr });
    return { label, addr, kind, count: nonce, source: 'rpc-nonce' };
  } catch {
    return { label, addr, kind, count: null, source: 'unavailable' };
  }
}

const contractDefs: Array<[string, Address | undefined]> = [
  ['escrow (1v1)', dep.escrow],
  ['escrowN (multiplayer)', dep.escrowN],
  ['racePass', dep.racePass],
  ['cosmeticsStore', dep.cosmeticsStore],
];
const walletDefs: Array<[string, Address | undefined]> = [
  ['arbiter (settles)', dep.arbiter],
  ['treasury (owner)', dep.treasury],
  ['faucet (Race drips)', faucet],
];

const contractRows = (await Promise.all(contractDefs.map(([l, a]) => measure(l, a, 'contract')))).filter(Boolean) as Row[];
const walletRows = (await Promise.all(walletDefs.map(([l, a]) => measure(l, a, 'wallet')))).filter(Boolean) as Row[];

const fmt = (r: Row): string => {
  const n = r.count == null ? 'n/a' : r.count.toLocaleString('en-US');
  const tag = r.source === 'explorer' ? '' : r.source === 'rpc-nonce' ? '  (nonce — sent only)' : '  (unavailable)';
  return `    ${r.label.padEnd(24)} ${n.padStart(8)}  ${r.addr}${tag}`;
};

const contractTotalKnown = contractRows.every((r) => r.source === 'explorer' && r.count != null);
const contractTotal = contractRows.reduce((s, r) => s + (r.count ?? 0), 0);
const walletTotal = walletRows.reduce((s, r) => s + (r.count ?? 0), 0);

console.log(`\n[onchain-activity] network=${networkName}  explorer=${BLOCKSCOUT}`);
console.log(`\n  Dapp contracts — transactions received (the Proof of Ship figure):`);
contractRows.forEach((r) => console.log(fmt(r)));
console.log(`    ${'—'.repeat(24)} ${'—'.repeat(8)}`);
console.log(`    ${'TOTAL (our contracts)'.padEnd(24)} ${contractTotal.toLocaleString('en-US').padStart(8)}${contractTotalKnown ? '' : '  (partial — some rows are nonce-only)'}`);

console.log(`\n  Operational wallets — transactions broadcast (nonce/explorer):`);
walletRows.forEach((r) => console.log(fmt(r)));
console.log(`\n  Note: arbiter settlements are calls to the escrow, so they are already`);
console.log(`  inside the contract totals above — the wallet rows are shown for context`);
console.log(`  and are NOT added to the contract headline (would double-count).`);
console.log(`  Wallet-broadcast subtotal (context only): ${walletTotal.toLocaleString('en-US')}`);
console.log('');
