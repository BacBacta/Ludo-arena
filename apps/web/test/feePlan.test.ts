import { describe, expect, it } from 'vitest';
import {
  BALANCED,
  HIGH_CAP,
  THRIFTY,
  classifyTxFailure,
  needsPreLockSeed,
  nextFeePlan,
  planCapWei,
  planGasLimit,
  planReservationWei,
} from '../src/lib/feePlan';

// The constraint system a burner lock tx must satisfy AT ONCE (C1..C4 in the
// module doc). Each incident of the launch violated one of them; these tests
// pin the classification of every REAL error message (verbatim) and the ladder
// invariants across the whole base-fee range.

const GWEI = 1_000_000_000n;

describe('classifyTxFailure — the four real launch incidents, verbatim', () => {
  it('C1: "The fee cap (`maxFeePerGas` gwei) cannot be lower than the block base fee"', () => {
    expect(classifyTxFailure(new Error('The fee cap (`maxFeePerGas` = 52 gwei) cannot be lower than the block base fee'))).toBe('cap-too-low');
  });
  it('C2: "execution reverted with reason: gas required exceeds allowance (0)"', () => {
    expect(classifyTxFailure(new Error('execution reverted with reason: gas required exceeds allowance (0)'))).toBe('exceeds-balance');
  });
  it('C3: "approve reverted" (mined out-of-gas)', () => {
    expect(classifyTxFailure(new Error('approve reverted'))).toBe('oog');
  });
  it('C4: "the total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account"', () => {
    expect(classifyTxFailure(new Error('the total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account'))).toBe('exceeds-balance');
  });
  it('a user rejection is terminal (never ladders)', () => {
    expect(classifyTxFailure(Object.assign(new Error('User rejected the request'), { code: 4001 }))).toBe('rejected');
  });
  it('anything else is a plain transient', () => {
    expect(classifyTxFailure(new Error('socket hang up'))).toBe('other');
  });
});

describe('ladder transitions', () => {
  it('cap-too-low → HIGH_CAP (spike: pay for certainty)', () => {
    expect(nextFeePlan(BALANCED, 'cap-too-low').name).toBe('high-cap');
  });
  it('exceeds-balance → THRIFTY (tiny balance: cheapest viable tx)', () => {
    expect(nextFeePlan(BALANCED, 'exceeds-balance').name).toBe('thrifty');
    expect(nextFeePlan(HIGH_CAP, 'exceeds-balance').name).toBe('thrifty');
  });
  it('oog → same fee posture, MORE gas', () => {
    const bumped = nextFeePlan(BALANCED, 'oog');
    expect(bumped.capMultiplier).toBe(BALANCED.capMultiplier);
    expect(planGasLimit(bumped, 250_000n)).toBeGreaterThan(planGasLimit(BALANCED, 250_000n));
  });
  it('other → same plan (plain retry with fresh reads)', () => {
    expect(nextFeePlan(BALANCED, 'other')).toBe(BALANCED);
  });
});

describe('plan invariants across the base-fee range (C1 by construction)', () => {
  const baseFees = [1n, 5n, 10n, 25n, 50n, 100n, 200n, 500n, 1000n].map((g) => g * GWEI);
  for (const plan of [BALANCED, HIGH_CAP, THRIFTY]) {
    it(`${plan.name}: cap stays STRICTLY above the base fee at every level`, () => {
      for (const bf of baseFees) expect(planCapWei(plan, bf)).toBeGreaterThan(bf);
    });
    it(`${plan.name}: gas limit always covers the CIP-64 intrinsic (>= estimate + 50k)`, () => {
      for (const est of [30_000n, 50_000n, 250_000n]) {
        expect(planGasLimit(plan, est)).toBeGreaterThanOrEqual(est + 50_000n);
      }
    });
  }

  it('C4 relief is real: reservation strictly DECREASES balanced → thrifty, increases → high-cap', () => {
    for (const bf of baseFees) {
      const est = 250_000n;
      expect(planReservationWei(THRIFTY, est, bf)).toBeLessThan(planReservationWei(BALANCED, est, bf));
      expect(planReservationWei(HIGH_CAP, est, bf)).toBeGreaterThan(planReservationWei(BALANCED, est, bf));
    }
  });

  it('order of magnitude: a thrifty join at a NORMAL base fee fits a few-cent wallet', () => {
    // 25 gwei base fee, 250k estimate → reservation in wei must stay well under
    // ~0.05 cUSD-equivalent (5e16 wei) — the regime where players actually sit.
    expect(planReservationWei(THRIFTY, 250_000n, 25n * GWEI)).toBeLessThan(50_000_000_000_000_000n);
  });
});

describe('pre-lock seed top-up decision (the balance-erosion safety net)', () => {
  it('asks for a top-up when the balance slid under the seed target', () => {
    expect(needsPreLockSeed(4)).toBe(true);
    expect(needsPreLockSeed(9)).toBe(true);
  });
  it('stays quiet at or above the target, and on an unreadable balance', () => {
    expect(needsPreLockSeed(10)).toBe(false);
    expect(needsPreLockSeed(25)).toBe(false);
    expect(needsPreLockSeed(null)).toBe(false); // never block the lock on a read failure
  });
});
