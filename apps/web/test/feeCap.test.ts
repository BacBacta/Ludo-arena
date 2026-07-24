import { describe, expect, it } from 'vitest';
import { baseFloorInFeeCurrency, calibratedBaseFloor, feeCapWei } from '../src/lib/escrow';

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

// The entry-mint blocker (campaign incident): the MAX of both rate directions is
// safe for a rich wallet (EIP-1559 refunds — the tx pays base+tip, never the cap)
// but the node RESERVES gasLimit x maxFeePerGas up front. On mainnet the wrong
// orientation is ~215x the right one, so a Race Pass mint reserved ~150c against
// a 10c gas seed and every new player was refused "insufficient funds" — while the
// real fee stayed under 1c. eth_gasPrice([token]) is the node's own quote, so it
// disambiguates the orientation.
describe('calibratedBaseFloor (node-quote-disambiguated CIP-64 floor)', () => {
  // Measured on Celo mainnet: base 200 gwei, cUSD rate num/den = 0.068247…
  const GWEI = 1_000_000_000n;
  const right = 13_649_464_000n; // (base * num) / den — matches the node
  const wrong = 2_930_518_004_223n; // (base * den) / num — 215x too high
  const nodeQuote = 13_820_082_300n; // eth_gasPrice([cUSD])

  it('picks the direction the NODE agrees with, not the larger one', () => {
    expect(calibratedBaseFloor(right, wrong, nodeQuote)).toBe(nodeQuote);
    // …and the same holds when the orientation is flipped (other tokens).
    expect(calibratedBaseFloor(wrong, right, nodeQuote)).toBe(nodeQuote);
  });

  it('never caps BELOW the node quote (that is the "cap < base fee" reject)', () => {
    const under = 5n * GWEI; // a direction cheaper than what the node charges
    expect(calibratedBaseFloor(under, wrong, nodeQuote)).toBe(nodeQuote);
  });

  it('keeps the conservative MAX when the node cannot quote the token', () => {
    expect(calibratedBaseFloor(right, wrong, null)).toBe(wrong);
    expect(calibratedBaseFloor(right, wrong, 0n)).toBe(wrong);
  });

  it('the calibrated floor keeps a mint affordable on a 10c seed', () => {
    // BALANCED: cap = floor*2 + 2 gwei, gasLimit = 120k*1.3 + 100k = 256k.
    const cap = calibratedBaseFloor(right, wrong, nodeQuote) * 2n + 2n * GWEI;
    const reservationWei = cap * 256_000n;
    const cents = Number((reservationWei * 100_000n) / 10n ** 18n) / 1000;
    expect(cents).toBeLessThan(2); // was ~150c with the MAX — above the 10c seed
  });
});
