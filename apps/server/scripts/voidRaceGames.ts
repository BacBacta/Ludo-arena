/**
 * Invalidate identified FARM games and rebuild the Race Week leaderboard.
 *
 * The surgical alternative to prune-race-board. Pruning deletes a whole wallet:
 * a player who farmed 10 games out of 50 also loses the 40 honest ones, which is
 * both unfair and indefensible if they dispute it. This voids the GAMES the
 * audit flagged and recomputes the board as if they had never been played —
 * every other point the player earned survives.
 *
 *   VOID_GAMES="<gameId>,<gameId>" npm run void-race-games -w apps/server
 *   VOID_PAIR="0xfarmer,0xaccomplice" npm run void-race-games -w apps/server
 *   ...add APPLY=1 to write (default is a DRY RUN that only prints the diff).
 *
 * VOID_PAIR voids every head-to-head game between two wallets — the collusion
 * ring signature race-audit reports — without having to paste dozens of ids.
 * UNVOID=1 reverses a call that turns out to be wrong.
 *
 * The voided set is DURABLE (meta key race:voided) and cumulative, so the board
 * stays correct when it is rebuilt again later.
 *
 * How the rebuild stays honest
 * ────────────────────────────
 *  · Participants come from the real `race:grant:<wallet>` keys, and a game only
 *    scores if BOTH wallets already held their grant when it ENDED — exactly
 *    scoreEventGame's precondition, evaluated at the game's own timestamp.
 *  · Only games after `race:epoch` (stamped by reset-race-board) are replayed,
 *    so a reset board never resurrects pre-reset points. Override with SINCE.
 *  · Before touching anything it replays with the CURRENT voided set and checks
 *    the result reproduces the live board. If it doesn't, the replay's
 *    assumptions don't match how the board was actually built and APPLY is
 *    refused (FORCE=1 overrides, deliberately).
 *  · APPLY writes board + voided set + resynced anti-farm counters in ONE
 *    Postgres transaction, guarded by the board row's value being unchanged, so
 *    a game finishing mid-run can't be silently clobbered.
 *
 * Runs INSIDE the Fly machine (needs the prod Postgres, where meta lives).
 */
import pg from 'pg';
import { replayRaceBoard, type ReplayGame } from '../src/raceScore.js';
import type { GameOverReason } from '@ludo/shared';

const DB = process.env.DATABASE_URL?.trim();
if (!DB) {
  console.error('[void-race-games] DATABASE_URL is not set — run this inside the Fly machine.');
  process.exit(1);
}
const APPLY = (process.env.APPLY ?? '').trim() === '1';
const UNVOID = (process.env.UNVOID ?? '').trim() === '1';
const FORCE = (process.env.FORCE ?? '').trim() === '1';
const idsRaw = (process.env.VOID_GAMES ?? '').trim();
const pairRaw = (process.env.VOID_PAIR ?? '').trim();
const sinceRaw = (process.env.SINCE ?? '').trim();

const BOARD_KEY = 'race:board';
const VOIDED_KEY = 'race:voided';
const EPOCH_KEY = 'race:epoch';

const pool = new pg.Pool({ connectionString: DB });
const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> =>
  pool.query<T>(sql, params).then((r) => r.rows);
const die = async (msg: string): Promise<never> => {
  console.error(`[void-race-games] ${msg}`);
  await pool.end();
  process.exit(1);
};

interface BoardBlob {
  [wallet: string]: { name: string; points: number };
}

// ---- 1. the live board (what we must reproduce, then correct) ----
const boardRaw = (await q<{ value: string }>(`SELECT value FROM meta WHERE key = $1`, [BOARD_KEY]))[0]?.value ?? null;
let board: BoardBlob = {};
try {
  board = boardRaw ? (JSON.parse(boardRaw) as BoardBlob) : {};
} catch {
  board = {};
}

// ---- 2. participants + when each became one ----
// scoreEventGame requires BOTH wallets to hold a race:grant. The grant records
// the instant it was issued, so a game only scored if it ended AFTER both
// grants — replaying without that check would invent points for games the two
// played before they joined the event.
const grantRows = await q<{ key: string; value: string }>(
  `SELECT key, value FROM meta WHERE key LIKE 'race:grant:%' AND value <> ''`,
);
const grantAt = new Map<string, number>();
for (const r of grantRows) {
  const wallet = r.key.slice('race:grant:'.length).toLowerCase();
  let at = 0;
  try {
    at = Number((JSON.parse(r.value) as { at?: number }).at ?? 0) || 0;
  } catch {
    at = 0; // malformed grant → treat as "joined at the dawn of the event"
  }
  grantAt.set(wallet, at);
}
if (grantAt.size === 0) await die('no race:grant:* keys found — is this the Race Week machine?');

// ---- 3. the window this board was built from ----
const epochRaw = sinceRaw || (await q<{ value: string }>(`SELECT value FROM meta WHERE key = $1`, [EPOCH_KEY]))[0]?.value || '';
const epochMs = epochRaw ? new Date(epochRaw).getTime() : NaN;
if (epochRaw && Number.isNaN(epochMs)) await die(`SINCE/race:epoch is not a valid date: ${epochRaw}`);
const since = Number.isNaN(epochMs) ? 0 : epochMs;
console.log(
  `[void-race-games] ${grantAt.size} participant(s) · window: ${since ? new Date(since).toISOString() : 'ALL history (no race:epoch — pass SINCE=<ISO> if the board was reset)'}`,
);

// ---- 4. resolve the games to void ----
const explicit = idsRaw ? idsRaw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) : [];
const pair = pairRaw
  ? pairRaw.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter((w) => /^0x[0-9a-f]{40}$/.test(w))
  : [];
if (pairRaw && pair.length !== 2) await die('VOID_PAIR needs exactly two 0x… addresses.');
let pairIds: string[] = [];
if (pair.length === 2) {
  pairIds = (
    await q<{ id: string }>(
      `SELECT id FROM games
        WHERE ((player_a = $1 AND player_b = $2) OR (player_a = $2 AND player_b = $1))
          AND is_house_bot = false`,
      [pair[0], pair[1]],
    )
  ).map((r) => r.id);
  console.log(`[void-race-games] VOID_PAIR matched ${pairIds.length} head-to-head game(s).`);
}
const targets = [...new Set([...explicit, ...pairIds])];
if (targets.length === 0) await die('nothing to do — set VOID_GAMES and/or VOID_PAIR.');

// ---- 5. merge into the durable voided set ----
const priorRaw = (await q<{ value: string }>(`SELECT value FROM meta WHERE key = $1`, [VOIDED_KEY]))[0]?.value ?? null;
let priorList: string[] = [];
try {
  priorList = priorRaw ? (JSON.parse(priorRaw) as string[]) : [];
} catch {
  priorList = [];
}
const prior = new Set(priorList);
const voided = new Set(prior);
for (const id of targets) {
  if (UNVOID) voided.delete(id);
  else voided.add(id);
}
console.log(
  `[void-race-games] ${UNVOID ? 'UN-VOIDING' : 'voiding'} ${targets.length} game(s); voided set: ${prior.size} -> ${voided.size}`,
);

// ---- 6. the event history the board was built from ----
const wallets = [...grantAt.keys()];
const rows = await q<{
  id: string;
  player_a: string;
  player_b: string;
  winner_seat: number;
  reason: string;
  ended_at: string;
}>(
  `SELECT id, player_a, player_b, winner_seat, reason, ended_at
     FROM games
    WHERE player_a = ANY($1) AND player_b = ANY($1) AND is_house_bot = false
    ORDER BY ended_at ASC, id ASC`,
  [wallets],
);
const names = new Map(
  (await q<{ id: string; name: string }>(`SELECT id, name FROM players WHERE id = ANY($1)`, [wallets])).map((p) => [
    p.id.toLowerCase(),
    p.name,
  ]),
);
const nameOf = (w: string): string => board[w]?.name ?? names.get(w) ?? `${w.slice(0, 6)}…${w.slice(-4)}`;

const games: ReplayGame[] = [];
let skippedPreGrant = 0;
for (const r of rows) {
  const a = r.player_a.toLowerCase();
  const b = r.player_b.toLowerCase();
  const endedMs = new Date(r.ended_at).getTime();
  // Both grants must predate the finish, and the game must be inside the window
  // the current board was built from.
  if (endedMs < since || endedMs < Math.max(grantAt.get(a) ?? 0, grantAt.get(b) ?? 0)) {
    skippedPreGrant += 1;
    continue;
  }
  const winner = r.winner_seat === 0 ? a : b;
  const loser = winner === a ? b : a;
  games.push({
    id: r.id,
    winnerWallet: winner,
    winnerName: nameOf(winner),
    loserWallet: loser,
    loserName: nameOf(loser),
    reason: r.reason as GameOverReason,
    day: new Date(endedMs).toISOString().slice(0, 10),
  });
}
console.log(
  `[void-race-games] replaying ${games.length} event game(s)` +
    (skippedPreGrant ? ` (${skippedPreGrant} outside the window / pre-grant, ignored)` : ''),
);

// ---- 7. fidelity gate: does the replay reproduce the CURRENT board? ----
// If it doesn't, the rules or the window no longer describe how the live board
// was built, and "correcting" it would rewrite honest scores. Report and refuse.
const points = (b: BoardBlob): Map<string, number> =>
  new Map(Object.entries(b).map(([w, v]) => [w.toLowerCase(), v.points]));
const before = points(board);
const baseline = points(replayRaceBoard(games, prior).board);
const fidelity = [...new Set([...before.keys(), ...baseline.keys()])]
  .map((w) => ({ w, live: before.get(w) ?? 0, replay: baseline.get(w) ?? 0 }))
  .filter((r) => r.live !== r.replay);
if (fidelity.length === 0) {
  console.log('[void-race-games] fidelity check OK — the replay reproduces the live board exactly.');
} else {
  console.log(`\n⚠  FIDELITY MISMATCH on ${fidelity.length} player(s) — replaying the CURRENT voided set does not`);
  console.log('   reproduce the live board, so the rebuild would rewrite scores it cannot explain:');
  for (const f of fidelity.slice(0, 20)) {
    console.log(`     ${nameOf(f.w).slice(0, 18).padEnd(19)} ${f.w.slice(0, 10)}…  live ${String(f.live).padStart(4)}  replay ${String(f.replay).padStart(4)}`);
  }
  if (fidelity.length > 20) console.log(`     …and ${fidelity.length - 20} more`);
  console.log('   Likely causes: the scoring env (RACE_* points/caps) changed mid-event, the board was');
  console.log('   hand-edited (prune-race-board), or the window is wrong — pass SINCE=<ISO> to fix it.');
}

// ---- 8. the correction ----
const replayed = replayRaceBoard(games, voided);
const after = points(replayed.board);
const touched = [...new Set([...before.keys(), ...after.keys()])]
  .map((w) => ({ w, before: before.get(w) ?? 0, after: after.get(w) ?? 0 }))
  .filter((r) => r.before !== r.after)
  .sort((a, b) => a.after - a.before - (b.after - b.before));

console.log('\n=== board changes ===');
if (touched.length === 0) console.log('  (none — the voided games scored nothing, or were already voided)');
for (const t of touched) {
  const d = t.after - t.before;
  console.log(
    `  ${nameOf(t.w).slice(0, 18).padEnd(19)} ${t.w.slice(0, 10)}…  ${String(t.before).padStart(4)} -> ${String(t.after).padStart(4)}  (${d >= 0 ? '+' : ''}${d})`,
  );
}

// ---- 9. write (or not) ----
if (!APPLY) {
  console.log('\n[void-race-games] DRY RUN — nothing written. Re-run with APPLY=1 to commit.');
  await pool.end();
  process.exit(0);
}
if (fidelity.length > 0 && !FORCE) {
  await die('refusing to APPLY over a fidelity mismatch (see above). Re-run with FORCE=1 if that is intended.');
}

// The anti-farm counters must move with the board: leaving them behind would
// keep the caps a voided game consumed marked as spent, so an honest game that
// was capped out behind the farm would stay unrewarded for the rest of the day.
const counters: Array<[string, string]> = [];
for (const [k, n] of replayed.daily) {
  const [wallet, day] = k.split(':') as [string, string];
  counters.push([`race:daily:${wallet}:${day}`, String(n)]);
}
for (const [k, n] of replayed.vs) {
  const [w, l, day] = k.split(':') as [string, string, string];
  counters.push([`race:vs:${w}:${l}:${day}`, String(n)]);
}

const client = await pool.connect();
try {
  await client.query('BEGIN');
  // Optimistic guard: a game that finished while we were computing would have
  // written a board we never saw. Lock the row and compare before overwriting.
  const locked = await client.query<{ value: string }>(`SELECT value FROM meta WHERE key = $1 FOR UPDATE`, [BOARD_KEY]);
  if ((locked.rows[0]?.value ?? null) !== boardRaw) {
    await client.query('ROLLBACK');
    await die('race:board changed while this run was computing (a game just finished) — nothing written, re-run.');
  }
  const upsert = `INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`;
  await client.query(upsert, [VOIDED_KEY, JSON.stringify([...voided])]);
  await client.query(upsert, [BOARD_KEY, JSON.stringify(replayed.board)]);
  // Clear then rewrite so counters the replay dropped to zero don't linger.
  await client.query(`DELETE FROM meta WHERE key LIKE 'race:daily:%' OR key LIKE 'race:vs:%'`);
  for (const [k, v] of counters) await client.query(upsert, [k, v]);
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw e;
} finally {
  client.release();
}
console.log(`\n[void-race-games] APPLIED: race:board + race:voided + ${counters.length} anti-farm counter(s) updated.`);
await pool.end();
process.exit(0);
