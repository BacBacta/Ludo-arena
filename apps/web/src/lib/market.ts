/**
 * Build-time MARKET mode — which commercial/legal shape this deployment ships.
 *
 * `VITE_MARKET=cm` produces the CAMEROON build: real-money staking is removed
 * from the product entirely (no stake tiers, no Race entry, no staked 4p or
 * staked challenges) and French is the default language. The economy there is
 * free play + tickets/freerolls + cosmetics; see docs/BACKLOG.md (market CM).
 *
 * WHY CLIENT-SIDE AND BUILD-TIME, not a server geo-gate: the server's geo
 * allowlist (STAKING_ALLOWED_COUNTRIES, R-COMP-1) is fail-closed on an
 * UNVERIFIED region, and with no trusted edge in front of the Fly WebSocket
 * every player's region is unverifiable — arming it blocks staked play for
 * 100% of players (see .github/workflows/fly-ops.yml, unset-staking-allowed-
 * countries). Until a trusted edge exists, the enforceable statement is "the
 * product marketed in Cameroon does not offer staking", which is exactly what
 * a dedicated domain built with VITE_MARKET=cm provides. The server-side
 * allowlist remains the hard gate to arm once an edge is wired.
 *
 * The default (unset/unknown VITE_MARKET) is the current global product —
 * a missing env var must never strip features from the main deployment.
 */
export type MarketKey = 'global' | 'cm';

export interface Market {
  readonly key: MarketKey;
  /** Real-money staking offered anywhere in the UI. */
  readonly staking: boolean;
  /** Locale when the player has not chosen one (?lang= / stored choice win). */
  readonly defaultLang: 'en' | 'fr';
}

const MARKETS: Record<MarketKey, Market> = {
  global: { key: 'global', staking: true, defaultLang: 'en' },
  cm: { key: 'cm', staking: false, defaultLang: 'fr' },
};

/** Pure resolver (unit-tested): unknown/empty input falls back to global. */
export function resolveMarket(raw: string | undefined): Market {
  const key = raw?.trim().toLowerCase() as MarketKey | undefined;
  return (key && MARKETS[key]) || MARKETS.global;
}

// import.meta.env is undefined outside Vite (e.g. node test runners) — same
// guard as chains.ts.
export const MARKET: Market = resolveMarket(import.meta.env?.VITE_MARKET as string | undefined);
