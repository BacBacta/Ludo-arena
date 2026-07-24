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
const prizeSpent = Number((await store.getMeta(POOL_SPENT_KEY)) || '0');
const seedSpent = Number((await store.getMeta(SEED_SPENT_KEY)) || '0');

console.log('=== Race Week budget (live) ===');
console.log(`race:pool:spent (prize): ${prizeSpent}c`);
console.log(`race:seed:spent (gas)  : ${seedSpent}c`);
console.log(`spent TOTAL            : ${prizeSpent + seedSpent}c`);

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
}
process.exit(0);
