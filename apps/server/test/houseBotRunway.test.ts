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

// A match needs BOTH seats locked. The bot used to fire ONE attempt at one
// multiplier while the web client retried and escalated to 10x, so a base-fee
// spike rejected the bot's tx and aborted the human's game — only ~1 staked
// match in 3 was landing. The ladder must escalate, and it must stay affordable.
describe('house-bot cap ladder (the "1 in 3 matches stake" incident)', () => {
  it('escalates strictly, starting at the standing multiplier', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/houseBot.ts', import.meta.url), 'utf8'));
    const ladder = /const HOUSE_BOT_CAP_LADDER = \[([^\]]+)\]/.exec(src)?.[1] ?? '';
    const rungs = ladder.split(',').map((r) => r.trim()).filter(Boolean);
    expect(rungs.length).toBeGreaterThanOrEqual(3); // one shot was the bug
    expect(rungs[0]).toBe('HOUSE_BOT_CAP_MULT'); // first try stays cheap
    const nums = rungs.slice(1).map((r) => BigInt(r.replace('n', '')));
    for (let i = 1; i < nums.length; i++) expect(nums[i]!).toBeGreaterThan(nums[i - 1]!);
    expect(nums[nums.length - 1]!).toBeGreaterThanOrEqual(20n); // real spike headroom
  });

  it('the top rung is still trivial for a funded bot wallet', () => {
    // Calm mainnet floor 13.8 gwei, join ~250k gas, bot holds ~4.8 cUSD.
    const cap = 60n * 13_814_189_500n;
    const reserveCents = Number((cap * 250_000n * 100_000n) / 10n ** 18n) / 1000;
    expect(reserveCents).toBeLessThan(50); // « 480c balance
  });
});
