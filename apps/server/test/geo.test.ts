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

describe('isGeoBlocked (fail-closed on unknown region)', () => {
  const deny = new Set(['US', 'FR']);

  it('blocks nothing when no deny list is configured', () => {
    expect(isGeoBlocked(undefined, new Set())).toBe(false);
    expect(isGeoBlocked('US', new Set())).toBe(false);
  });

  it('blocks a country on the deny list', () => {
    expect(isGeoBlocked('US', deny)).toBe(true);
    expect(isGeoBlocked('FR', deny)).toBe(true);
  });

  it('allows a country NOT on the deny list', () => {
    expect(isGeoBlocked('NG', deny)).toBe(false);
    expect(isGeoBlocked('BR', deny)).toBe(false);
  });

  it('FAILS CLOSED: an unknown country with a deny list configured is blocked', () => {
    // this is the spoof defence — omit/forge the header ⇒ country undefined ⇒ blocked
    expect(isGeoBlocked(undefined, deny)).toBe(true);
  });
});
