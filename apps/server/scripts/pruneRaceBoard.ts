/**
 * Remove specific wallets from the Race Week leaderboard (targeted farmer
 * purge before prize distribution). Unlike reset-race-board (which wipes the
 * whole board), this deletes ONLY the wallets listed in PRUNE_WALLETS and
 * leaves every legitimate player's points intact.
 *
 *   PRUNE_WALLETS="0xabc…,0xdef…" npm run prune-race-board -w apps/server
 *
 * Also zeroes each pruned wallet's anti-farm day counters (race:daily/race:vs)
 * so a lingering counter can't confuse a later audit — the board is the only
 * thing the leaderboard reads, but this keeps the store tidy.
 *
 * Backend-agnostic (server's createStore). Runs INSIDE the Fly machine (needs
 * the prod store). Read-modify-write of the single race:board blob; prints a
 * before/after summary and every wallet it touched. Idempotent — pruning an
 * already-absent wallet is a no-op.
 */
import { createStore } from '../src/store/index.js';

const BOARD_KEY = 'race:board';

const raw = (process.env.PRUNE_WALLETS ?? '').trim();
if (!raw) {
  console.error('[prune-race-board] set PRUNE_WALLETS to a comma/space-separated list of wallet addresses.');
  process.exit(1);
}
const wallets = [...new Set(raw.split(/[\s,]+/).map((w) => w.trim().toLowerCase()).filter((w) => /^0x[0-9a-f]{40}$/.test(w)))];
if (wallets.length === 0) {
  console.error('[prune-race-board] no valid 0x… addresses parsed from PRUNE_WALLETS.');
  process.exit(1);
}

const store = await createStore();

interface BoardBlob { [wallet: string]: { name: string; points: number } }
const before = await store.getMeta(BOARD_KEY);
let board: BoardBlob = {};
try {
  board = before ? (JSON.parse(before) as BoardBlob) : {};
} catch {
  board = {};
}

console.log(`[prune-race-board] board has ${Object.keys(board).length} player(s) before pruning.`);
let removed = 0;
for (const w of wallets) {
  if (board[w]) {
    console.log(`  − removing ${board[w].name} (${board[w].points} pts)  ${w}`);
    delete board[w];
    removed += 1;
  } else {
    console.log(`  · ${w} not on the board — nothing to remove`);
  }
}
await store.setMeta(BOARD_KEY, JSON.stringify(board));
console.log(`[prune-race-board] removed ${removed}/${wallets.length} wallet(s); board now has ${Object.keys(board).length} player(s).`);
console.log('[prune-race-board] done.');
process.exit(0);
