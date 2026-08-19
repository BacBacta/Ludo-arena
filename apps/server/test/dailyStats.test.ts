import { describe, expect, it } from 'vitest';
import { aggregateDailyStats, parseDaysParam, summariseStats } from '../src/stats.js';
import type { StoredGameRow } from '../src/store/types.js';

// GET /stats/daily is the public DAU figure quoted in posts and grant
// profiles — the aggregation must count people, days and stakes exactly.

function row(over: Partial<StoredGameRow>): StoredGameRow {
  return {
    gameId: over.gameId ?? Math.random().toString(36).slice(2),
    playerA: over.playerA ?? '0xAAA',
    playerB: over.playerB ?? '0xBBB',
    winnerSeat: 0,
    reason: 'finish',
    stakeCents: over.stakeCents ?? 1,
    endedAt: over.endedAt ?? '2026-07-28T10:00:00.000Z',
    isHouseBot: over.isHouseBot ?? false,
  };
}

describe('aggregateDailyStats — the public DAU read-model', () => {
  it('groups by UTC day and counts DISTINCT players across both seats', () => {
    const out = aggregateDailyStats(
      [
        row({ playerA: '0xa', playerB: '0xb', endedAt: '2026-07-27T08:00:00.000Z' }),
        row({ playerA: '0xa', playerB: '0xc', endedAt: '2026-07-27T22:00:00.000Z' }),
        row({ playerA: '0xd', playerB: '0xe', endedAt: '2026-07-28T01:00:00.000Z' }),
      ],
      '2026-07-01T00:00:00.000Z',
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ day: '2026-07-27', players: 3, games: 2, stakedGames: 2 });
    expect(out[1]).toEqual({ day: '2026-07-28', players: 2, games: 1, stakedGames: 1 });
  });

  it('a player is one person whatever the address casing', () => {
    const out = aggregateDailyStats(
      [row({ playerA: '0xAbC', playerB: '0xdef' }), row({ playerA: '0xabc', playerB: '0xDEF' })],
      '2026-07-01T00:00:00.000Z',
    );
    expect(out[0]!.players).toBe(2);
  });

  it('free games count as games and players, not as stakedGames', () => {
    const out = aggregateDailyStats(
      [row({ stakeCents: 0 }), row({ stakeCents: 1 })],
      '2026-07-01T00:00:00.000Z',
    );
    expect(out[0]!.games).toBe(2);
    expect(out[0]!.stakedGames).toBe(1);
  });

  it('cuts strictly at the window start and sorts days ascending', () => {
    const out = aggregateDailyStats(
      [
        row({ endedAt: '2026-06-30T23:59:59.000Z' }), // before the window
        row({ endedAt: '2026-07-28T00:00:00.000Z' }),
        row({ endedAt: '2026-07-02T00:00:00.000Z' }),
      ],
      '2026-07-01T00:00:00.000Z',
    );
    expect(out.map((d) => d.day)).toEqual(['2026-07-02', '2026-07-28']);
  });
});

describe('parseDaysParam — the ?days query knob', () => {
  it('defaults to 30 and clamps to 1..90', () => {
    expect(parseDaysParam(null)).toBe(30);
    expect(parseDaysParam('abc')).toBe(30);
    expect(parseDaysParam('-5')).toBe(30);
    expect(parseDaysParam('7')).toBe(7);
    expect(parseDaysParam('9000')).toBe(90);
    expect(parseDaysParam('2.9')).toBe(2);
  });
});

// summariseStats backs the public /stats page MiniPay's listing review reads.
// MAU and retention are set-unions ACROSS days: a wrong figure here is a wrong
// figure in a submission, so pin the arithmetic exactly.
describe('summariseStats — the window-wide figures', () => {
  const SINCE = '2026-07-01T00:00:00.000Z';
  const NOW = Date.parse('2026-07-31T00:00:00.000Z');

  it('counts distinct players across the WHOLE window, not per day', () => {
    const s = summariseStats(
      [
        row({ playerA: '0xa', playerB: '0xb', endedAt: '2026-07-02T10:00:00.000Z' }),
        row({ playerA: '0xa', playerB: '0xc', endedAt: '2026-07-09T10:00:00.000Z' }),
      ],
      SINCE,
      NOW,
    );
    expect(s.activePlayers).toBe(3); // a, b, c — 'a' counted once across two days
    expect(s.games).toBe(2);
  });

  it('stake volume counts BOTH seats, and ignores free games', () => {
    const s = summariseStats(
      [
        row({ stakeCents: 25, endedAt: '2026-07-02T10:00:00.000Z' }),
        row({ stakeCents: 0, endedAt: '2026-07-03T10:00:00.000Z' }),
      ],
      SINCE,
      NOW,
    );
    expect(s.stakedGames).toBe(1);
    expect(s.stakedVolumeCents).toBe(50);
  });

  it('D1 retention counts a player who came back the NEXT day', () => {
    const s = summariseStats(
      [
        row({ playerA: '0xa', playerB: '0xz', endedAt: '2026-07-02T10:00:00.000Z' }),
        row({ playerA: '0xa', playerB: '0xz', endedAt: '2026-07-03T10:00:00.000Z' }),
        row({ playerA: '0xb', playerB: '0xy', endedAt: '2026-07-02T10:00:00.000Z' }),
      ],
      SINCE,
      NOW,
    );
    // a and z came back on day+1; b and y never did → 2 of 4.
    expect(s.retention.d1).toBeCloseTo(0.5, 5);
  });

  it('reports null — never 0% — when no cohort is old enough to have returned', () => {
    const justNow = Date.parse('2026-07-31T00:00:00.000Z');
    const s = summariseStats(
      [row({ playerA: '0xa', playerB: '0xb', endedAt: '2026-07-30T23:00:00.000Z' })],
      SINCE,
      justNow,
    );
    // One hour old: it cannot yet have had a D1 chance. 0% would read as a
    // collapse in a submission; null says "not measurable yet".
    expect(s.retention.d1).toBeNull();
    expect(s.retention.d30).toBeNull();
  });

  it('excludes rows before the window and reports the house-bot share', () => {
    const s = summariseStats(
      [
        row({ endedAt: '2026-06-30T23:59:59.000Z', isHouseBot: true }), // outside
        row({ endedAt: '2026-07-05T10:00:00.000Z', isHouseBot: true }),
        row({ endedAt: '2026-07-06T10:00:00.000Z', isHouseBot: false }),
      ],
      SINCE,
      NOW,
    );
    expect(s.games).toBe(2);
    expect(s.houseBotShare).toBeCloseTo(0.5, 5);
  });

  it('an empty window is all zeroes and unmeasurable retention, not a crash', () => {
    const s = summariseStats([], SINCE, NOW);
    expect(s).toMatchObject({ activePlayers: 0, games: 0, stakedGames: 0, stakedVolumeCents: 0, houseBotShare: 0 });
    expect(s.retention).toEqual({ d1: null, d7: null, d30: null });
  });
});
