import { describe, expect, it } from 'vitest';
import { baseFloorInFeeCurrency, feeCapWei } from '../src/lib/escrow';

// Staking failed with "the fee cap (maxFeePerGas gwei) cannot be lower than the
// block base fee" even after raising the chain baseFeeMultiplier — viem's
// estimate for a feeCurrency (CIP-64) tx is unreliable under a base-fee spike.
// The definitive fix sets maxFeePerGas EXPLICITLY from the fresh NATIVE base fee:
// baseFee×mult + priority, which is >= baseFee by construction. This differs from
// the token-gas-price cap escrow.ts warns about (that lands BELOW the native base
// fee); this is derived from the native base fee itself, so it always clears.

describe('feeCapWei (explicit feeCurrency maxFeePerGas)', () => {
  const gwei = 1_000_000_000n;

  it('is strictly ABOVE the base fee (clears the node check)', () => {
    const baseFee = 25n * gwei;
    const cap = feeCapWei(baseFee, 2n, 2n * gwei);
    expect(cap).toBeGreaterThan(baseFee);
  });

  it('is baseFee×multiplier + priority', () => {
    expect(feeCapWei(10n * gwei, 3n, 2n * gwei)).toBe(32n * gwei); // 10*3 + 2
  });

  it('still clears even when the base fee spikes hard (margin scales with it)', () => {
    const spiked = 200n * gwei;
    expect(feeCapWei(spiked, 2n, 2n * gwei)).toBeGreaterThan(spiked);
  });

  it('a zero base fee (some testnets) still yields a positive cap from priority', () => {
    expect(feeCapWei(0n, 2n, 2n * gwei)).toBe(2n * gwei);
  });
});

// The CIP-64 cap must clear the base fee CONVERTED into the fee currency. The
// node's `eth_gasPrice([token])` returns the INVERSE direction, which under-caps
// ~N² when CELO ≠ 1 cUSD — every burner lock was rejected during a base-fee
// regime. baseFloorInFeeCurrency takes the MAX of both directions so the cap
// clears whichever way the directory rate is oriented.
describe('baseFloorInFeeCurrency (CIP-64 fee-cap base, both rate directions)', () => {
  const gwei = 1_000_000_000n;
  // Live mainnet values probed 2026-07-24: base 200 gwei, rate num/den = 70178e18/1e24.
  const base = 200n * gwei;
  const num = 70_178_000_000_000_000_000_000n;
  const den = 1_000_000_000_000_000_000_000_000n;

  it('returns the LARGER conversion (den/num here), not the node under-quote', () => {
    const floor = baseFloorInFeeCurrency(base, num, den);
    const inverse = (base * num) / den; // ~14 gwei — the eth_gasPrice([token]) direction
    const correct = (base * den) / num; // ~2850 gwei — the validated floor
    expect(floor).toBe(correct);
    expect(floor).toBeGreaterThan(inverse);
    // A BALANCED ×2 cap off this floor clears the ~2850 gwei node check…
    expect(feeCapWei(floor, 2n, 2n * gwei)).toBeGreaterThan(correct);
    // …whereas the old token-quote path (×4 of the inverse) does NOT.
    expect(feeCapWei(inverse, 4n, 2n * gwei)).toBeLessThan(correct);
  });

  it('is orientation-agnostic: same floor if the rate is given inverted', () => {
    expect(baseFloorInFeeCurrency(base, den, num)).toBe(baseFloorInFeeCurrency(base, num, den));
  });

  it('degrades to the native base fee on a degenerate/zero rate', () => {
    expect(baseFloorInFeeCurrency(base, 0n, den)).toBe(base);
    expect(baseFloorInFeeCurrency(0n, num, den)).toBe(0n);
  });
});
