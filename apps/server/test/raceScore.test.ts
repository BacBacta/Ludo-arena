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

describe('Race Week scoring', () => {
  it('scores a win (+3) and participation (+1) only between two participants', async () => {
    const s = new MemoryStore();
    await participant(s, A);
    await participant(s, B);
    const r = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', day: DAY });
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
    const r = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', day: DAY });
    expect(r).toEqual({ winnerGained: 0, loserGained: 0 });
    expect((await raceLeaderboard(s, A)).top).toHaveLength(0);
  });

  it('by DEFAULT is UNLIMITED — every repeat win vs the same opponent scores', async () => {
    const s = new MemoryStore();
    await participant(s, A);
    await participant(s, B);
    for (let i = 0; i < 10; i++) {
      const r = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', day: DAY });
      expect(r.winnerGained).toBe(3); // no cap by default
    }
    expect((await raceLeaderboard(s, A)).myPoints).toBe(30);
  });

  it('re-arms the per-opponent cap when configured (env opt-in)', async () => {
    const s = new MemoryStore();
    await participant(s, A);
    await participant(s, B);
    const cfg = { ...DEFAULT_RACE_SCORE, maxVsSamePerDay: 3 };
    for (let i = 0; i < 3; i++) {
      const r = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', day: DAY }, cfg);
      expect(r.winnerGained).toBe(3);
    }
    // The 4th win vs B no longer scores for A.
    const over = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', day: DAY }, cfg);
    expect(over.winnerGained).toBe(0);
    // A CAN still score against a DIFFERENT opponent.
    await participant(s, C);
    const vsC = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: C, loserName: 'Cy', day: DAY }, cfg);
    expect(vsC.winnerGained).toBe(3);
    // …and the cap resets on a new day.
    const nextDay = await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', day: '2026-07-21' }, cfg);
    expect(nextDay.winnerGained).toBe(3);
  });

  it('leaderboard sorts by points desc and reports rank; unknown wallet = rank 0', async () => {
    const s = new MemoryStore();
    for (const w of [A, B, C]) await participant(s, w);
    // A beats B twice, C beats A once → A:6, C:3, B:1(+1+1 participation)
    await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', day: DAY });
    await scoreEventGame(s, { winnerWallet: A, winnerName: 'Ada', loserWallet: B, loserName: 'Bo', day: DAY });
    await scoreEventGame(s, { winnerWallet: C, winnerName: 'Cy', loserWallet: A, loserName: 'Ada', day: DAY });
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
