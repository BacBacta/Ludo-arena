import { describe, expect, it } from 'vitest';
import { aggregateDailyStats, parseDaysParam } from '../src/stats.js';
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
