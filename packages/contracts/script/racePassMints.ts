/**
 * READ-ONLY daily census of RacePass mints, straight from the chain.
 *
 * WHY THIS EXISTS. Dune is the natural home for this, but its Celo indexing runs
 * hours behind — measured at ~6h — so "how many wallets minted TODAY" is exactly
 * the question it cannot answer. Reading `Minted` logs over the day's block range
 * costs one RPC round and is current to the last block.
 *
 * The Pass is soulbound and one-per-wallet, so a mint IS a distinct new player:
 * this is the cleanest acquisition metric the deployment has.
 *
 * Usage:
 *   NETWORK=celo npm run race-pass-mints -w packages/contracts          # today (UTC)
 *   NETWORK=celo DAYS=7 npm run race-pass-mints -w packages/contracts   # last 7 days
 *   NETWORK=celo DAY=2026-07-26 npm run race-pass-mints -w packages/contracts
 *
 * Sends NO transaction and needs no key.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, http, parseAbiItem, type Address, type Chain } from 'viem';

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
  console.error(`race-pass-mints: set NETWORK to one of: ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}

const deployments = JSON.parse(readFileSync(join(ROOT, 'deployments.json'), 'utf8')) as Record<string, { racePass?: string }>;
const racePass = env('RACE_PASS_ADDRESS') ?? deployments[networkName]?.racePass;
if (!racePass) {
  console.error(`race-pass-mints: no racePass address for "${networkName}" in deployments.json`);
  process.exit(1);
}

const client = createPublicClient({ chain: preset.chain, transport: http(env(preset.rpcEnv) ?? preset.defaultRpc) });

/** `event Minted(address indexed holder, uint256 indexed tokenId)` — the mint
 *  hook, distinct from the ERC-721 Transfer so a later transfer cannot inflate
 *  the count (the Pass is soulbound, but the event is the intent either way). */
const MINTED = parseAbiItem('event Minted(address indexed holder, uint256 indexed tokenId)');

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The first block at or after `ts`, by binary search on block timestamps.
 * Celo has ~1s blocks, so a linear scan over a day would be ~86k requests; this
 * costs ~log2(head) reads instead.
 */
async function blockAtOrAfter(ts: bigint, head: bigint): Promise<bigint> {
  let lo = 0n;
  let hi = head;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (block.timestamp < ts) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

/**
 * eth_getLogs in chunks: public RPCs cap the span of a single range query.
 * Forno rejects anything over 5000 blocks ("query exceeds range, retry smaller"),
 * so we start below that AND halve on a range complaint — a hard-coded constant
 * would break again the day a provider tightens its limit.
 */
async function mintedLogs(from: bigint, to: bigint): Promise<Array<{ holder: Address; blockNumber: bigint }>> {
  const out: Array<{ holder: Address; blockNumber: bigint }> = [];
  let step = 4_000n;
  let start = from;
  while (start <= to) {
    const end = start + step - 1n > to ? to : start + step - 1n;
    try {
      const logs = await client.getLogs({ address: racePass as Address, event: MINTED, fromBlock: start, toBlock: end });
      for (const l of logs) {
        const holder = (l.args as { holder?: Address }).holder;
        if (holder) out.push({ holder, blockNumber: l.blockNumber! });
      }
      start = end + 1n;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).toLowerCase();
      const rangeIssue = msg.includes('range') || msg.includes('too many') || msg.includes('limit');
      if (!rangeIssue || step <= 100n) throw e;
      step = step / 2n; // retry the SAME start with a narrower window
      console.log(`  (RPC capped the range — narrowing to ${step} blocks per query)`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const head = await client.getBlockNumber();
  const headBlock = await client.getBlock({ blockNumber: head });
  const now = new Date(Number(headBlock.timestamp) * 1000);

  const explicitDay = env('DAY');
  const days = explicitDay ? 1 : Math.max(1, Number(env('DAYS') ?? 1));
  // Window start: 00:00 UTC of the first day we report on.
  const startDay = explicitDay ? new Date(`${explicitDay}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
  if (Number.isNaN(startDay.getTime())) {
    console.error('race-pass-mints: DAY must be YYYY-MM-DD');
    process.exit(1);
  }
  const endExclusive = explicitDay ? new Date(startDay.getTime() + 86_400_000) : null;

  const fromBlock = await blockAtOrAfter(BigInt(Math.floor(startDay.getTime() / 1000)), head);
  const toBlock = endExclusive ? (await blockAtOrAfter(BigInt(Math.floor(endExclusive.getTime() / 1000)), head)) - 1n : head;

  console.log(`\n[race-pass-mints] network=${networkName}  racePass=${racePass}`);
  console.log(`  chain head   : block ${head} at ${now.toISOString()}  (live — no indexer lag)`);
  console.log(`  window       : ${dayKey(startDay)}${endExclusive ? '' : ` → ${dayKey(now)}`}  (blocks ${fromBlock}…${toBlock})\n`);

  if (toBlock < fromBlock) {
    console.log('  (the window is entirely in the future — nothing to report)\n');
    return;
  }

  const logs = await mintedLogs(fromBlock, toBlock);
  if (logs.length === 0) {
    console.log('  0 mint in this window.\n');
    return;
  }

  // Group by UTC day. One getBlock per distinct block that carried a mint —
  // mints are rare, so this stays a handful of reads.
  const blockTimes = new Map<bigint, number>();
  for (const l of logs) {
    if (!blockTimes.has(l.blockNumber)) {
      const b = await client.getBlock({ blockNumber: l.blockNumber });
      blockTimes.set(l.blockNumber, Number(b.timestamp));
    }
  }
  const byDay = new Map<string, Set<string>>();
  for (const l of logs) {
    const day = dayKey(new Date(blockTimes.get(l.blockNumber)! * 1000));
    if (!byDay.has(day)) byDay.set(day, new Set());
    byDay.get(day)!.add(l.holder.toLowerCase());
  }

  console.log('  day           wallets   (the Pass is soulbound + 1/wallet, so wallets = new players)');
  console.log('  ─────────────────────────');
  for (const day of [...byDay.keys()].sort()) {
    console.log(`  ${day}    ${String(byDay.get(day)!.size).padStart(5)}`);
  }
  const all = new Set<string>();
  for (const s of byDay.values()) for (const w of s) all.add(w);
  console.log(`  ─────────────────────────`);
  console.log(`  TOTAL          ${String(all.size).padStart(5)} distinct wallet(s), ${logs.length} mint event(s)\n`);
  if (all.size !== logs.length) {
    console.log('  NOTE: more events than wallets — a wallet minted twice, which the');
    console.log('        soulbound one-per-wallet rule should make impossible. Investigate.\n');
  }
}

main().catch((e) => {
  console.error('race-pass-mints failed:', e);
  process.exit(1);
});
