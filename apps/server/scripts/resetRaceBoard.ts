/**
 * Reset the Race Week leaderboard to a clean slate (pre-campaign launch).
 *
 * Clears the `race:board` blob so `raceLeaderboard` returns an empty board and
 * everyone starts at 0 points. The anti-farm per-day counters (`race:daily:*`,
 * `race:vs:*`) are day-keyed and reset naturally, so they're left as-is — they
 * never affect the displayed board.
 *
 * With `full` (arg) or FULL=1 (env) it ALSO zeroes the campaign spend counters
 * (`race:pool:spent`, `race:seed:spent`) so the $30 prize / stake-sponsorship
 * budget starts fresh — use this when the test phase already drew from the pool.
 *
 * Backend-agnostic: uses the server's own createStore (Redis / Postgres / memory
 * per the machine's env). Meant to run INSIDE the Fly machine (it needs the prod
 * store connection), e.g. `npm run reset-race-board -w apps/server`.
 */
import { createStore } from '../src/store/index.js';

const BOARD_KEY = 'race:board';
const POOL_SPENT_KEY = 'race:pool:spent';
const SEED_SPENT_KEY = 'race:seed:spent';

const full = process.argv.includes('full') || process.env.FULL === '1';

const store = await createStore();

const before = await store.getMeta(BOARD_KEY);
let entries = 0;
try {
  entries = before ? Object.keys(JSON.parse(before)).length : 0;
} catch {
  entries = 0;
}
await store.setMeta(BOARD_KEY, '{}');
console.log(`[reset-race-board] race:board cleared (${entries} player(s) removed).`);

if (full) {
  const poolBefore = await store.getMeta(POOL_SPENT_KEY);
  const seedBefore = await store.getMeta(SEED_SPENT_KEY);
  await store.setMeta(POOL_SPENT_KEY, '0');
  await store.setMeta(SEED_SPENT_KEY, '0');
  console.log(`[reset-race-board] FULL: race:pool:spent ${poolBefore ?? '(unset)'} -> 0, race:seed:spent ${seedBefore ?? '(unset)'} -> 0.`);
} else {
  console.log('[reset-race-board] budget spend counters left as-is (pass `full` to also reset them).');
}

console.log('[reset-race-board] done.');
process.exit(0);
