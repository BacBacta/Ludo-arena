import { describe, expect, it } from 'vitest';
import { calibratedBaseFloor, feeCurrencyDirections, feeReservationWei, nativeGatedCapFloor } from '../src/cip64';

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

// The 2026-07-25 incident: the pre-broadcast fee-cap check compares the cap
// NUMBER against the NATIVE base fee number — no denomination conversion. The
// house bot's 6x rung (82.56 gwei cUSD, economically ~1217 gwei native) was
// rejected as "lower than the block base fee" under a 200 gwei native base and
// passed only at 275 gwei; the web ladder's 10x ceiling (137 gwei) could never
// clear it at all. The cap floor must therefore be raised to the native number.
describe('nativeGatedCapFloor (the cap must clear the NATIVE base fee number)', () => {
  const GWEI = 1_000_000_000n;

  it('raises a token floor that sits below the native base fee', () => {
    // Measured: calibrated cUSD floor 13.76 gwei, native base 200 gwei.
    expect(nativeGatedCapFloor(13_760_000_000n, 200n * GWEI)).toBe(200n * GWEI);
  });

  it('leaves a token floor already above the native number untouched (the 215x direction)', () => {
    expect(nativeGatedCapFloor(2_930n * GWEI, 200n * GWEI)).toBe(2_930n * GWEI);
  });

  it('pins the measured rejects and passes: 6x fails the gate, 20x clears it', () => {
    const calibrated = 13_760_000_000n; // the floor both ladders multiplied
    const gated = nativeGatedCapFloor(calibrated, 200n * GWEI);
    expect(6n * calibrated).toBeLessThan(gated); // 82.56 gwei — the rejected rung
    expect(20n * calibrated).toBeGreaterThan(gated); // 275 gwei — the rung that mined
    expect(6n * gated).toBeGreaterThanOrEqual(200n * GWEI); // gated, rung 1 clears
  });

  it('is the identity when the native base fee is unavailable (0)', () => {
    expect(nativeGatedCapFloor(13_760_000_000n, 0n)).toBe(13_760_000_000n);
  });
});
