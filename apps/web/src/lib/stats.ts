/**
 * Public activity stats — the read-only figures behind the lobby's Stats sheet.
 *
 * MiniPay's listing review asks for reachable, fresh usage numbers (DAU, MAU,
 * retention, activity). The server already aggregates them at GET /stats/daily;
 * this is the client half. Aggregates only — no addresses, no balances — so the
 * sheet needs no wallet and is safe to show to anyone.
 *
 * Everything else in the app talks WebSocket, so the ws:// server URL has to be
 * mapped to its http(s) origin here; `statsUrl` is split out precisely so that
 * mapping is unit-testable rather than inlined in a component.
 */

export interface StatsSummary {
  activePlayers: number;
  games: number;
  stakedGames: number;
  stakedVolumeCents: number;
  houseBotShare: number;
  /** Null means "not measurable yet" — no cohort is old enough. Never render it
   *  as 0%: that reads as a collapse when it is an absence of data. */
  retention: { d1: number | null; d7: number | null; d30: number | null };
}

export interface StatsDay {
  day: string;
  players: number;
  games: number;
  stakedGames: number;
}

export interface StatsPayload {
  days: number;
  generatedAt: string;
  summary: StatsSummary;
  daily: StatsDay[];
}

/** ws://host → http://host/stats/daily?days=N (wss → https). */
export function statsUrl(serverUrl: string, days = 30): string {
  const origin = serverUrl.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/+$/, '');
  return `${origin}/stats/daily?days=${days}`;
}

/** Fetch the public stats, or null when the server is unreachable or answers
 *  something unusable — the sheet then shows its "unavailable" state instead of
 *  half-rendering a broken payload. */
export async function fetchStats(serverUrl: string, days = 30, signal?: AbortSignal): Promise<StatsPayload | null> {
  try {
    const res = await fetch(statsUrl(serverUrl, days), { signal });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<StatsPayload>;
    if (!data || typeof data !== 'object' || !data.summary || !Array.isArray(data.daily)) return null;
    return data as StatsPayload;
  } catch {
    return null;
  }
}

/** Cents → a compact money label ("$12.34", "$1.2k" past a thousand dollars). */
export function fmtVolume(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(1)}k`;
  return `$${dollars.toFixed(2)}`;
}

/** A 0..1 ratio as a percentage, or '—' when the figure is not measurable. */
export function fmtRatio(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}
