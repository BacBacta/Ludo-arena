/**
 * The player's real IP address. Pure so the proxy-trust rules are unit-tested;
 * index.ts wraps this with the socket address.
 *
 * WHY THIS EXISTS. The server runs behind Fly's `[http_service]` proxy, which
 * terminates the connection and dials the app over the private network. So
 * `req.socket.remoteAddress` is the PROXY's address — the same value for every
 * player on Earth. Every IP comparison in the codebase was therefore always
 * true: `raceCollusionSuspect` flagged EVERY Race pairing as wash-trading and
 * handed the seeker to the house bot, so two real players could never meet. It
 * also made the anti-farm signal useless in the other direction — an identical
 * address distinguishes nobody.
 *
 * Fly sets `Fly-Client-IP` at its own edge and overwrites any client-supplied
 * value, so it is authoritative and NOT forgeable from the browser.
 * `X-Forwarded-For` is only believed when a trusted edge authenticates itself
 * with the shared `x-edge-secret` (the same rule geo.ts uses): a client can
 * append to that header freely, and a spoofable IP would let a farmer dodge the
 * same-network checks by inventing one.
 */

export const UNKNOWN_IP = 'unknown';

/** First hop of an X-Forwarded-For chain — the original client, per RFC 7239. */
function firstHop(xff: string): string | undefined {
  const first = xff.split(',')[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

export function clientIpOf(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string | undefined,
  trustedEdgeSecret: string,
): string {
  // Fly's own header: set by the platform edge, overwritten on every request.
  const fly = headers['fly-client-ip'];
  if (typeof fly === 'string' && fly.trim().length > 0) return fly.trim();

  // Any other proxy must authenticate before its header is believed.
  if (trustedEdgeSecret && headers['x-edge-secret'] === trustedEdgeSecret) {
    const xff = headers['x-forwarded-for'];
    const hop = typeof xff === 'string' ? firstHop(xff) : undefined;
    if (hop) return hop;
    const real = headers['x-real-ip'];
    if (typeof real === 'string' && real.trim().length > 0) return real.trim();
  }

  const sock = socketAddress?.trim();
  return sock && sock.length > 0 ? sock : UNKNOWN_IP;
}

/**
 * Do these two addresses identify the same network for anti-farm purposes?
 *
 * `unknown` NEVER matches — including against another `unknown`. Two players the
 * server cannot place are not evidence of anything, and treating them as
 * same-network is precisely the failure that routed every pairing to the bot.
 */
export function sameNetwork(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === UNKNOWN_IP || b === UNKNOWN_IP) return false;
  return a === b;
}
