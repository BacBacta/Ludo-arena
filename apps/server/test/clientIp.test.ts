import { describe, expect, it } from 'vitest';
import { clientIpOf, sameNetwork, UNKNOWN_IP } from '../src/clientIp.js';

// THE BUG. The server sits behind Fly's `[http_service]` proxy, which terminates
// the connection and dials the app over the private network. `req.socket
// .remoteAddress` is therefore the PROXY's address — the same value for every
// player on Earth. Every same-IP comparison in the codebase was consequently
// always true: raceCollusionSuspect flagged EVERY Race pairing as wash-trading
// and handed the seeker to the house bot, so two real players could never meet.
//
// The real address is in Fly-Client-IP, which the code never read.

const PROXY = 'fdaa:38:146a:a7b:443:ba2f:47c4:2'; // what remoteAddress actually is
const SECRET = 'edge-secret';

describe('clientIpOf — the real player address', () => {
  it("prefers Fly's header over the proxy socket address (THE BUG)", () => {
    expect(clientIpOf({ 'fly-client-ip': '41.203.10.7' }, PROXY, '')).toBe('41.203.10.7');
  });

  it('falls back to the socket address when no proxy header is present (local/dev)', () => {
    expect(clientIpOf({}, '203.0.113.9', '')).toBe('203.0.113.9');
  });

  it('reports unknown when there is nothing to go on', () => {
    expect(clientIpOf({}, undefined, '')).toBe(UNKNOWN_IP);
    expect(clientIpOf({}, '   ', '')).toBe(UNKNOWN_IP);
    expect(clientIpOf({ 'fly-client-ip': '  ' }, undefined, '')).toBe(UNKNOWN_IP);
  });
});

describe('clientIpOf — X-Forwarded-For is only believed from an authenticated edge', () => {
  it('IGNORES a client-supplied XFF when a secret is configured but absent/wrong', () => {
    const spoof = { 'x-forwarded-for': '1.2.3.4' };
    expect(clientIpOf(spoof, PROXY, SECRET)).toBe(PROXY);
    expect(clientIpOf({ ...spoof, 'x-edge-secret': 'wrong' }, PROXY, SECRET)).toBe(PROXY);
  });

  it('accepts it once the edge authenticates', () => {
    expect(clientIpOf({ 'x-forwarded-for': '1.2.3.4', 'x-edge-secret': SECRET }, PROXY, SECRET)).toBe('1.2.3.4');
  });

  it('takes the FIRST hop of the chain — the original client', () => {
    const h = { 'x-forwarded-for': '41.203.10.7, 10.0.0.1, 10.0.0.2', 'x-edge-secret': SECRET };
    expect(clientIpOf(h, PROXY, SECRET)).toBe('41.203.10.7');
  });

  it('x-real-ip is the fallback for edges that send only that', () => {
    expect(clientIpOf({ 'x-real-ip': '41.203.10.7', 'x-edge-secret': SECRET }, PROXY, SECRET)).toBe('41.203.10.7');
  });

  it("Fly's header wins even over an authenticated edge — the platform sets it last", () => {
    const h = { 'fly-client-ip': '41.203.10.7', 'x-forwarded-for': '1.2.3.4', 'x-edge-secret': SECRET };
    expect(clientIpOf(h, PROXY, SECRET)).toBe('41.203.10.7');
  });

  it('with NO secret configured (dev), an unauthenticated XFF is still not believed', () => {
    // Spoofable input must never silently become an anti-farm signal; without a
    // configured edge we fall back to the socket, which at least is not forgeable.
    expect(clientIpOf({ 'x-forwarded-for': '1.2.3.4' }, PROXY, '')).toBe(PROXY);
  });
});

describe('sameNetwork — what may count as one network', () => {
  it('two identical real addresses match', () => {
    expect(sameNetwork('41.203.10.7', '41.203.10.7')).toBe(true);
  });

  it('different addresses do not', () => {
    expect(sameNetwork('41.203.10.7', '41.203.10.8')).toBe(false);
  });

  it('UNKNOWN never matches — not even another UNKNOWN', () => {
    // Two players the server cannot place are not evidence of anything. Treating
    // them as same-network is exactly what routed every pairing to the bot.
    expect(sameNetwork(UNKNOWN_IP, UNKNOWN_IP)).toBe(false);
    expect(sameNetwork(UNKNOWN_IP, '41.203.10.7')).toBe(false);
    expect(sameNetwork('41.203.10.7', UNKNOWN_IP)).toBe(false);
  });

  it('a missing address never matches', () => {
    expect(sameNetwork(undefined, undefined)).toBe(false);
    expect(sameNetwork(undefined, '41.203.10.7')).toBe(false);
    expect(sameNetwork('', '')).toBe(false);
  });
});

// The whole point, end to end: two players behind the Fly proxy used to look
// identical and now do not.
describe('the regression this closes', () => {
  it('two DIFFERENT players are no longer seen as the same network', () => {
    const alice = clientIpOf({ 'fly-client-ip': '41.203.10.7' }, PROXY, '');
    const bob = clientIpOf({ 'fly-client-ip': '102.16.4.90' }, PROXY, '');
    expect(sameNetwork(alice, bob)).toBe(false);
    // Before the fix both resolved to the proxy address and collided:
    expect(sameNetwork(PROXY, PROXY)).toBe(true);
  });

  it('two players genuinely on one WiFi are still detected', () => {
    const a = clientIpOf({ 'fly-client-ip': '41.203.10.7' }, PROXY, '');
    const b = clientIpOf({ 'fly-client-ip': '41.203.10.7' }, PROXY, '');
    expect(sameNetwork(a, b)).toBe(true);
  });
});
