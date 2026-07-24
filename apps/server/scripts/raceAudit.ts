/**
 * READ-ONLY Race Week leaderboard audit — surfaces wash-trading / farming.
 *
 * Sends no writes (SELECT only). Meant to run INSIDE the Fly machine, where
 * DATABASE_URL points at the prod Postgres (same place reset-race-board runs):
 *   NAME=wizard npm run race-audit -w apps/server
 *
 * What it does:
 *   1. Reads the live leaderboard (`meta` key race:board) — rank, name, points.
 *   2. Joins the durable `players` + `games` tables to reconstruct, per
 *      participant, the REAL match history behind those points:
 *        · event games (both sides are Race participants), W–L, distinct opps
 *        · opponent concentration (share of games vs the single top opponent)
 *        · how the losses they COLLECTED ended — a farmer's accomplice throws
 *          games, so a high "wins via opponent resign/timeout" rate is a tell
 *        · velocity: min + median gap between a player's games (real games run
 *          ~2–3 min; back-to-back sub-minute finishes are scripted/duplicate)
 *        · account age vs games (a day-old wallet topping the board is a flag)
 *   3. Flags SUSPICIOUS PAIRS: two participants who mostly played each other,
 *      especially reciprocally (both climb) — the collusion-ring signature.
 *   4. Spotlights any player whose name matches NAME (case-insensitive), with a
 *      full opponent breakdown and a cross-check against the anti-farm counters
 *      (race:vs / race:daily) that decide what actually SCORED.
 *
 * Heuristics only — it explains WHY a row looks off; a human makes the call.
 */
import pg from 'pg';

const DB = process.env.DATABASE_URL?.trim();
if (!DB) {
  console.error('race-audit: DATABASE_URL is not set — run this inside the Fly machine (it needs the prod Postgres).');
  process.exit(1);
}
const NAME = process.env.NAME?.trim().toLowerCase() || '';
const TOP = Number(process.env.TOP ?? '15'); // how many ranks to deep-audit
const ABANDON = new Set(['timeout-forfeit', 'resign']); // loser gave up

const pool = new pg.Pool({ connectionString: DB });
const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> => pool.query<T>(sql, params).then((r) => r.rows);

const short = (w: string): string => (w.startsWith('anon:') ? w : `${w.slice(0, 6)}…${w.slice(-4)}`);
const pct = (n: number, d: number): string => (d === 0 ? '—' : `${Math.round((100 * n) / d)}%`);
const fmtGap = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)}m`);

// ---- 1. leaderboard ----
const boardRaw = (await q<{ value: string }>(`SELECT value FROM meta WHERE key = 'race:board'`))[0]?.value;
const board: Record<string, { name: string; points: number }> = boardRaw ? JSON.parse(boardRaw) : {};
const ranked = Object.entries(board)
  .map(([wallet, v]) => ({ wallet: wallet.toLowerCase(), name: v.name, points: v.points }))
  .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

if (ranked.length === 0) {
  console.log('\n[race-audit] The leaderboard is empty — nothing to audit.\n');
  await pool.end();
  process.exit(0);
}
const participants = new Set(ranked.map((r) => r.wallet));

// ---- player rows (age, elo, lifetime W/L) ----
const prows = await q<{ id: string; name: string; elo: number; games_played: number; wins: number; created_at: string }>(
  `SELECT id, name, elo, games_played, wins, created_at FROM players WHERE id = ANY($1)`,
  [[...participants]],
);
const players = new Map(prows.map((p) => [p.id, p]));

// ---- all games touching a participant ----
const allGames = await q<{ id: string; stake_cents: number; player_a: string; player_b: string; winner_seat: number; reason: string; ended_at: string; is_house_bot: boolean }>(
  `SELECT id, stake_cents, player_a, player_b, winner_seat, reason, ended_at, is_house_bot
     FROM games
    WHERE player_a = ANY($1) OR player_b = ANY($1)
    ORDER BY ended_at ASC`,
  [[...participants]],
);
// House-bot games NEVER score and are operator-generated — exclude them from the
// farming analysis entirely (a participant routed to the bot is being POLICED,
// not colluding). They're reported separately so house volume stays visible but
// never contaminates the human-vs-human wash-trade signals.
const botGames = allGames.filter((g) => g.is_house_bot);
const games = allGames.filter((g) => !g.is_house_bot);

interface Stat {
  games: number; // event games (both are participants)
  wins: number;
  losses: number;
  vs: Map<string, { g: number; w: number; l: number; abWon: number }>; // per-opponent
  times: number[]; // ended_at epoch ms of this player's event games
  winAbandon: number; // my wins where the OPP abandoned (resign/timeout)
}
const stat = new Map<string, Stat>();
const ensure = (w: string): Stat => {
  let s = stat.get(w);
  if (!s) { s = { games: 0, wins: 0, losses: 0, vs: new Map(), times: [], winAbandon: 0 }; stat.set(w, s); }
  return s;
};
// pair key (unordered) → counts
const pairs = new Map<string, { a: string; b: string; g: number; aw: number; bw: number; ab: number }>();

for (const g of games) {
  const a = g.player_a.toLowerCase();
  const b = g.player_b.toLowerCase();
  // EVENT game = both sides are Race participants (only these scored).
  if (!participants.has(a) || !participants.has(b)) continue;
  const winner = g.winner_seat === 0 ? a : b;
  const loser = winner === a ? b : a;
  const t = new Date(g.ended_at).getTime();
  const abandoned = ABANDON.has(g.reason);

  for (const [me, opp, iWon] of [[a, b, winner === a], [b, a, winner === b]] as const) {
    const s = ensure(me);
    s.games += 1;
    s.times.push(t);
    let v = s.vs.get(opp);
    if (!v) { v = { g: 0, w: 0, l: 0, abWon: 0 }; s.vs.set(opp, v); }
    v.g += 1;
    if (iWon) { s.wins += 1; v.w += 1; if (abandoned) { s.winAbandon += 1; v.abWon += 1; } }
    else { s.losses += 1; v.l += 1; }
  }

  const [lo, hi] = a < b ? [a, b] : [b, a];
  const pk = `${lo}|${hi}`;
  let p = pairs.get(pk);
  if (!p) { p = { a: lo, b: hi, g: 0, aw: 0, bw: 0, ab: 0 }; pairs.set(pk, p); }
  p.g += 1;
  if (winner === lo) p.aw += 1; else p.bw += 1;
  if (abandoned) p.ab += 1;
}

const gaps = (times: number[]): { min: number; median: number } => {
  if (times.length < 2) return { min: Infinity, median: Infinity };
  const ds = times.slice(1).map((t, i) => t - times[i]!).sort((x, y) => x - y);
  return { min: ds[0]!, median: ds[Math.floor(ds.length / 2)]! };
};
const nameOf = (w: string): string => board[w]?.name ?? players.get(w)?.name ?? short(w);
const ageDays = (w: string): number | null => {
  const c = players.get(w)?.created_at;
  return c ? Math.max(0, (Date.now() - new Date(c).getTime()) / 86_400_000) : null;
};

// ---- 2. leaderboard + audit table ----
console.log(`\n[race-audit] ${ranked.length} participant(s) · ${games.filter((g) => participants.has(g.player_a.toLowerCase()) && participants.has(g.player_b.toLowerCase())).length} scored event game(s)`);
if (botGames.length) {
  console.log(`  house bot: ${botGames.length} game(s) tagged is_house_bot — EXCLUDED from the farm analysis (non-scoring, operator-generated; report human-only volume to Proof of Ship).`);
}
console.log('');
console.log('  rank  pts  name                 games  W-L    opps  topOpp%  abWon%  minGap  age    wallet');
console.log('  ' + '─'.repeat(104));
ranked.forEach((r, i) => {
  const s = stat.get(r.wallet);
  const g = s?.games ?? 0;
  const topShare = s && s.vs.size ? Math.max(...[...s.vs.values()].map((v) => v.g)) / g : 0;
  const gp = gaps(s?.times ?? []);
  const age = ageDays(r.wallet);
  const flags: string[] = [];
  if (s && g >= 6 && topShare >= 0.6) flags.push('CONCENTRATED');
  if (s && s.wins >= 5 && s.winAbandon / Math.max(1, s.wins) >= 0.7) flags.push('ABANDON-FED');
  if (gp.min < 45_000 && g >= 4) flags.push('FAST');
  if (age != null && age < 2 && r.points >= 15) flags.push('NEW-ACCT');
  const row =
    `  ${String(i + 1).padStart(3)}  ${String(r.points).padStart(4)}  ${nameOf(r.wallet).slice(0, 18).padEnd(19)}` +
    ` ${String(g).padStart(5)}  ${`${s?.wins ?? 0}-${s?.losses ?? 0}`.padEnd(6)} ${String(s?.vs.size ?? 0).padStart(4)}` +
    `  ${pct(s ? Math.max(0, ...[...s.vs.values()].map((v) => v.g)) : 0, g).padStart(6)}` +
    `  ${pct(s?.winAbandon ?? 0, s?.wins ?? 0).padStart(5)}` +
    `  ${(gp.min === Infinity ? '—' : fmtGap(gp.min)).padStart(6)}` +
    `  ${age == null ? '—' : `${age.toFixed(1)}d`.padStart(5)}  ${short(r.wallet)}`;
  console.log(row + (flags.length ? `   ⚑ ${flags.join(' ')}` : ''));
});

// ---- 3. suspicious pairs ----
const suspPairs = [...pairs.values()]
  .filter((p) => p.g >= 4)
  .map((p) => ({ ...p, recip: Math.min(p.aw, p.bw) / Math.max(1, p.aw + p.bw) }))
  .sort((x, y) => y.g - x.g)
  .slice(0, 12);
if (suspPairs.length) {
  console.log('\n  SUSPICIOUS PAIRS (≥4 games between the same two participants)');
  console.log('  ' + '─'.repeat(84));
  console.log('  games   split        recip  abandon%  players');
  for (const p of suspPairs) {
    const recipFlag = p.recip >= 0.35 ? ' ⚑ RECIPROCAL' : '';
    console.log(
      `  ${String(p.g).padStart(5)}   ${`${p.aw}-${p.bw}`.padEnd(11)}  ${p.recip.toFixed(2)}   ${pct(p.ab, p.g).padStart(6)}   ${nameOf(p.a)} ↔ ${nameOf(p.b)}${recipFlag}`,
    );
  }
}

// ---- 4. spotlight ----
const targets = NAME
  ? ranked.filter((r) => nameOf(r.wallet).toLowerCase().includes(NAME))
  : ranked.slice(0, Math.min(TOP, 3));
for (const r of targets) {
  const s = stat.get(r.wallet);
  console.log(`\n  ── SPOTLIGHT: ${nameOf(r.wallet)}  (rank ${ranked.indexOf(r) + 1}, ${r.points} pts, ${short(r.wallet)}) ──`);
  const pl = players.get(r.wallet);
  const age = ageDays(r.wallet);
  console.log(`     account: elo ${pl?.elo ?? '?'} · lifetime ${pl?.wins ?? 0}W/${pl?.games_played ?? 0}G · age ${age == null ? '?' : age.toFixed(1) + 'd'}`);
  if (!s || s.games === 0) { console.log('     no event games on record.'); continue; }
  const gp = gaps(s.times);
  console.log(`     event games ${s.games} · ${s.wins}W-${s.losses}L · ${s.vs.size} distinct opponent(s) · minGap ${gp.min === Infinity ? '—' : fmtGap(gp.min)} · medianGap ${gp.median === Infinity ? '—' : fmtGap(gp.median)}`);
  const opps = [...s.vs.entries()].sort((a, b) => b[1].g - a[1].g).slice(0, 8);
  console.log('     opponent breakdown (top by games):');
  for (const [opp, v] of opps) {
    console.log(`        ${nameOf(opp).slice(0, 20).padEnd(21)} ${v.g} games  ${v.w}W-${v.l}L  (${v.abWon} win(s) by opp abandon)  ${short(opp)}`);
  }
  // Cross-check the anti-farm counters that decide what SCORED, on the days this
  // player actually played (SELECT-only reads of race:vs / race:daily).
  const days = [...new Set(s.times.map((t) => new Date(t).toISOString().slice(0, 10)))];
  let scoredTotal = 0;
  const perDay: string[] = [];
  for (const d of days) {
    const daily = Number((await q<{ value: string }>(`SELECT value FROM meta WHERE key = $1`, [`race:daily:${r.wallet}:${d}`]))[0]?.value ?? '0');
    scoredTotal += daily;
    perDay.push(`${d}:${daily}`);
  }
  console.log(`     scored-games counter (race:daily): ${scoredTotal} across ${days.length} day(s)  [${perDay.join(' ')}]`);
  console.log(`     → points ${r.points} vs ${s.wins}W event wins: ${r.points > s.wins * 3 ? '⚠ points EXCEED win×3 (check play-points / stale board)' : 'consistent with win×3 + play points'}`);
}

console.log('');
await pool.end();
process.exit(0);
