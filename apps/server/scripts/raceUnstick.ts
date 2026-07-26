/**
 * Clear the Race Week entry records of specific wallets, so a player wrongly
 * told "already funded" can enter again.
 *
 * WHY THIS EXISTS. `resumeSession` reconciled the wallet on its in-memory branch
 * and not on its durable one (fixed in #143). The durable branch runs after every
 * restart, so a player who switched address was resumed onto the PREVIOUS wallet:
 * race.claim then keyed on the old address, found its grant record, and answered
 * "already funded" — while the NEW address received nothing. That record never
 * expires, so the wallet stays locked out for good. #143 stops it happening; only
 * this clears what already happened.
 *
 *   UNSTICK_WALLETS="0xabc…,0xdef…" npm run race-unstick -w apps/server
 *   UNSTICK_WALLETS="0xabc…" APPLY=1 npm run race-unstick -w apps/server
 *
 * DRY RUN BY DEFAULT, deliberately. Deleting a grant record re-opens a claim,
 * which SPENDS FROM THE PRIZE POOL — this is not a tidy-up, it is a payment
 * authorisation. The dry run prints, for each wallet, the stored record and its
 * LIVE on-chain balance, so the operator decides against evidence:
 *
 *   • record says N cents, balance ~0  → the grant never landed. Clearing is right.
 *   • record says 0 cents ("self-funded"), balance ~0 → the balance-aware branch
 *     fired on a seeded wallet that has since spent it. Clearing is right.
 *   • record says N cents, balance >= N → the player WAS paid. Clearing would pay
 *     them twice; the script says so and refuses unless FORCE=1.
 *
 * Runs INSIDE the Fly machine (needs the prod store + an RPC). Sends no
 * transaction of its own. Idempotent.
 */
import { createPublicClient, defineChain, http, type Address } from 'viem';
import { createStore } from '../src/store/index.js';

const env = (n: string): string | undefined => {
  const v = process.env[n];
  return v && v.trim() !== '' ? v.trim() : undefined;
};

const raw = (env('UNSTICK_WALLETS') ?? '').trim();
if (!raw) {
  console.error('[race-unstick] set UNSTICK_WALLETS to a comma/space-separated list of wallet addresses.');
  process.exit(1);
}
const wallets = [...new Set(raw.split(/[\s,]+/).map((w) => w.trim().toLowerCase()).filter((w) => /^0x[0-9a-f]{40}$/.test(w)))];
if (wallets.length === 0) {
  console.error('[race-unstick] no valid 0x… addresses parsed from UNSTICK_WALLETS.');
  process.exit(1);
}

const APPLY = env('APPLY') === '1';
const FORCE = env('FORCE') === '1';

const ERC20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

const CHAINS: Record<string, { id: number; rpc: string }> = {
  celo: { id: 42_220, rpc: env('CELO_RPC') ?? 'https://forno.celo.org' },
  'celo-sepolia': { id: 11_142_220, rpc: env('CELO_SEPOLIA_RPC') ?? 'https://forno.celo-sepolia.celo-testnet.org' },
};
const chainName = env('CHAIN') ?? 'celo';
const preset = CHAINS[chainName] ?? CHAINS.celo!;
const stablecoin = env('RACE_STABLECOIN_ADDRESS') as Address | undefined;

/** Live balance in cents, or null when it cannot be read (never guess). */
async function balanceCents(w: Address): Promise<number | null> {
  if (!stablecoin) return null;
  try {
    const client = createPublicClient({
      chain: defineChain({ id: preset.id, name: chainName, nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: [preset.rpc] } } }),
      transport: http(preset.rpc),
    });
    const [bal, dec] = await Promise.all([
      client.readContract({ address: stablecoin, abi: ERC20, functionName: 'balanceOf', args: [w] }) as Promise<bigint>,
      client.readContract({ address: stablecoin, abi: ERC20, functionName: 'decimals' }) as Promise<number>,
    ]);
    return Number((bal * 100n) / 10n ** BigInt(dec));
  } catch {
    return null;
  }
}

const store = await createStore();

console.log(`\n[race-unstick] ${APPLY ? 'APPLY' : 'DRY RUN'} · ${wallets.length} wallet(s) · chain=${chainName}`);
if (!stablecoin) console.log('  NOTE: RACE_STABLECOIN_ADDRESS unset — balances unreadable, shown as "?".');
console.log('');

let cleared = 0;
let skipped = 0;

for (const w of wallets) {
  const grantRaw = await store.getMeta(`race:grant:${w}`);
  const fundedRaw = await store.getMeta(`race:funded:${w}`);
  const seedRaw = await store.getMeta(`race:seed:${w}`);
  const bal = await balanceCents(w as Address);

  let grantCents: number | null = null;
  try {
    if (grantRaw) grantCents = Number((JSON.parse(grantRaw) as { cents?: number }).cents ?? 0);
  } catch {
    grantCents = null;
  }

  console.log(`  ${w}`);
  console.log(`     grant record : ${grantRaw ? `${grantCents ?? '?'}c  ${grantRaw}` : '(none)'}`);
  console.log(`     funded/seed  : ${fundedRaw ?? '(none)'} / ${seedRaw ?? '(none)'}`);
  console.log(`     on-chain     : ${bal === null ? '?' : `${bal}c`}`);

  if (!grantRaw) {
    console.log('     → nothing to clear (this wallet never claimed).\n');
    skipped += 1;
    continue;
  }
  // The one case where clearing PAYS TWICE: the record says money went out and
  // the wallet still holds at least that much.
  const alreadyPaid = grantCents !== null && grantCents > 0 && bal !== null && bal >= grantCents;
  if (alreadyPaid && !FORCE) {
    console.log(`     → REFUSED: the grant of ${grantCents}c appears to have LANDED (balance ${bal}c).`);
    console.log('       Clearing would let it be claimed a second time. Re-run with FORCE=1 if you');
    console.log('       are certain this wallet must be re-opened.\n');
    skipped += 1;
    continue;
  }
  if (!APPLY) {
    console.log('     → would clear grant + funded records (dry run).\n');
    continue;
  }
  await store.setMeta(`race:grant:${w}`, '');
  await store.setMeta(`race:funded:${w}`, '');
  console.log('     → CLEARED. This wallet may claim again.\n');
  cleared += 1;
}

console.log(`[race-unstick] ${APPLY ? `cleared ${cleared}` : `${wallets.length - skipped} would be cleared`} · ${skipped} skipped.`);
if (!APPLY) console.log('[race-unstick] DRY RUN — nothing was written. Re-run with APPLY=1 to commit.');
// The DEVICE records (race:fp / race:seedfp) are deliberately left alone: they
// bound how much one device cohort may ever draw, and clearing them would hand
// the same phone a fresh allowance — a different decision from unsticking a
// wallet, and one that should be taken explicitly.
console.log('[race-unstick] device records (race:fp / race:seedfp) were NOT touched.');
process.exit(0);
