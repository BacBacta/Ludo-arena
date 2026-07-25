import { describe, expect, it } from 'vitest';
import { Matchmaker, structurallyPairable, compatible, type QueueEntry } from '../src/matchmaking.js';

// THE BUG. The house-bot fallback took EVERY Race seeker who had waited past the
// window. Two humans whose ELO windows had not met yet were therefore both pulled
// into bot games seconds before they would have paired with each other. Bot games
// are deliberately non-scoring, so on a thin event this quietly starved the
// leaderboard: real players kept playing and the standings never moved.
//
// The rule now: the bot may only take a seeker for whom NO human opponent can
// ever arrive out of this queue. An ELO gap never qualifies (that window widens
// on its own); only a STRUCTURAL block does.

const T0 = 1_000_000;
const RACE = 1 as const;

function entry(id: string, elo: number, enqueuedAt = T0, extra: Partial<QueueEntry<string>> = {}): QueueEntry<string> {
  return { session: id, entropy: 'e'.repeat(16), elo, enqueuedAt, walletBacked: true, ...extra };
}

describe('structurallyPairable — what waiting can never fix', () => {
  it('a wide ELO gap is NOT structural: these two will pair once the window widens', () => {
    const a = entry('a', 1000);
    const b = entry('b', 9999);
    expect(compatible(a, b, T0, RACE)).toBe(false); // not yet…
    expect(structurallyPairable(a, b, RACE)).toBe(true); // …but a human IS coming
  });

  it('same session, same identity, QA mismatch and wallet/demo mismatch ARE structural', () => {
    const a = entry('a', 1000, T0, { identity: 'w1' });
    expect(structurallyPairable(a, a, RACE)).toBe(false);
    expect(structurallyPairable(a, entry('b', 1000, T0, { identity: 'w1' }), RACE)).toBe(false);
    expect(structurallyPairable(a, entry('c', 1000, T0, { qa: true }), RACE)).toBe(false);
    expect(structurallyPairable(a, entry('d', 1000, T0, { walletBacked: false }), RACE)).toBe(false);
  });

  it('the wallet/demo split only applies to STAKED play', () => {
    const real = entry('a', 1000, T0, { walletBacked: true });
    const demo = entry('b', 1000, T0, { walletBacked: false });
    expect(structurallyPairable(real, demo, RACE)).toBe(false);
    expect(structurallyPairable(real, demo, 0)).toBe(true); // free play mixes freely
  });
});

describe('starvedWaiters — the bot only fills a seat no human can take', () => {
  const cutoff = T0 + 12_000;

  it('TWO humans far apart on ELO: NEITHER goes to the bot — they are about to pair', () => {
    const mm = new Matchmaker<string>();
    mm.join(RACE, entry('alice', 1000), T0);
    mm.join(RACE, entry('bob', 9999), T0); // no pair yet: window too narrow
    expect(mm.starvedWaiters(RACE, cutoff)).toEqual([]);
  });

  it('a LONE human goes to the bot', () => {
    const mm = new Matchmaker<string>();
    mm.join(RACE, entry('alice', 1000), T0);
    expect(mm.starvedWaiters(RACE, cutoff).map((e) => e.session)).toEqual(['alice']);
  });

  it('two entries that are the SAME player (two tabs) can never pair — both are starved', () => {
    const mm = new Matchmaker<string>();
    mm.join(RACE, entry('tab1', 1000, T0, { identity: 'wallet-x' }), T0);
    mm.join(RACE, entry('tab2', 1000, T0, { identity: 'wallet-x' }), T0);
    expect(mm.starvedWaiters(RACE, cutoff).map((e) => e.session).sort()).toEqual(['tab1', 'tab2']);
  });

  it('a real-wallet seeker queued next to a DEMO player is starved (staked play cannot mix)', () => {
    const mm = new Matchmaker<string>();
    mm.join(RACE, entry('real', 1000, T0, { walletBacked: true }), T0);
    mm.join(RACE, entry('demo', 1000, T0, { walletBacked: false }), T0);
    expect(mm.starvedWaiters(RACE, cutoff).map((e) => e.session).sort()).toEqual(['demo', 'real']);
  });

  it('only waiters PAST the cutoff are offered — a fresh arrival keeps waiting for a human', () => {
    const mm = new Matchmaker<string>();
    mm.join(RACE, entry('fresh', 1000, cutoff + 1), cutoff + 1);
    expect(mm.starvedWaiters(RACE, cutoff)).toEqual([]);
  });

  it('the `eligible` filter removes a seat from BOTH roles — seeker and future opponent', () => {
    const mm = new Matchmaker<string>();
    // Far apart on ELO so they stay QUEUED at T0 (join would otherwise pair them).
    mm.join(RACE, entry('alice', 1000), T0);
    mm.join(RACE, entry('ghost', 9999), T0); // e.g. already in a room
    // Without the filter alice has a partner, so nobody is starved…
    expect(mm.starvedWaiters(RACE, cutoff)).toEqual([]);
    // …with the ghost excluded, alice is alone and must get the bot.
    const live = mm.starvedWaiters(RACE, cutoff, (e) => e.session !== 'ghost');
    expect(live.map((e) => e.session)).toEqual(['alice']);
  });

  it('a third wheel is starved while the other two pair off', () => {
    const mm = new Matchmaker<string>();
    // alice+bob are pairable; carol shares alice's identity and cannot take either seat.
    mm.join(RACE, entry('alice', 1000, T0, { identity: 'w-a' }), T0);
    mm.join(RACE, entry('carol', 1000, T0, { identity: 'w-a' }), T0);
    const starved = mm.starvedWaiters(RACE, cutoff).map((e) => e.session);
    expect(starved).toContain('alice');
    expect(starved).toContain('carol');
  });

  it('oldest seeker first — the longest wait is served before a newer one', () => {
    const mm = new Matchmaker<string>();
    mm.join(RACE, entry('younger', 1000, T0 + 500, { identity: 'w1' }), T0);
    mm.join(RACE, entry('older', 1000, T0, { identity: 'w1' }), T0);
    expect(mm.starvedWaiters(RACE, cutoff).map((e) => e.session)).toEqual(['older', 'younger']);
  });

  it('an empty / unknown queue is simply empty — never throws', () => {
    const mm = new Matchmaker<string>();
    expect(mm.starvedWaiters(RACE, cutoff)).toEqual([]);
    expect(mm.starvedWaiters(999 as never, cutoff)).toEqual([]);
  });
});

describe('the OLD behaviour is what we are replacing', () => {
  it('waitersOlderThan would have handed BOTH humans to the bot', () => {
    const mm = new Matchmaker<string>();
    mm.join(RACE, entry('alice', 1000), T0);
    mm.join(RACE, entry('bob', 9999), T0);
    // The old fallback source: everyone past the window, human peers ignored.
    expect(mm.waitersOlderThan(RACE, T0 + 12_000).map((e) => e.session).sort()).toEqual(['alice', 'bob']);
    // The new one defers to the humans.
    expect(mm.starvedWaiters(RACE, T0 + 12_000)).toEqual([]);
  });

  it('waitersOlderThan is KEPT on purpose — it backs the hard-deadline safety valve', () => {
    // A queued-but-stuck peer must not starve a seeker forever, so past the hard
    // deadline the bot fills in regardless. That path still needs the raw list.
    const mm = new Matchmaker<string>();
    mm.join(RACE, entry('alice', 1000), T0);
    mm.join(RACE, entry('stuck', 9999), T0); // still queued: window too narrow
    expect(mm.starvedWaiters(RACE, T0 + 12_000)).toEqual([]); // deferred at the soft window
    expect(mm.waitersOlderThan(RACE, T0 + 90_000).map((e) => e.session).sort()).toEqual(['alice', 'stuck']);
  });
});

describe('no regression in ordinary pairing', () => {
  it('two compatible humans still pair on join, with no bot involved', () => {
    const mm = new Matchmaker<string>();
    expect(mm.join(RACE, entry('alice', 1000), T0)).toBeNull();
    const pair = mm.join(RACE, entry('bob', 1010), T0);
    expect(pair).not.toBeNull();
    expect(pair!.map((e) => e.session).sort()).toEqual(['alice', 'bob']);
    expect(mm.starvedWaiters(RACE, T0 + 12_000)).toEqual([]); // queue drained
  });

  it('the sweep still pairs them once the window widens', () => {
    const mm = new Matchmaker<string>();
    mm.join(RACE, entry('alice', 1000), T0);
    mm.join(RACE, entry('bob', 1400), T0);
    expect(mm.sweep(T0)).toEqual([]); // gap 400 > window 100
    const pairs = mm.sweep(T0 + 40_000); // window has widened past 400
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.pair.map((e) => e.session).sort()).toEqual(['alice', 'bob']);
  });
});
