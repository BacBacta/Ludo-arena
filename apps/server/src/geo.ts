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
 * Is staked play geo-blocked for this country? FAILS CLOSED: when a deny list is
 * configured but the country is unknown (no authenticated edge / spoofed / absent
 * header), staked play is refused — we cannot prove the player is outside a blocked
 * region, and a legal restriction must not be bypassable by omitting the header.
 * With no deny list configured, nothing is blocked.
 */
export function isGeoBlocked(country: string | undefined, blocked: ReadonlySet<string>): boolean {
  if (blocked.size === 0) return false;
  if (country === undefined) return true;
  return blocked.has(country);
}
