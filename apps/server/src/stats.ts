/**
 * Daily activity aggregation — the read-model behind GET /stats/daily.
 *
 * "Players" is the honest DAU: distinct player ids that FINISHED at least one
 * game that UTC day, free games included — the on-chain view (Dune) can only
 * ever see staked players, so this endpoint is the one place the full number
 * exists. Aggregates only: no addresses, no balances — safe to serve publicly
 * (marketing posts, Karma profile, PoS judges, Dune CSV uploads).
 *
 * Pure over StoredGameRow so the memory store and tests share the exact logic;
 * the Postgres store mirrors it in SQL for efficiency.
 */
import type { StoredGameRow } from './store/types.js';

export interface DailyStatRow {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** Distinct player ids that finished ≥1 game this day (free included). The
   *  house bot counts as at most one of them — negligible and documented. */
  players: number;
  /** Games finished this day. */
  games: number;
  /** Of which staked (stakeCents > 0). */
  stakedGames: number;
}

export function aggregateDailyStats(rows: readonly StoredGameRow[], sinceIso: string): DailyStatRow[] {
  const byDay = new Map<string, { players: Set<string>; games: number; staked: number }>();
  for (const r of rows) {
    if (r.endedAt < sinceIso) continue;
    const day = r.endedAt.slice(0, 10);
    let d = byDay.get(day);
    if (!d) {
      d = { players: new Set(), games: 0, staked: 0 };
      byDay.set(day, d);
    }
    d.games += 1;
    if (r.stakeCents > 0) d.staked += 1;
    d.players.add(r.playerA.toLowerCase());
    d.players.add(r.playerB.toLowerCase());
  }
  return [...byDay.entries()]
    .map(([day, d]) => ({ day, players: d.players.size, games: d.games, stakedGames: d.staked }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Clamp the ?days query param: 1..90, default 30, garbage → default. */
export function parseDaysParam(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(90, Math.max(1, Math.floor(n)));
}
