import { describe, expect, it } from 'vitest';
import { calibratedBaseFloor, feeCurrencyDirections, feeReservationWei } from '../src/cip64';

// ONE source of truth for the CIP-64 cap arithmetic (client + house bot). The
// copies used to live in apps/web and apps/server and DRIFTED — a fix to the
// bot's copy broke every new player's Race Pass mint in production.
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

describe('feeCurrencyDirections', () => {
  it('returns both conversion directions of the directory rate', () => {
    // Measured mainnet cUSD rate at a 200 gwei native base fee.
    const [a, b] = feeCurrencyDirections(200_000_000_000n, 68_247_320_000_000_000_000_000n, 1_000_000_000_000_000_000_000_000n);
    expect(a).toBe(13_649_464_000n);
    expect(b).toBe(2_930_518_004_223n);
  });
  it('degenerate rates fall back to the native number (never zero)', () => {
    expect(feeCurrencyDirections(200n, 0n, 5n)).toEqual([200n, 200n]);
    expect(feeCurrencyDirections(0n, 1n, 5n)).toEqual([0n, 0n]);
  });
});

describe('feeReservationWei (what the node holds, not what the tx pays)', () => {
  it('is gasLimit x cap — the quantity a thin burner must be able to cover', () => {
    expect(feeReservationWei(256_000n, 29_000_000_000n)).toBe(7_424_000_000_000_000n);
  });
});
