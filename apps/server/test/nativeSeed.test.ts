import { describe, expect, it, vi } from 'vitest';
import { nativeDrawWei, nativeSeedDeficitWei, nativeSeedGrantWei, parseCeloEnvWei, SEED_FP_LIFETIME_MULT, SEED_LIFETIME_MULT } from '../src/race.js';

// THE FEATURE. External wallets (MetaMask/WalletConnect) cannot sign CIP-64,
// so the cUSD gas seed is useless to them: their gas is native CELO or
// nothing. "The platform sponsors the mint" = a second faucet dimension in
// WEI, with the same shape as the cUSD seed — deficit-aware, wallet- and
// device-capped, pool-capped — but its own counters, because adding wei to
// cents would be nonsense either way it happened.

const TARGET = 2_000_000_000_000_000n; // 0.002 CELO
const POOL = 500_000_000_000_000_000n; // 0.5 CELO

describe('nativeSeedDeficitWei — what the wallet HOLDS drives the grant', () => {
  it('an empty wallet is missing the whole target', () => {
    expect(nativeSeedDeficitWei(TARGET, 0n)).toBe(TARGET);
  });

  it('a partially-drained wallet is missing only its deficit', () => {
    expect(nativeSeedDeficitWei(TARGET, TARGET / 2n)).toBe(TARGET / 2n);
  });

  it('a wallet at (or above) the target is missing nothing', () => {
    expect(nativeSeedDeficitWei(TARGET, TARGET)).toBe(0n);
    expect(nativeSeedDeficitWei(TARGET, TARGET * 10n)).toBe(0n);
  });
});

describe('nativeSeedGrantWei — three independent bounds', () => {
  it('grants the full deficit when every bound has room', () => {
    expect(nativeSeedGrantWei(TARGET, 0n, TARGET * 3n, 0n, POOL)).toBe(TARGET);
  });

  it('a wallet at its lifetime cap draws nothing (drain-and-reclaim bound)', () => {
    expect(nativeSeedGrantWei(TARGET, TARGET * 3n, TARGET * 3n, 0n, POOL)).toBe(0n);
  });

  it('a wallet NEAR its cap draws only the remainder', () => {
    const granted = TARGET * 3n - 1000n;
    expect(nativeSeedGrantWei(TARGET, granted, TARGET * 3n, 0n, POOL)).toBe(1000n);
  });

  it('a dry pool grants nothing, a nearly-dry pool grants the remainder', () => {
    expect(nativeSeedGrantWei(TARGET, 0n, TARGET * 3n, POOL, POOL)).toBe(0n);
    expect(nativeSeedGrantWei(TARGET, 0n, TARGET * 3n, POOL - 7n, POOL)).toBe(7n);
  });

  it('no deficit → no grant, whatever the other bounds say', () => {
    expect(nativeSeedGrantWei(0n, 0n, TARGET * 3n, 0n, POOL)).toBe(0n);
  });
});

describe('nativeDrawWei — the stored counters', () => {
  it('parses the JSON rows this server writes', () => {
    expect(nativeDrawWei(JSON.stringify({ wei: '12345', at: 1, fp: null }))).toBe(12345n);
  });

  it('parses the bare-digit spent counter', () => {
    expect(nativeDrawWei('500000000000000000')).toBe(500_000_000_000_000_000n);
  });

  it('missing / tombstoned rows are 0 (a rolled-back grant re-opens)', () => {
    expect(nativeDrawWei(null)).toBe(0n);
    expect(nativeDrawWei('')).toBe(0n);
  });

  it('survives wei beyond Number precision without rounding', () => {
    const big = (2n ** 60n).toString(); // > Number.MAX_SAFE_INTEGER
    expect(nativeDrawWei(JSON.stringify({ wei: big }))).toBe(2n ** 60n);
  });

  it('a malformed row is 0, never a throw (fund path must not crash)', () => {
    expect(nativeDrawWei('{not json')).toBe(0n);
    expect(nativeDrawWei(JSON.stringify({ wei: -5 }))).toBe(0n);
    expect(nativeDrawWei(JSON.stringify({ wei: '1.5' }))).toBe(0n);
  });
});

describe('parseCeloEnvWei — the policy.ts NaN hazard, in wei', () => {
  const quiet = (): void => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  };

  it('parses decimal CELO amounts exactly', () => {
    expect(parseCeloEnvWei('0.002', 0n)).toBe(2_000_000_000_000_000n);
    expect(parseCeloEnvWei('1', 0n)).toBe(10n ** 18n);
    expect(parseCeloEnvWei('0.5', 0n)).toBe(500_000_000_000_000_000n);
  });

  it('falls back when absent or blank', () => {
    expect(parseCeloEnvWei(undefined, 42n)).toBe(42n);
    expect(parseCeloEnvWei('  ', 42n)).toBe(42n);
  });

  it('falls back on garbage — a typo must not zero (or explode) the sponsorship', () => {
    quiet();
    expect(parseCeloEnvWei('abc', 42n)).toBe(42n);
    expect(parseCeloEnvWei('1e18', 42n)).toBe(42n);
    expect(parseCeloEnvWei('-1', 42n)).toBe(42n);
  });

  it('explicit 0 IS honoured — that is the documented off switch', () => {
    expect(parseCeloEnvWei('0', 42n)).toBe(0n);
  });
});

describe('the allowance multipliers are shared with the cUSD seed', () => {
  // The native path deliberately reuses SEED_LIFETIME_MULT / SEED_FP_LIFETIME_MULT:
  // one wallet ×3, one device-model cohort ×30 — the same anti-farm reasoning,
  // whatever token the gas is in. If these ever diverge it should be a decision,
  // not an accident: this test is the tripwire.
  it('wallet ×3, device ×30 (defaults)', () => {
    expect(SEED_LIFETIME_MULT).toBeGreaterThanOrEqual(1);
    expect(SEED_FP_LIFETIME_MULT).toBeGreaterThanOrEqual(SEED_LIFETIME_MULT);
  });

  it('the wei caps scale from the target by those multipliers', () => {
    const cap = TARGET * BigInt(SEED_LIFETIME_MULT);
    const fpCap = TARGET * BigInt(SEED_FP_LIFETIME_MULT);
    // A wallet that drew its cap is refused; a cohort that drew its cap is refused.
    expect(nativeSeedGrantWei(TARGET, cap, cap, 0n, POOL)).toBe(0n);
    expect(fpCap >= cap).toBe(true);
  });
});
