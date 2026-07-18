/**
 * Geo-gating for staked play (E5.4 / G-6). Pure so the edge-trust and fail-closed
 * rules are unit-tested; index.ts wraps these with the configured secret + list.
 */

/**
 * The player's country from the edge-set header, or undefined if it cannot be
 * TRUSTED. The Fly server is directly reachable over WebSocket, so cf-ipcountry &
 * friends are client-forgeable unless a trusted edge (Cloudflare/Vercel/Fly proxy)
 * authenticates itself with the shared `x-edge-secret`. When a secret is
 * configured, a request without the matching secret yields undefined (the header
 * is not believed). When no secret is configured (dev/testnet), the raw header is
 * used as-is — spoofable, which the server warns about at boot.
 */
export function countryOf(
  headers: Record<string, string | string[] | undefined>,
  trustedEdgeSecret: string,
): string | undefined {
  if (trustedEdgeSecret && headers['x-edge-secret'] !== trustedEdgeSecret) return undefined;
  const c = headers['cf-ipcountry'] ?? headers['x-vercel-ip-country'] ?? headers['x-country'];
  return typeof c === 'string' && c.length === 2 ? c.toUpperCase() : undefined;
}

/**
 * Is staked play geo-blocked for this country? ALLOWLIST semantics (R-COMP-1):
 * staked play is legal-by-exception, so the configured list names the countries
 * where a legal review CLEARED it — everywhere else is blocked. The old deny-list
 * shipped an empty default that allowed staking worldwide until someone remembered
 * to block a country; a wagering product must carry the opposite posture.
 *
 * - `allowed === null` — not configured (dev/testnet): nothing is blocked, and
 *   index.ts warns loudly at boot.
 * - `allowed` is a set (even empty): only listed countries may stake, and an
 *   unknown country (no authenticated edge / spoofed / absent header) FAILS
 *   CLOSED — a legal restriction must not be bypassable by omitting the header.
 */
export function isGeoBlocked(country: string | undefined, allowed: ReadonlySet<string> | null): boolean {
  if (allowed === null) return false;
  if (country === undefined) return true;
  return !allowed.has(country);
}
