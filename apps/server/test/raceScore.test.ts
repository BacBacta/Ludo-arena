import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memory.js';
import { scoreEventGame, raceLeaderboard, DEFAULT_RACE_SCORE, isRaceParticipant } from '../src/raceScore.js';

const DAY = '2026-07-20';
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const C = '0x' + 'c'.repeat(40);

async function participant(store: MemoryStore, w: string): Promise<void> {
  await store.setMeta(`race:grant:${w.toLowerCase()}`, JSON.stringify({ cents: 20 }));
}
// A genuinely-finished game (full scoring); the anti-farm discounts apply only to abandons.
const finish = { reason: 'finish' as const, day: DAY };

describe('Race Week scoring', () => {
  it('scores a win (+3) and participation (+1) only between two participants', async () => {
    const s = new MemoryStore();
    await participant(s, A);
    await participant(s, B);
    const r = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', ...finish });
    expect(r).toEqual({ winnerGained: 3, loserGained: 1 });
    const lb = await raceLeaderboard(s, A);
    expect(lb.top[0]).toMatchObject({ name: 'Ada', points: 3, rank: 1 });
    expect(lb.top[1]).toMatchObject({ name: 'Bo', points: 1, rank: 2 });
    expect(lb.myRank).toBe(1);
    expect(lb.myPoints).toBe(3);
  });

  it('does NOT score when either side is not a Race Week participant', async () => {
    const s = new MemoryStore();
    await participant(s, A); // B never claimed
    const r = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', ...finish });
    expect(r).toEqual({ winnerGained: 0, loserGained: 0 });
    expect((await raceLeaderboard(s, A)).top).toHaveLength(0);
  });

  // ---- anti-farm hardening (launch-audit) ----

  it('an ABANDON-win (opponent resigns/times out) scores the discounted 1, and the thrower gets NO participation', async () => {
    const s = new MemoryStore();
    await participant(s, A);
    await participant(s, B);
    const resign = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', reason: 'resign', day: DAY });
    expect(resign).toEqual({ winnerGained: 1, loserGained: 0 });
    const timeout = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', reason: 'timeout-forfeit', day: DAY });
    expect(timeout).toEqual({ winnerGained: 1, loserGained: 0 });
    // A: two abandon-wins ×1 = 2; B: 0 (threw both, no participation).
    const lb = await raceLeaderboard(s, A);
    expect(lb.myPoints).toBe(2);
    expect((await raceLeaderboard(s, B)).myPoints).toBe(0);
  });

  it('participationRequiresFinish=false restores the participation point on an abandon', async () => {
    const s = new MemoryStore();
    await participant(s, A);
    await participant(s, B);
    const cfg = { ...DEFAULT_RACE_SCORE, participationRequiresFinish: false };
    const r = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', reason: 'resign', day: DAY }, cfg);
    expect(r).toEqual({ winnerGained: 1, loserGained: 1 }); // discounted win, but loser still gets +1
  });

  it('abandonWinPoints=0 makes a thrown game score NOTHING for anyone', async () => {
    const s = new MemoryStore();
    await participant(s, A);
    await participant(s, B);
    const cfg = { ...DEFAULT_RACE_SCORE, abandonWinPoints: 0 };
    const r = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', reason: 'timeout-forfeit', day: DAY }, cfg);
    expect(r).toEqual({ winnerGained: 0, loserGained: 0 });
    expect((await raceLeaderboard(s, A)).top).toHaveLength(0);
  });

  it('by DEFAULT caps at 2 finished wins vs the SAME opponent per day, then stops scoring', async () => {
    const s = new MemoryStore();
    await participant(s, A);
    await participant(s, B);
    for (let i = 0; i < 2; i++) {
      const r = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', ...finish });
      expect(r.winnerGained).toBe(3); // first 2 score
    }
    const third = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', ...finish });
    expect(third.winnerGained).toBe(0); // 3rd vs B no longer scores
    // A CAN still score against a DIFFERENT opponent (total is uncapped).
    await participant(s, C);
    const vsC = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: C, loserName: 'Cy', ...finish });
    expect(vsC.winnerGained).toBe(3);
    // …and the per-opponent cap resets on a new day.
    const nextDay = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', reason: 'finish', day: '2026-07-21' });
    expect(nextDay.winnerGained).toBe(3);
    expect((await raceLeaderboard(s, A)).myPoints).toBe(2 * 3 + 3 + 3); // 2 vs B + 1 vs C + 1 next-day vs B
  });

  it('0 = unlimited per-opponent cap when explicitly configured', async () => {
    const s = new MemoryStore();
    await participant(s, A);
    await participant(s, B);
    const cfg = { ...DEFAULT_RACE_SCORE, maxVsSamePerDay: 0 };
    for (let i = 0; i < 8; i++) {
      const r = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', ...finish }, cfg);
      expect(r.winnerGained).toBe(3);
    }
  });

  it('leaderboard sorts by points desc and reports rank; unknown wallet = rank 0', async () => {
    const s = new MemoryStore();
    for (const w of [A, B, C]) await participant(s, w);
    // A beats B twice (finish), C beats A once → A:6, C:3, B:2 participation
    await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', ...finish });
    await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', ...finish });
    await scoreEventGame(s, { winnerWallet: C, winnerName: 'Cy', loserWallet: A, loserName: 'Ada', ...finish });
    const lb = await raceLeaderboard(s, B);
    expect(lb.top.map((e) => e.name)).toEqual(['Ada', 'Cy', 'Bo']);
    expect(lb.top.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(lb.myRank).toBe(3); // B
    const unknown = await raceLeaderboard(s, '0x' + 'd'.repeat(40));
    expect(unknown.myRank).toBe(0);
    expect(unknown.myPoints).toBe(0);
  });

  it('isRaceParticipant reflects a claimed grant', async () => {
    const s = new MemoryStore();
    expect(await isRaceParticipant(s, A)).toBe(false);
    await participant(s, A);
    expect(await isRaceParticipant(s, A)).toBe(true);
  });
});
