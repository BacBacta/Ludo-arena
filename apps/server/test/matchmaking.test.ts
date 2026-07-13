import { describe, expect, it } from 'vitest';
import {
  BASE_WINDOW,
  compatible,
  eloWindow,
  Matchmaker,
  WIDEN_INTERVAL_MS,
  WIDEN_STEP,
  type QueueEntry,
} from '../src/matchmaking.js';

const T0 = 1_000_000;

function entry(id: string, elo: number, enqueuedAt = T0, walletBacked = false): QueueEntry<string> {
  return { session: id, entropy: 'e'.repeat(16), elo, enqueuedAt, walletBacked };
}

describe('eloWindow (AC E2.3)', () => {
  it('starts at ±100', () => {
    expect(eloWindow(T0, T0)).toBe(BASE_WINDOW);
    expect(eloWindow(T0, T0 + WIDEN_INTERVAL_MS - 1)).toBe(BASE_WINDOW);
  });

  it('widens by +50 every 5 s', () => {
    expect(eloWindow(T0, T0 + WIDEN_INTERVAL_MS)).toBe(BASE_WINDOW + WIDEN_STEP);
    expect(eloWindow(T0, T0 + 2 * WIDEN_INTERVAL_MS)).toBe(BASE_WINDOW + 2 * WIDEN_STEP);
    expect(eloWindow(T0, T0 + 60_000)).toBe(BASE_WINDOW + 12 * WIDEN_STEP);
  });

  it('never shrinks below the base window (clock skew)', () => {
    expect(eloWindow(T0, T0 - 10_000)).toBe(BASE_WINDOW);
  });
});

describe('compatible', () => {
  it('accepts a gap within both windows', () => {
    expect(compatible(entry('a', 1200), entry('b', 1300), T0)).toBe(true);
    expect(compatible(entry('a', 1200), entry('b', 1301), T0)).toBe(false);
  });

  it('requires BOTH windows to cover the gap', () => {
    const veteran = entry('a', 1200, T0 - 30_000); // window 400
    const fresh = entry('b', 1500, T0); // window 100 < gap 300
    expect(compatible(veteran, fresh, T0)).toBe(false);
    // once the fresh entry has waited 20 s, its window reaches 300
    expect(compatible(veteran, { ...fresh, enqueuedAt: T0 - 20_000 }, T0)).toBe(true);
  });

  it('rejects two DIFFERENT sessions that share a durable identity (same wallet, two tabs)', () => {
    const a = { ...entry('tab-a', 1200, T0, true), identity: '0xwallet' };
    const b = { ...entry('tab-b', 1200, T0, true), identity: '0xwallet' };
    expect(compatible(a, b, T0, 25)).toBe(false); // would double-count games + farm a self-win
    expect(compatible(a, { ...b, identity: '0xother' }, T0, 25)).toBe(true); // distinct players pair
  });
});

describe('Matchmaker.join', () => {
  it('pairs instantly when compatible, queues otherwise', () => {
    const mm = new Matchmaker<string>();
    expect(mm.join(25, entry('a', 1200), T0)).toBeNull();
    const pair = mm.join(25, entry('b', 1250), T0);
    expect(pair?.map((e) => e.session)).toEqual(['a', 'b']);
    // queue is empty again
    expect(mm.join(25, entry('c', 1200), T0)).toBeNull();
  });

  it('does not pair across the window', () => {
    const mm = new Matchmaker<string>();
    mm.join(25, entry('a', 1200), T0);
    expect(mm.join(25, entry('b', 1350), T0)).toBeNull();
    expect(mm.position(25, 'a')).toBe(1);
    expect(mm.position(25, 'b')).toBe(2);
  });

  it('prefers the closest ELO among compatible candidates', () => {
    const mm = new Matchmaker<string>();
    mm.join(25, entry('low', 1101), T0);
    mm.join(25, entry('close', 1210), T0 + 1); // low/close gap 109 > 100: no pre-pair
    const pair = mm.join(25, entry('me', 1200), T0 + 2); // both within ±100 of me
    expect(pair).not.toBeNull();
    expect(pair!.map((e) => e.session)).toContain('close');
    expect(mm.position(25, 'low')).toBe(1);
  });

  it('keeps stakes separate', () => {
    const mm = new Matchmaker<string>();
    mm.join(25, entry('a', 1200), T0);
    expect(mm.join(100, entry('b', 1200), T0)).toBeNull();
  });

  it('never mixes wallet-backed and demo players in a STAKED queue', () => {
    const mm = new Matchmaker<string>();
    mm.join(25, entry('real', 1200, T0, true), T0);
    // same ELO, but demo vs wallet → must NOT pair at a stake > 0
    expect(mm.join(25, entry('demo', 1200, T0, false), T0)).toBeNull();
    // a second wallet-backed player pairs with the first
    const pair = mm.join(25, entry('real2', 1200, T0, true), T0);
    expect(pair?.map((e) => e.session).sort()).toEqual(['real', 'real2']);
    // sweep never crosses modes either, no matter how long they wait
    expect(mm.sweep(T0 + 120_000)).toEqual([]);
  });

  it('mixes freely at stake 0 (free play has no escrow)', () => {
    const mm = new Matchmaker<string>();
    mm.join(0, entry('real', 1200, T0, true), T0);
    const pair = mm.join(0, entry('demo', 1200, T0, false), T0);
    expect(pair).not.toBeNull();
  });

  it('never pairs a session with itself (double join / freeroll self-farm)', () => {
    const mm = new Matchmaker<string>();
    // same session id joins twice: the second must NOT pair with the first
    mm.join(0, entry('me', 1200, T0), T0);
    expect(mm.join(0, entry('me', 1200, T0), T0)).toBeNull();
    expect(compatible(entry('me', 1200), entry('me', 1300), T0)).toBe(false);
    // and a real opponent still pairs (self-skip doesn't over-block)
    const pair = mm.join(0, entry('other', 1200, T0), T0);
    expect(pair).not.toBeNull();
    expect(pair!.map((e) => e.session)).toContain('other');
  });
});

describe('Matchmaker.sweep', () => {
  it('pairs entries once their windows widen', () => {
    const mm = new Matchmaker<string>();
    mm.join(25, entry('a', 1200), T0);
    mm.join(25, entry('b', 1400), T0); // gap 200 > 100: waits
    expect(mm.sweep(T0)).toEqual([]);
    // after 10 s both windows are 200 → pair
    const pairs = mm.sweep(T0 + 10_000);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.stake).toBe(25);
    expect(pairs[0]!.pair.map((e) => e.session).sort()).toEqual(['a', 'b']);
    expect(mm.position(25, 'a')).toBe(0);
  });

  it('matches younger close pairs even when the oldest entry has nobody', () => {
    const mm = new Matchmaker<string>();
    mm.join(25, entry('outlier', 2000, T0), T0);
    mm.join(25, entry('b', 1200, T0), T0); // gap 800 vs outlier: queues
    mm.join(25, entry('c', 1500, T0), T0); // gaps 500/300: queues
    const pairs = mm.sweep(T0 + 25_000); // windows 350: b-c gap 300 fits, outlier fits nobody
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.pair.map((e) => e.session).sort()).toEqual(['b', 'c']);
    expect(mm.position(25, 'outlier')).toBe(1);
  });

  it('pairs the longest-waiting entries first', () => {
    const mm = new Matchmaker<string>();
    mm.join(25, entry('old', 1200, T0), T0);
    mm.join(25, entry('mid', 1450, T0 + 1_000), T0 + 1_000); // 250 from old: queues
    mm.join(25, entry('new', 1560, T0 + 2_000), T0 + 2_000); // 110 from mid: queues
    const pairs = mm.sweep(T0 + 40_000); // windows large enough for everyone
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.pair[0]!.session).toBe('old'); // oldest picks first
    expect(pairs[0]!.pair[1]!.session).toBe('mid'); // and takes the closest ELO
    expect(mm.position(25, 'new')).toBe(1);
  });

  it('leaveAll removes a session from every queue', () => {
    const mm = new Matchmaker<string>();
    mm.join(25, entry('a', 1200), T0);
    mm.join(100, entry('a', 1200), T0);
    mm.leaveAll('a');
    expect(mm.position(25, 'a')).toBe(0);
    expect(mm.position(100, 'a')).toBe(0);
  });
});
