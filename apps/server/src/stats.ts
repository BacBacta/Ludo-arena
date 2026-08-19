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

/**
 * Window-wide summary — the figures MiniPay's listing review asks for that a
 * per-day series cannot give: MAU and retention are set-unions ACROSS days, so
 * they can never be derived client-side by summing `DailyStatRow`s.
 *
 * Deliberately NOT here, because this table cannot answer them honestly:
 * countries (never stored), per-stablecoin volume, network fees paid and
 * failed-tx rate (all on-chain — an indexer's job, not the game history's).
 * Reporting them from here would mean inventing numbers.
 */
export interface StatsSummary {
  /** Distinct players over the whole window (the honest MAU at days=30). */
  activePlayers: number;
  games: number;
  stakedGames: number;
  /** Total staked, in cents: both seats of every staked game. */
  stakedVolumeCents: number;
  /** Share of games against the house bot, 0..1 — context for the numbers above. */
  houseBotShare: number;
  /** Cohort retention: of the players whose FIRST game fell in the window and
   *  who had the chance to come back N days later, the share that did. Null
   *  when no cohort is old enough to have had that chance yet — an honest
   *  "not measurable" beats a 0% that reads as a collapse. */
  retention: { d1: number | null; d7: number | null; d30: number | null };
}

const DAY_MS = 86_400_000;

export function summariseStats(rows: readonly StoredGameRow[], sinceIso: string, nowMs: number): StatsSummary {
  const inWindow = rows.filter((r) => r.endedAt >= sinceIso);
  const players = new Set<string>();
  let staked = 0;
  let volume = 0;
  let botGames = 0;
  // player → { firstMs, days seen } so retention needs one pass, not a re-scan.
  const seen = new Map<string, { firstMs: number; days: Set<number> }>();

  for (const r of inWindow) {
    const at = Date.parse(r.endedAt);
    if (r.stakeCents > 0) {
      staked += 1;
      volume += r.stakeCents * 2; // both seats put the stake up
    }
    if (r.isHouseBot) botGames += 1;
    for (const raw of [r.playerA, r.playerB]) {
      const p = raw.toLowerCase();
      players.add(p);
      const hit = seen.get(p);
      const day = Math.floor(at / DAY_MS);
      if (hit) {
        hit.firstMs = Math.min(hit.firstMs, at);
        hit.days.add(day);
      } else {
        seen.set(p, { firstMs: at, days: new Set([day]) });
      }
    }
  }

  const retentionAt = (n: number): number | null => {
    // Only players whose first game is at least n days old could have returned.
    let eligible = 0;
    let returned = 0;
    for (const { firstMs, days } of seen.values()) {
      if (nowMs - firstMs < n * DAY_MS) continue;
      eligible += 1;
      const firstDay = Math.floor(firstMs / DAY_MS);
      for (const d of days) {
        if (d >= firstDay + n) {
          returned += 1;
          break;
        }
      }
    }
    return eligible === 0 ? null : returned / eligible;
  };

  return {
    activePlayers: players.size,
    games: inWindow.length,
    stakedGames: staked,
    stakedVolumeCents: volume,
    houseBotShare: inWindow.length === 0 ? 0 : botGames / inWindow.length,
    retention: { d1: retentionAt(1), d7: retentionAt(7), d30: retentionAt(30) },
  };
}

/** Clamp the ?days query param: 1..90, default 30, garbage → default. */
export function parseDaysParam(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(90, Math.max(1, Math.floor(n)));
}
