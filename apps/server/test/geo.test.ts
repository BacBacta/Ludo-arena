import { describe, expect, it } from 'vitest';
import { countryOf, isGeoBlocked } from '../src/geo.js';

// G-6: geo-gating must not be bypassable by spoofing the country header. The Fly
// server is directly reachable, so cf-ipcountry is only trusted when the edge
// authenticates itself; and a configured deny list fails CLOSED on an unknown region.

const SECRET = 'edge-shared-secret';

describe('countryOf (trusted-edge authentication)', () => {
  it('reads the edge country header when no secret is configured (dev/testnet)', () => {
    expect(countryOf({ 'cf-ipcountry': 'FR' }, '')).toBe('FR');
    expect(countryOf({ 'x-vercel-ip-country': 'us' }, '')).toBe('US'); // uppercased
    expect(countryOf({ 'x-country': 'DE' }, '')).toBe('DE');
  });

  it('IGNORES the country header when a secret is set but not presented (spoof)', () => {
    // an attacker hitting the Fly server directly sets cf-ipcountry but cannot forge the secret
    expect(countryOf({ 'cf-ipcountry': 'US' }, SECRET)).toBeUndefined();
    expect(countryOf({ 'cf-ipcountry': 'US', 'x-edge-secret': 'wrong' }, SECRET)).toBeUndefined();
  });

  it('trusts the country header only when the edge secret matches', () => {
    expect(countryOf({ 'cf-ipcountry': 'NG', 'x-edge-secret': SECRET }, SECRET)).toBe('NG');
  });

  it('returns undefined for a malformed country value', () => {
    expect(countryOf({ 'cf-ipcountry': 'FRANCE' }, '')).toBeUndefined();
    expect(countryOf({}, '')).toBeUndefined();
  });
});

describe('isGeoBlocked (allowlist, fail-closed on unknown region)', () => {
  const allowed = new Set(['KE', 'GH']);

  it('blocks nothing when the allowlist is NOT CONFIGURED (dev/testnet, null)', () => {
    expect(isGeoBlocked(undefined, null)).toBe(false);
    expect(isGeoBlocked('US', null)).toBe(false);
  });

  it('allows a country ON the allowlist', () => {
    expect(isGeoBlocked('KE', allowed)).toBe(false);
    expect(isGeoBlocked('GH', allowed)).toBe(false);
  });

  it('blocks every country NOT on the allowlist (legal-by-exception posture)', () => {
    expect(isGeoBlocked('US', allowed)).toBe(true);
    expect(isGeoBlocked('FR', allowed)).toBe(true);
  });

  it('an EMPTY (but configured) allowlist blocks staking everywhere — the safe prod default', () => {
    expect(isGeoBlocked('KE', new Set())).toBe(true);
    expect(isGeoBlocked(undefined, new Set())).toBe(true);
  });

  it('FAILS CLOSED: an unknown country with an allowlist configured is blocked', () => {
    // this is the spoof defence — omit/forge the header ⇒ country undefined ⇒ blocked
    expect(isGeoBlocked(undefined, allowed)).toBe(true);
  });
});
