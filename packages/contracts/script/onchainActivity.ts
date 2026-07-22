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

const CAP = 10_000; // etherscan-compat txlist page cap

// Etherscan-compatible txlist (Blockscout supports it at /api). Counts the
// address's top-level normal transactions — for a contract that is every direct
// call INTO it (join / settle / mint / purchase / admin); for a wallet, its
// sent + received txs. Returns { count, capped } or null if the probe failed.
// This is more trustworthy than the v2 /counters endpoint, which returned 0 for
// addresses that provably have transactions.
async function explorerTxCount(addr: Address): Promise<{ count: number; capped: boolean } | null> {
  try {
    const url = `${BLOCKSCOUT}/api?module=account&action=txlist&address=${addr}&startblock=0&endblock=99999999&page=1&offset=${CAP}&sort=asc`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const j = (await res.json()) as { status?: string; message?: string; result?: unknown };
    // Blockscout returns status "0" + message "No transactions found" for an
    // empty (but valid) address — that is a real zero, not a probe failure.
    if (Array.isArray(j.result)) return { count: j.result.length, capped: j.result.length >= CAP };
    if (j.status === '0' && typeof j.message === 'string' && /no transactions/i.test(j.message)) return { count: 0, capped: false };
    return null;
  } catch {
    return null;
  }
}

type Row = {
  label: string;
  addr: Address;
  kind: 'contract' | 'wallet';
  nonce: number | null; // txs SENT by the address (authoritative via RPC)
  explorer: number | null; // top-level txs to/from (indexer)
  capped: boolean;
};

async function measure(label: string, addr: Address | undefined, kind: 'contract' | 'wallet'): Promise<Row | null> {
  if (!addr || !isAddress(addr)) return null;
  const [nonceRes, ex] = await Promise.all([
    publicClient.getTransactionCount({ address: addr }).then(
      (n) => n,
      () => null,
    ),
    explorerTxCount(addr),
  ]);
  return { label, addr, kind, nonce: nonceRes, explorer: ex?.count ?? null, capped: ex?.capped ?? false };
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

const num = (n: number | null): string => (n == null ? 'n/a' : n.toLocaleString('en-US'));
const fmt = (r: Row): string => {
  const ex = r.explorer == null ? 'n/a' : `${num(r.explorer)}${r.capped ? '+' : ''}`;
  return `    ${r.label.padEnd(24)} ${ex.padStart(8)} txs   (sent by it: ${num(r.nonce)})   ${r.addr}`;
};

const allRows = [...contractRows, ...walletRows];
const explorerHealthy = allRows.some((r) => (r.explorer ?? 0) > 0) || allRows.every((r) => r.explorer != null);
const contractExplorerTotal = contractRows.reduce((s, r) => s + (r.explorer ?? 0), 0);
const walletNonceTotal = walletRows.reduce((s, r) => s + (r.nonce ?? 0), 0);
// A guaranteed floor from RPC alone: every tx our wallets broadcast (deploys,
// settlements, drips, admin) — indexer-independent, always correct.
const broadcastFloor = walletNonceTotal;

console.log(`\n[onchain-activity] network=${networkName}  explorer=${BLOCKSCOUT}`);
console.log(`  columns: "txs" = top-level transactions to/from (indexer) · "sent by it" = RPC nonce (authoritative)`);
console.log(`\n  Dapp contracts — transactions INTO our code (the Proof of Ship figure):`);
contractRows.forEach((r) => console.log(fmt(r)));
console.log(`    ${'—'.repeat(24)} ${'—'.repeat(8)}`);
console.log(`    ${'TOTAL (our contracts)'.padEnd(24)} ${num(contractExplorerTotal).padStart(8)} txs`);

console.log(`\n  Operational wallets — transactions we BROADCAST (settle / drip / admin / deploy):`);
walletRows.forEach((r) => console.log(fmt(r)));
console.log(`\n  Note: arbiter/treasury settlements are calls to the escrow, so they are`);
console.log(`  already inside the contract totals above — the wallet rows are shown for`);
console.log(`  context and are NOT added to the contract headline (would double-count).`);
console.log(`  Wallet-broadcast subtotal (RPC nonce, always correct): ${num(broadcastFloor)}`);

if (!explorerHealthy) {
  console.log(`\n  ⚠ The explorer (${BLOCKSCOUT}) returned no data for any address — its`);
  console.log(`    index is unavailable or the host changed. The contract "txs" column`);
  console.log(`    can't be trusted right now; re-run later or set BLOCKSCOUT_URL to a`);
  console.log(`    working Celo explorer. The RPC nonce column above is unaffected.`);
}
console.log(`\n  Bottom line: our wallets have broadcast at least ${num(broadcastFloor)} mainnet txs`);
console.log(`  (deploys + settlements + drips + admin — RPC-proven), plus ${num(contractExplorerTotal)} txs`);
console.log(`  recorded INTO our contracts by the explorer (player joins / mints / purchases).`);
console.log('');
