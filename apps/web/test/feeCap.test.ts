import { describe, expect, it } from 'vitest';
import { feeCapWei } from '../src/lib/escrow';

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
