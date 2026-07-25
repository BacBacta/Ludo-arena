/**
 * READ-ONLY deep forensics on Race Week farming. SELECT only, writes nothing.
 *
 *   npm run race-forensics -w apps/server      (inside the Fly machine)
 *
 * race-audit answers "who looks suspicious". It has two blind spots that make
 * its output easy to misread, and this script exists to close them:
 *
 *  1. It never filters on stake_cents, so FREE games are counted in the same
 *     totals as staked ones. Free games score NOTHING (onResult requires
 *     stakeCents > 0) and bypass every anti-collusion gate (collusionBlock
 *     returns early on stake <= 0). Thirty free games against one friend is
 *     just play; thirty STAKED ones is a gate failure. Only the staked column
 *     is evidence of farming.
 *  2. It never looks at money. Farming the Race means extracting the faucet's
 *     cUSD, so the decisive number is per-wallet net cUSD: what the faucet paid
 *     in versus what the wallet took out of games.
 *
 * What it reports:
 *   1. Volume split — free vs staked vs house-bot, so every later number has a
 *      denominator that means something.
 *   2. Per participant — staked/free games, points, faucet in, net cUSD out,
 *      and how many wallets share their device fingerprint.
 *   3. Pairs — ranked by STAKED games, with the net cUSD flow between them
 *      (chip-dumping is one-directional) and the abandon rate.
 *   4. GATE LEAKS — pairs that played more staked games in one UTC day than
 *      MAX_DAILY_GAMES_VS_SAME allows, cross-checked against the pair_games
 *      counter the gate reads. A leak here is a server bug, not player cunning.
 *   5. Device clusters — fingerprints backing several wallets, flagging any
 *      whose wallets played each other for money (self-play).
 *
 * Heuristics explain; a human decides. Nothing here writes or accuses.
 */
import pg from 'pg';
import { MAX_DAILY_GAMES_VS_SAME } from '@ludo/shared';

const DB = process.env.DATABASE_URL?.trim();
if (!DB) {
  console.error('[race-forensics] DATABASE_URL is not set — run this inside the Fly machine.');
  process.exit(1);
}
// FULL=1 prints untruncated addresses (to copy into void-race-games).
const FULL = (process.env.FULL ?? '').trim() === '1';
const ABANDON = new Set(['timeout-forfeit', 'resign']);

const pool = new pg.Pool({ connectionString: DB });
const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> =>
  pool.query<T>(sql, params).then((r) => r.rows);

const short = (w: string): string => (FULL || !w.startsWith('0x') ? w : `${w.slice(0, 6)}…${w.slice(-4)}`);
const pct = (n: number, d: number): string => (d === 0 ? '—' : `${Math.round((100 * n) / d)}%`);
const usd = (cents: number): string => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;

// ---- participants + their device fingerprint (from the grant record) ----
const grants = await q<{ key: string; value: string }>(
  `SELECT key, value FROM meta WHERE key LIKE 'race:grant:%' AND value <> ''`,
);
interface Part {
  wallet: string;
  grantCents: number;
  at: number;
  fp: string | null;
}
const parts = new Map<string, Part>();
for (const g of grants) {
  const wallet = g.key.slice('race:grant:'.length).toLowerCase();
  try {
    const v = JSON.parse(g.value) as { cents?: number; at?: number; fp?: string | null };
    parts.set(wallet, { wallet, grantCents: Number(v.cents ?? 0) || 0, at: Number(v.at ?? 0) || 0, fp: v.fp ?? null });
  } catch {
    parts.set(wallet, { wallet, grantCents: 0, at: 0, fp: null });
  }
}
if (parts.size === 0) {
  console.log('\n[race-forensics] no race:grant:* keys — nothing to analyse.\n');
  await pool.end();
  process.exit(0);
}
const wallets = [...parts.keys()];

// ---- board, names, JIT top-ups ----
const boardRaw = (await q<{ value: string }>(`SELECT value FROM meta WHERE key = 'race:board'`))[0]?.value;
const board: Record<string, { name: string; points: number }> = boardRaw ? JSON.parse(boardRaw) : {};
const names = new Map(
  (await q<{ id: string; name: string; created_at: string }>(
    `SELECT id, name, created_at FROM players WHERE id = ANY($1)`,
    [wallets],
  )).map((p) => [p.id.toLowerCase(), p.name]),
);
const nameOf = (w: string): string => board[w]?.name ?? names.get(w) ?? short(w);
const fundedRows = await q<{ key: string; value: string }>(
  `SELECT key, value FROM meta WHERE key LIKE 'race:funded:%' AND value <> ''`,
);
const funded = new Map(fundedRows.map((r) => [r.key.slice('race:funded:'.length).toLowerCase(), Number(r.value) || 0]));
const seedRows = await q<{ key: string; value: string }>(
  `SELECT key, value FROM meta WHERE key LIKE 'race:seed:0x%' AND value <> ''`,
);
const seeded = new Map<string, number>();
for (const r of seedRows) {
  try {
    seeded.set(r.key.slice('race:seed:'.length).toLowerCase(), Number((JSON.parse(r.value) as { cents?: number }).cents ?? 0) || 0);
  } catch {
    /* ignore malformed */
  }
}

// ---- every game touching a participant ----
const rows = await q<{
  id: string; stake_cents: number; player_a: string; player_b: string; winner_seat: number;
  reason: string; payout_cents: number; ended_at: string; is_house_bot: boolean;
}>(
  `SELECT id, stake_cents, player_a, player_b, winner_seat, reason, payout_cents, ended_at, is_house_bot
     FROM games
    WHERE player_a = ANY($1) OR player_b = ANY($1)
    ORDER BY ended_at ASC`,
  [wallets],
);

interface G {
  id: string; a: string; b: string; winner: string; loser: string;
  stake: number; payout: number; abandon: boolean; day: string; bot: boolean; event: boolean;
}
const games: G[] = rows.map((r) => {
  const a = r.player_a.toLowerCase();
  const b = r.player_b.toLowerCase();
  const winner = r.winner_seat === 0 ? a : b;
  return {
    id: r.id, a, b, winner, loser: winner === a ? b : a,
    stake: r.stake_cents, payout: r.payout_cents,
    abandon: ABANDON.has(r.reason),
    day: new Date(r.ended_at).toISOString().slice(0, 10),
    bot: r.is_house_bot,
    // An EVENT game (the only kind that can score) needs both seats to be
    // participants, no house bot, and a real stake.
    event: !r.is_house_bot && r.stake_cents > 0 && parts.has(a) && parts.has(b),
  };
});

// ---- 1. volume split ----
const human = games.filter((g) => !g.bot);
const staked = human.filter((g) => g.stake > 0);
const free = human.filter((g) => g.stake === 0);
const eventGames = games.filter((g) => g.event);
console.log(`\n[race-forensics] ${parts.size} participant(s) · ${games.length} game(s) touching them`);
console.log(`  house bot ${games.length - human.length} · human ${human.length} = staked ${staked.length} + FREE ${free.length}`);
console.log(`  scoring-eligible (both participants, staked, no bot): ${eventGames.length}`);
console.log(`  ⚠ free games score NOTHING and bypass every anti-collusion gate — they are not farming evidence.`);

// ---- 2. per participant ----
interface Stat {
  ev: number; freeG: number; wins: number; abWins: number;
  stakedIn: number; won: number; opps: Set<string>;
}
const stat = new Map<string, Stat>();
const ensure = (w: string): Stat => {
  let s = stat.get(w);
  if (!s) { s = { ev: 0, freeG: 0, wins: 0, abWins: 0, stakedIn: 0, won: 0, opps: new Set() }; stat.set(w, s); }
  return s;
};
for (const g of human) {
  for (const [me, opp] of [[g.a, g.b], [g.b, g.a]] as const) {
    if (!parts.has(me)) continue;
    const s = ensure(me);
    if (g.stake === 0) { s.freeG += 1; continue; }
    if (!g.event) continue;
    s.ev += 1;
    s.opps.add(opp);
    s.stakedIn += g.stake;
    if (g.winner === me) { s.wins += 1; s.won += g.payout; if (g.abandon) s.abWins += 1; }
  }
}
// fingerprint → wallets
const byFp = new Map<string, string[]>();
for (const p of parts.values()) {
  if (!p.fp) continue;
  byFp.set(p.fp, [...(byFp.get(p.fp) ?? []), p.wallet]);
}

const ranked = [...parts.keys()].sort((a, b) => (board[b]?.points ?? 0) - (board[a]?.points ?? 0));
console.log('\n  pts  name               evGames  free  W    abWon%  faucetIn  netGame   dev  wallet');
console.log('  ' + '─'.repeat(100));
for (const w of ranked) {
  const s = stat.get(w);
  const p = parts.get(w)!;
  const faucetIn = p.grantCents + (funded.get(w) ?? 0) + (seeded.get(w) ?? 0);
  const net = (s?.won ?? 0) - (s?.stakedIn ?? 0);
  const dev = p.fp ? (byFp.get(p.fp)?.length ?? 1) : 0;
  if (!s || (s.ev === 0 && s.freeG === 0)) continue; // never played — nothing to say
  console.log(
    `  ${String(board[w]?.points ?? 0).padStart(4)}  ${nameOf(w).slice(0, 17).padEnd(18)}` +
      ` ${String(s.ev).padStart(7)} ${String(s.freeG).padStart(5)} ${String(s.wins).padStart(3)}` +
      `  ${pct(s.abWins, s.wins).padStart(6)}  ${usd(faucetIn).padStart(8)}  ${usd(net).padStart(7)}` +
      `  ${dev > 1 ? `⚑${dev}` : ' ' + String(dev)}   ${short(w)}`,
  );
}
console.log('  faucetIn = grant + JIT top-ups + gas seed. netGame = payouts won − stakes put in (staked event games).');
console.log('  dev = wallets sharing this wallet\'s device fingerprint (⚑ = more than one).');

// ---- 3. pairs, ranked by STAKED games ----
interface Pair { a: string; b: string; ev: number; freeG: number; aw: number; bw: number; ab: number; flowToA: number; days: Map<string, number> }
const pairs = new Map<string, Pair>();
for (const g of human) {
  const [lo, hi] = g.a < g.b ? [g.a, g.b] : [g.b, g.a];
  const k = `${lo}|${hi}`;
  let p = pairs.get(k);
  if (!p) { p = { a: lo, b: hi, ev: 0, freeG: 0, aw: 0, bw: 0, ab: 0, flowToA: 0, days: new Map() }; pairs.set(k, p); }
  if (g.stake === 0) { p.freeG += 1; continue; }
  if (!g.event) continue;
  p.ev += 1;
  p.days.set(g.day, (p.days.get(g.day) ?? 0) + 1);
  if (g.abandon) p.ab += 1;
  // Net cUSD moved to `lo`: winner gains payout − own stake, loser loses stake.
  if (g.winner === lo) { p.aw += 1; p.flowToA += g.payout - g.stake; } else { p.bw += 1; p.flowToA -= g.stake; }
}
const topPairs = [...pairs.values()].filter((p) => p.ev >= 3).sort((x, y) => y.ev - x.ev).slice(0, 15);
if (topPairs.length) {
  console.log('\n  PAIRS by STAKED event games (≥3)');
  console.log('  ' + '─'.repeat(96));
  console.log('  staked  free  split      abandon%  netFlow        players');
  for (const p of topPairs) {
    const dir = p.flowToA >= 0 ? `${nameOf(p.a)} +${usd(p.flowToA)}` : `${nameOf(p.b)} +${usd(-p.flowToA)}`;
    console.log(
      `  ${String(p.ev).padStart(6)} ${String(p.freeG).padStart(5)}  ${`${p.aw}-${p.bw}`.padEnd(9)} ${pct(p.ab, p.ev).padStart(7)}   ${dir.padEnd(22)} ${nameOf(p.a)} ↔ ${nameOf(p.b)}`,
    );
  }
  console.log('  netFlow = who ended up with the money. One-directional flow on many games = chip-dumping.');
}

// ---- 4. GATE LEAKS ----
// collusionBlock caps STAKED games between the same two wallets at
// MAX_DAILY_GAMES_VS_SAME per UTC day. More than that in one day means the gate
// did not run (or its counter was not bumped) — a server bug worth fixing before
// any leaderboard correction.
console.log(`\n  GATE CHECK — staked games per pair per day vs MAX_DAILY_GAMES_VS_SAME=${MAX_DAILY_GAMES_VS_SAME}`);
console.log('  ' + '─'.repeat(96));
const leaks: Array<{ p: Pair; day: string; n: number; counter: number }> = [];
for (const p of pairs.values()) {
  for (const [day, n] of p.days) {
    if (n <= MAX_DAILY_GAMES_VS_SAME) continue;
    const counter = Number(
      (await q<{ cnt: number }>(`SELECT cnt FROM pair_games WHERE day = $1::date AND player_lo = $2 AND player_hi = $3`, [day, p.a, p.b]))[0]?.cnt ?? 0,
    );
    leaks.push({ p, day, n, counter });
  }
}
if (leaks.length === 0) {
  console.log('  ✓ no pair exceeded the daily staked cap — the anti-collusion gate held.');
} else {
  console.log('  ⚠ LEAK: these pairs played more staked games in a day than the gate allows.');
  console.log('    day         games  pair_games counter  players');
  for (const l of leaks.sort((x, y) => y.n - x.n).slice(0, 20)) {
    const note = l.counter >= l.n ? 'counter OK → gate never consulted/enforced' : 'counter UNDER-COUNTS → bumpPairGame missed';
    console.log(`    ${l.day}  ${String(l.n).padStart(5)}  ${String(l.counter).padStart(18)}  ${nameOf(l.p.a)} ↔ ${nameOf(l.p.b)}  (${note})`);
  }
}

// ---- 5. device clusters ----
console.log('\n  DEVICE CLUSTERS — wallets sharing one fingerprint');
console.log('  ' + '─'.repeat(96));
const multi = [...byFp.entries()].filter(([, ws]) => ws.length > 1).sort((a, b) => b[1].length - a[1].length);
if (multi.length === 0) {
  console.log('  ✓ every participant claimed from a distinct device fingerprint.');
} else {
  console.log('  (a fingerprint is a device-MODEL cohort — identical phones collide, so this is a lead, not proof)');
  for (const [fp, ws] of multi.slice(0, 15)) {
    // Did any two wallets of this cluster play each other FOR MONEY? That is
    // self-play, and it is the part a shared cohort cannot explain away.
    const selfPlay = [...pairs.values()].filter((p) => p.ev > 0 && ws.includes(p.a) && ws.includes(p.b));
    const pts = ws.reduce((n, w) => n + (board[w]?.points ?? 0), 0);
    const drawn = ws.reduce((n, w) => n + parts.get(w)!.grantCents + (funded.get(w) ?? 0) + (seeded.get(w) ?? 0), 0);
    console.log(`  fp ${fp.slice(0, 12)}…  ${ws.length} wallet(s) · ${pts} combined pts · ${usd(drawn)} drawn from the faucet`);
    for (const w of ws) console.log(`      ${nameOf(w).slice(0, 18).padEnd(19)} ${String(board[w]?.points ?? 0).padStart(4)} pts  ${short(w)}`);
    for (const sp of selfPlay) {
      console.log(`      ⚑ SELF-PLAY: ${sp.ev} STAKED game(s) between ${nameOf(sp.a)} and ${nameOf(sp.b)} — same device`);
    }
  }
}

console.log('');
await pool.end();
process.exit(0);
