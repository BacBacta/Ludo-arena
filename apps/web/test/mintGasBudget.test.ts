import { describe, expect, it } from 'vitest';
import { affordableCapWei, budgetedCapWei, calibratedBaseFloor, feeCurrencyDirections, feeReservationWei } from '@ludo/shared';
import { BALANCED, HIGH_CAP, THRIFTY, GAS_BUDGET_SENTINEL, InsufficientGasBudgetError, feeWeiToCents, planCapWei, planGasLimit } from '../src/lib/feePlan';

// THE BUG. The Race Pass mint is the FIRST tx a new player sends, from the
// THINNEST wallet in the app: a burner holding a 10c gas seed. Its fee cap is
// built from a fee-floor read with two silent degradation paths, and the mint
// was the one burner tx with NO adaptive ladder — so each degradation produced a
// reservation the seed could never cover, the tx died on funds, and the player
// got "your entry is still being funded — give it a moment and tap again".
// Deterministic, therefore permanent.
//
// These numbers are the MEASURED Celo mainnet values (2026-07-24).

const GWEI = 1_000_000_000n;
const NATIVE_BASE = 200n * GWEI;
/** FeeCurrencyDirectory getExchangeRate(cUSD) — direction is ambiguous by design. */
const RATE_NUM = 68_247n;
const RATE_DEN = 1_000_000n;
/** The node's own eth_gasPrice([cUSD]) quote, when it answers. */
const NODE_QUOTE = 13_820_000_000n; // 13.82 gwei
/** A 10c gas seed, 18-decimal fee currency. */
const SEED_WEI = 10n * 10n ** 16n;
/** A realistic ERC-721 mint estimate. */
const MINT_ESTIMATE = 120_000n;

const [DIR_A, DIR_B] = feeCurrencyDirections(NATIVE_BASE, RATE_NUM, RATE_DEN);

describe('the measured mainnet numbers behind the incident', () => {
  it('the two conversion directions differ by ~215x', () => {
    expect(DIR_A / GWEI).toBe(13n); // ~13.65 gwei — the truth
    expect(DIR_B / GWEI).toBe(2930n); // ~2930 gwei — the trap
  });

  it('with the node quote, the calibrated floor picks the real direction', () => {
    expect(calibratedBaseFloor(DIR_A, DIR_B, NODE_QUOTE)).toBe(NODE_QUOTE);
  });

  it('WITHOUT the node quote it stays conservative — which is what starves the burner', () => {
    expect(calibratedBaseFloor(DIR_A, DIR_B, null)).toBe(DIR_B);
  });
});

/** The reservation a plan produces from a given floor, in cents. */
function reservationCents(plan: typeof BALANCED, floor: bigint, estimate = MINT_ESTIMATE): number {
  return feeWeiToCents(feeReservationWei(planGasLimit(plan, estimate), planCapWei(plan, floor)));
}

describe('degradation path (i): no eth_gasPrice quote', () => {
  const floor = calibratedBaseFloor(DIR_A, DIR_B, null);

  it('reserves ~150c against a 10c seed — the reported failure', () => {
    expect(reservationCents(BALANCED, floor)).toBeGreaterThan(140);
  });

  it('no rung of the ladder alone can save it — the ladder is not enough', () => {
    expect(reservationCents(HIGH_CAP, floor)).toBeGreaterThan(10);
    expect(reservationCents(THRIFTY, floor)).toBeGreaterThan(10);
  });

  it('the budget clamp DOES save it: the affordable cap still clears the real floor', () => {
    const gasLimit = planGasLimit(BALANCED, MINT_ESTIMATE);
    const wanted = planCapWei(BALANCED, floor);
    // floorLo is the lower direction — the least we could still believe clears C1.
    const out = budgetedCapWei(wanted, gasLimit, SEED_WEI, planCapWei(BALANCED, DIR_A));
    expect(out.feasible).toBe(true);
    expect(out.clamped).toBe(true);
    expect(out.capWei).toBeLessThan(wanted);
    // C4 holds: the reservation now fits the seed.
    expect(feeReservationWei(gasLimit, out.capWei)).toBeLessThanOrEqual(SEED_WEI);
    // C1 holds with room to spare: still far above the real 13.65 gwei floor.
    expect(out.capWei).toBeGreaterThan(DIR_A * 10n);
  });
});

describe('degradation path (ii): directory unreadable, native base fee used', () => {
  it('reserves just over the seed — dies by a hair, which is why it looked random', () => {
    // Asserted in WEI, not cents: the overshoot is ~3%, and a cents view floors
    // 10.29c to 10 and hides the very margin that decides the tx.
    const reservation = feeReservationWei(planGasLimit(BALANCED, MINT_ESTIMATE), planCapWei(BALANCED, NATIVE_BASE));
    expect(reservation).toBeGreaterThan(SEED_WEI);
    expect(reservation).toBeLessThan(SEED_WEI * 2n);
  });

  it('the clamp brings it inside the seed', () => {
    const gasLimit = planGasLimit(BALANCED, MINT_ESTIMATE);
    const out = budgetedCapWei(planCapWei(BALANCED, NATIVE_BASE), gasLimit, SEED_WEI, planCapWei(BALANCED, NATIVE_BASE) / 2n);
    expect(out.feasible).toBe(true);
    expect(feeReservationWei(gasLimit, out.capWei)).toBeLessThanOrEqual(SEED_WEI);
  });
});

describe('the healthy path is left alone', () => {
  it('a cap that already fits is returned untouched and unclamped', () => {
    const gasLimit = planGasLimit(BALANCED, MINT_ESTIMATE);
    const wanted = planCapWei(BALANCED, NODE_QUOTE);
    const out = budgetedCapWei(wanted, gasLimit, SEED_WEI, NODE_QUOTE);
    expect(out.capWei).toBe(wanted);
    expect(out.clamped).toBe(false);
    expect(out.feasible).toBe(true);
  });

  it('the calibrated mint costs a small fraction of the seed', () => {
    expect(reservationCents(BALANCED, NODE_QUOTE)).toBeLessThan(2);
  });
});

describe('when nothing can work, refuse instead of broadcasting', () => {
  it('an empty wallet is infeasible at any cap', () => {
    const out = budgetedCapWei(planCapWei(BALANCED, NODE_QUOTE), 256_000n, 0n, NODE_QUOTE);
    expect(out.feasible).toBe(false);
    expect(out.affordableWei).toBe(0n);
  });

  it('a balance below even the hard floor is infeasible', () => {
    const gasLimit = 256_000n;
    const floorLo = planCapWei(BALANCED, NODE_QUOTE);
    const tooLittle = feeReservationWei(gasLimit, floorLo) - 1n;
    expect(budgetedCapWei(floorLo, gasLimit, tooLittle, floorLo).feasible).toBe(false);
  });

  it('exactly enough for the hard floor is feasible — no off-by-one lockout', () => {
    const gasLimit = 256_000n;
    const floorLo = planCapWei(BALANCED, NODE_QUOTE);
    const exact = feeReservationWei(gasLimit, floorLo);
    expect(budgetedCapWei(floorLo, gasLimit, exact, floorLo).feasible).toBe(true);
  });
});

describe('affordableCapWei', () => {
  it('is the budget divided by the gas limit', () => {
    expect(affordableCapWei(100n, 1000n)).toBe(10n);
  });

  it('degenerate inputs yield 0, never a division error', () => {
    expect(affordableCapWei(0n, 1000n)).toBe(0n);
    expect(affordableCapWei(100n, 0n)).toBe(0n);
    expect(affordableCapWei(100n, -5n)).toBe(0n);
  });
});

describe('the refusal carries usable numbers, not a shrug', () => {
  it('names the shortfall in cents and carries the sentinel', () => {
    const err = new InsufficientGasBudgetError(150n * 10n ** 16n, 10n * 10n ** 16n);
    expect(err.neededCents).toBe(150);
    expect(err.budgetCents).toBe(10);
    expect(err.message).toContain(GAS_BUDGET_SENTINEL);
    expect(err).toBeInstanceOf(Error);
  });

  it('the sentinel survives the toast classifier that produced the vague message', () => {
    const raw = new InsufficientGasBudgetError(150n * 10n ** 16n, 10n * 10n ** 16n).message;
    // App.tsx tests the sentinel BEFORE this generic branch; if that order ever
    // flips, the precise message silently regresses to "still being funded".
    const needGas = /insufficient|funds for gas|exceeds the balance/.test(raw.toLowerCase());
    expect(raw.includes(GAS_BUDGET_SENTINEL)).toBe(true);
    expect(needGas).toBe(false); // no accidental overlap either way
  });
});
