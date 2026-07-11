import { describe, expect, it } from 'vitest';
import { isoWeek, leaguePointsForWin, DIVISIONS, DEFAULT_DIVISION } from '@ludo/shared';

describe('isoWeek', () => {
  it('is stable within a week and rolls at the Monday boundary (UTC)', () => {
    // 2026-07-06 is a Monday
    expect(isoWeek(new Date('2026-07-06T00:00:00Z'))).toBe(isoWeek(new Date('2026-07-12T23:59:59Z')));
    expect(isoWeek(new Date('2026-07-12T23:59:59Z'))).not.toBe(isoWeek(new Date('2026-07-13T00:00:00Z')));
  });

  it('formats as YYYY-Www', () => {
    expect(isoWeek(new Date('2026-07-08T12:00:00Z'))).toMatch(/^2026-W\d{2}$/);
  });
});

describe('leaguePointsForWin', () => {
  it('is a base plus a stake bonus', () => {
    expect(leaguePointsForWin(0)).toBe(10);
    expect(leaguePointsForWin(25)).toBe(12);
    expect(leaguePointsForWin(100)).toBe(18);
  });
});

describe('config', () => {
  it('Silver is the default division and exists', () => {
    expect(DIVISIONS[DEFAULT_DIVISION]).toBe('Silver');
  });
});
