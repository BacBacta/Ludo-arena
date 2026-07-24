import { describe, expect, it } from 'vitest';
import { botLockRequirement, locksAffordable } from '../src/houseBot.js';

// The house bot's wallet drains a gas fee per game and its exhaustion is
// INVISIBLE from the outside: it stops being offered, and every Race match it
// was pulled into aborted + refunded ("stake lock failed" to the player, nothing
// to the operator). These cover the arithmetic the solvency gate + runway
// watchdog decide on, with the MEASURED mainnet numbers of 2026-07-24.

const GWEI = 1_000_000_000n;
const CENT = 10n ** 16n; // 1c of an 18-decimal token (cUSD)
const GAS = 250_000n;

describe('botLockRequirement', () => {
  it('is stake + the RESERVATION the node holds (gasLimit x cap), not the fee paid', () => {
    // 1c stake, cap 8 gwei-cUSD → 250k x 8 gwei = 0.002 cUSD reserved.
    expect(botLockRequirement(CENT, GAS, 8n * GWEI)).toBe(CENT + GAS * 8n * GWEI);
  });

  it('counts ONLY the stake when gas is paid in the native coin (no cap)', () => {
    expect(botLockRequirement(CENT, GAS, null)).toBe(CENT);
  });

  it('reproduces the ~176c-per-lock regression that starved the bot', () => {
    // The uncontrolled MAX-of-both-directions cap measured in production.
    const uncalibratedCap = 8_782_930_115_486n; // ~8783 gwei-cUSD
    const required = botLockRequirement(CENT, GAS, uncalibratedCap);
    const cents = Number(required / CENT);
    expect(cents).toBeGreaterThan(150); // ~176c per lock…
    // …against the real 4.80 cUSD balance: under three locks of runway.
    expect(locksAffordable(480n * CENT, required)).toBeLessThan(3);
  });

  it('the calibrated cap turns the same balance into hundreds of locks', () => {
    // Calibrated floor ~13.8 gwei-cUSD x the bot's deliberate 6x headroom.
    const calibrated = 6n * 13_800_000_000n;
    const required = botLockRequirement(CENT, GAS, calibrated);
    expect(locksAffordable(480n * CENT, required)).toBeGreaterThan(100);
  });
});

describe('locksAffordable (the runway the watchdog alerts on)', () => {
  it('is 0 when the balance cannot cover a single lock — the gate must refuse', () => {
    const required = botLockRequirement(CENT, GAS, 8n * GWEI);
    expect(locksAffordable(required - 1n, required)).toBe(0);
    expect(locksAffordable(0n, required)).toBe(0);
  });

  it('floors the division (a partial lock is not a lock)', () => {
    const required = 100n;
    expect(locksAffordable(250n, required)).toBe(2);
    expect(locksAffordable(300n, required)).toBe(3);
  });

  it('an exactly-sufficient balance still affords one lock', () => {
    const required = botLockRequirement(CENT, GAS, 8n * GWEI);
    expect(locksAffordable(required, required)).toBe(1);
  });
});
