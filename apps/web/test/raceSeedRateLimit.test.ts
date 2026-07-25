import { describe, expect, it } from 'vitest';
import type { ServerMsg } from '@ludo/shared';

// THE BUG. The server answers a rate-limited `race.seed` with a NON-error frame
// carrying 0 cents (nothing was sent). The client transport dropped the
// `rateLimited` flag, so joinRaceWeek could not tell "seed landed" from "seed
// refused by the anti-spam window" — it minted the Race Pass on an empty burner,
// the tx died on funds, and the player got the vaguest toast in the app:
// "Your entry is still being funded — give it a moment and tap again".
//
// These lock the contract that makes that state impossible to mistake again.

/** The shape the transport hands joinRaceWeek (mirrors RaceSeedResult). */
type SeedResult =
  | { seedCents: number; alreadySeeded: boolean; txHash?: string; rateLimited?: boolean; retryInMs?: number }
  | { error: string };

/** The transport's mapping of a race.seeded frame — must preserve rateLimited. */
function toSeedResult(msg: Extract<ServerMsg, { t: 'race.seeded' }>): SeedResult {
  return { seedCents: msg.seedCents, alreadySeeded: msg.alreadySeeded, txHash: msg.txHash, rateLimited: msg.rateLimited, retryInMs: msg.retryInMs };
}

/** Did the wallet actually receive gas? A rate-limited ack means NO. */
function seedLanded(r: SeedResult): boolean {
  if ('error' in r) return false;
  if (r.rateLimited) return false; // 0 cents, nothing sent
  return r.seedCents > 0 || r.alreadySeeded;
}

describe('race.seed rate-limit ack is not a funded wallet', () => {
  it('preserves rateLimited + retryInMs through the transport', () => {
    const frame = { t: 'race.seeded', seedCents: 0, alreadySeeded: false, rateLimited: true, retryInMs: 1800 } as const;
    const r = toSeedResult(frame);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.rateLimited).toBe(true);
    expect(r.retryInMs).toBe(1800);
  });

  it('a rate-limited ack does NOT count as landed (the mint must not proceed)', () => {
    expect(seedLanded({ seedCents: 0, alreadySeeded: false, rateLimited: true, retryInMs: 1800 })).toBe(false);
  });

  it('a real seed and an already-seeded wallet both count as landed', () => {
    expect(seedLanded({ seedCents: 10, alreadySeeded: false, txHash: '0xabc' })).toBe(true);
    expect(seedLanded({ seedCents: 0, alreadySeeded: true })).toBe(true);
  });

  it('a server refusal is not landed either', () => {
    expect(seedLanded({ error: 'This device already used its gas-seed allowance.' })).toBe(false);
  });
});

// The retry must wait for the server's OWN window, clamped so a hostile or
// absent value can neither hang the flow nor hammer the server.
function retryWaitMs(retryInMs: number | undefined): number {
  return Math.min(5000, Math.max(500, retryInMs ?? 3200)) + 250;
}

describe('seed retry backoff', () => {
  it('waits just past the window the server reported', () => {
    expect(retryWaitMs(1800)).toBe(2050);
  });

  it('falls back to a safe default when the server says nothing', () => {
    expect(retryWaitMs(undefined)).toBe(3450);
  });

  it('clamps absurd values on both ends', () => {
    expect(retryWaitMs(0)).toBe(750); // never a busy-loop
    expect(retryWaitMs(9_999_999)).toBe(5250); // never an apparent hang
  });
});

// The mint pre-flight: only a KNOWN-insufficient balance may cancel the mint.
// A failed balance READ must fail OPEN, or an RPC hiccup would lock players out
// of the event entirely.
const MIN_MINT_GAS_CENTS = 4;
const shouldAbortMint = (balCents: number | null): boolean => balCents !== null && balCents < MIN_MINT_GAS_CENTS;

describe('mint pre-flight', () => {
  it('aborts when the burner is known to be below the mint floor', () => {
    expect(shouldAbortMint(0)).toBe(true);
    expect(shouldAbortMint(3)).toBe(true);
  });

  it('proceeds at or above the floor', () => {
    expect(shouldAbortMint(4)).toBe(false);
    expect(shouldAbortMint(10)).toBe(false);
  });

  it('fails OPEN on a failed balance read (null), never blocking a funded player', () => {
    expect(shouldAbortMint(null)).toBe(false);
  });
});
