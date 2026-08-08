import { describe, expect, it } from 'vitest';
import { raceIsOver } from '../src/race.js';

// THE INCIDENT THIS ENCODES. `endsAt` was carried to the client for display
// while the event's `active` flag was hardcoded true, so Race Week kept running
// past its announced close — card shown, Passes mintable, faucet still seeding
// gas — until an operator noticed and disarmed it by hand. Every money path now
// reads this predicate, so these cases ARE the campaign's closing rules.

const END = '2026-08-07T23:59:59.000Z';
const at = (iso: string): number => Date.parse(iso);

describe('raceIsOver — a campaign must not outlive its own end date', () => {
  it('is over once the end has passed', () => {
    expect(raceIsOver(END, at('2026-08-08T00:00:00.000Z'))).toBe(true);
    expect(raceIsOver(END, at('2026-08-20T12:00:00.000Z'))).toBe(true);
  });

  it('is NOT over before the end', () => {
    expect(raceIsOver(END, at('2026-08-07T23:00:00.000Z'))).toBe(false);
    expect(raceIsOver(END, at('2026-07-30T09:00:00.000Z'))).toBe(false);
  });

  it('closes exactly AT the end instant (no extra second of spending)', () => {
    expect(raceIsOver(END, at(END))).toBe(true);
  });

  it('no end date = open-ended, the legacy "runs until disarmed" campaign', () => {
    expect(raceIsOver(undefined, at('2030-01-01T00:00:00.000Z'))).toBe(false);
    expect(raceIsOver('', at('2030-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('a MALFORMED date never closes a live event', () => {
    // Fail-safe direction, same as parseCeloEnvWei: a typo'd Fly secret must
    // not silently kill a running campaign — an operator can always disarm.
    expect(raceIsOver('next friday', at('2030-01-01T00:00:00.000Z'))).toBe(false);
    expect(raceIsOver('2026-13-45', at('2030-01-01T00:00:00.000Z'))).toBe(false);
  });
});
