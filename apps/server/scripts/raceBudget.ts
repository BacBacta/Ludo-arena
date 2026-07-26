/**
 * READ-ONLY Race Week budget probe — answers "why is the gas seed refused?".
 *
 * The seed/claim/JIT paths all draw from ONE provisioned budget
 * (RACE_POOL_CENTS) tracked by two meta counters that survive every deploy:
 *   race:pool:spent  — PRIZE dimension (entry grants + JIT top-ups)
 *   race:seed:spent  — GAS dimension (pre-mint burner seeds)
 * seedGrantCents()/jitTopUpCents() return 0 the moment their sum reaches the
 * cap — from then on every new player's gas seed is refused ("funding pool is
 * exhausted") and mints die on funds, even with a well-stocked faucet wallet.
 *
 * Prints the counters, the cap, the computed headroom, the RESOLVED token
 * config (stake token vs CIP-64 gas currency — settles any cUSD/USD₮ drift),
 * and the faucet wallet's live balances. Sends nothing, writes nothing.
 *
 * Meant to run INSIDE the Fly machine (store + prod env):
 *   npm run race-budget -w apps/server
 */
import { createStore } from '../src/store/index.js';
import { budgetLeftCents, createRaceFaucet, poolLeftCents } from '../src/race.js';

const store = await createStore();
const faucet = createRaceFaucet();

const POOL_SPENT_KEY = 'race:pool:spent';
const SEED_SPENT_KEY = 'race:seed:spent';
// NATIVE sponsorship counter (external wallets — CELO, wei-denominated, its own
// pool). Invisible here until the 0x9819 investigation: a native grant, refusal
// or exhaustion showed up in NO probe, so "nothing happened" and "it worked"
// read identically. Never add this to the cents counters — different units.
const NSEED_SPENT_KEY = 'race:nseed:spent';
const prizeSpent = Number((await store.getMeta(POOL_SPENT_KEY)) || '0');
const seedSpent = Number((await store.getMeta(SEED_SPENT_KEY)) || '0');
const nseedSpentWei = BigInt((await store.getMeta(NSEED_SPENT_KEY))?.replace(/[^0-9]/g, '') || '0');
const celo = (wei: bigint): string => `${Number(wei) / 1e18} CELO`;

console.log('=== Race Week budget (live) ===');
console.log(`race:pool:spent (prize): ${prizeSpent}c`);
console.log(`race:seed:spent (gas)  : ${seedSpent}c`);
console.log(`spent TOTAL            : ${prizeSpent + seedSpent}c`);
console.log(`race:nseed:spent (CELO): ${celo(nseedSpentWei)} (native sponsorship — separate pool)`);

if (!faucet) {
  console.log('faucet: NOT ARMED (RACE_WEEK_ACTIVE/RACE_FAUCET_PRIVATE_KEY unset) — race.seed replies "not available".');
} else {
  console.log('=== Config (resolved from env + deployments) ===');
  console.log(`poolCents (cap)        : ${faucet.poolCents}c`);
  console.log(`seedCents (gas target) : ${faucet.seedCents}c`);
  console.log(`perGameCents / quota   : ${faucet.perGameCents}c / ${faucet.quotaCents}c (jit=${faucet.jit})`);
  console.log(`stake token            : ${faucet.stablecoin}`);
  console.log(`gas fee-currency       : ${faucet.feeCurrency}${faucet.feeCurrency === faucet.stablecoin ? ' (same as stake token)' : ' (ADAPTER — differs from stake token)'}`);
  console.log('=== Headroom ===');
  console.log(`budgetLeft (prize+gas) : ${budgetLeftCents(faucet.poolCents, prizeSpent, seedSpent)}c`);
  console.log(`poolLeft (player view) : ${poolLeftCents(faucet.poolCents, prizeSpent)}c`);
  const exhausted = budgetLeftCents(faucet.poolCents, prizeSpent, seedSpent) <= 0;
  console.log(`VERDICT: ${exhausted ? 'BUDGET EXHAUSTED — every new gas seed / grant is refused.' : 'budget has headroom — seeds are not budget-blocked.'}`);
  const bal = await faucet.faucetBalanceCents().catch(() => null);
  console.log(`faucet wallet          : ${faucet.address}`);
  console.log(`faucet stake-token bal : ${bal === null ? 'unreadable' : `${bal}c`}`);
  console.log('=== Native sponsorship (external wallets) ===');
  if (faucet.nativeSeedWei <= 0n) {
    console.log('native seed            : DISARMED (RACE_NATIVE_SEED_CELO=0) — race.seed{native} replies "not available".');
  } else {
    console.log(`native seed target     : ${celo(faucet.nativeSeedWei)} per wallet`);
    console.log(`native pool cap        : ${celo(faucet.nativePoolWei)} (spent ${celo(nseedSpentWei)})`);
    const nLeft = faucet.nativePoolWei - nseedSpentWei;
    console.log(`native headroom        : ${celo(nLeft > 0n ? nLeft : 0n)}${nLeft <= 0n ? ' — NATIVE POOL EXHAUSTED, every sponsorship is refused.' : ''}`);
    const nBal = await faucet.faucetNativeWei().catch(() => null);
    console.log(`faucet CELO balance    : ${nBal === null ? 'unreadable' : celo(nBal)}${nBal !== null && nBal < faucet.nativeSeedWei ? ' — BELOW ONE SEED, sends will fail.' : ''}`);
  }
}
process.exit(0);
