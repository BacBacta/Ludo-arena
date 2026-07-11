import { describe, expect, it, afterEach } from 'vitest';
import { MemoryStore } from '../src/store/memory.js';
import { PersistentStore } from '../src/store/persistent.js';
import { playerId, type SessionRecord, type Store } from '../src/store/types.js';
import { Room, type Client } from '../src/room.js';
import { createFairness } from '../src/fairness.js';
import type { ServerMsg } from '@ludo/shared';

function makeClient(id: string): Client & { inbox: ServerMsg[] } {
  const inbox: ServerMsg[] = [];
  return {
    id,
    name: 'P' + id,
    flag: '🌍',
    elo: 1200,
    inbox,
    send(msg: ServerMsg) {
      inbox.push(msg);
    },
  };
}

const sessionRec: SessionRecord = {
  id: 'tok1',
  wallet: '0xAbC',
  entropy: 'e'.repeat(16),
  name: 'Kwame',
  flag: '🇨🇲',
  elo: 1234,
  stake: 25,
  gameId: 'g1',
  seat: 0,
};

function storeContract(name: string, make: () => Store, cleanup?: () => Promise<void>): void {
  describe(name, () => {
    afterEach(async () => {
      await cleanup?.();
    });

    it('round-trips sessions', async () => {
      const store = make();
      await store.init();
      await store.saveSession(sessionRec);
      expect(await store.loadSession('tok1')).toEqual(sessionRec);
      await store.deleteSession('tok1');
      expect(await store.loadSession('tok1')).toBeNull();
      await store.close();
    });

    it('round-trips room snapshots and lists them', async () => {
      const store = make();
      await store.init();
      const room = new Room('g1', 25, makeClient('a'), makeClient('b'), createFairness('x'.repeat(16), 'y'.repeat(16)));
      const snap = room.toSnapshot();
      await store.saveRoom(snap);
      expect(await store.loadRooms()).toEqual([snap]);
      await store.deleteRoom('g1');
      expect(await store.loadRooms()).toEqual([]);
      await store.close();
    });

    it('keeps ELO across getOrCreatePlayer calls', async () => {
      const store = make();
      await store.init();
      // unique wallet per run: the durable store keeps rows across test runs
      const wallet = '0xAbC' + Math.random().toString(16).slice(2, 10);
      const id = playerId(wallet, 's1');
      expect(id).toBe(wallet.toLowerCase());
      const first = await store.getOrCreatePlayer(id, { wallet, name: 'K', flag: '🇨🇲' });
      expect(first.elo).toBe(1200);
      await store.updateElo(id, 1250);
      const second = await store.getOrCreatePlayer(id, { wallet, name: 'K', flag: '🇨🇲' });
      expect(second.elo).toBe(1250);
      await store.getOrCreatePlayer('anon:s2', { name: 'A', flag: '🌍' });
      await store.recordGame({
        gameId: 'test-' + Math.random().toString(16).slice(2, 10),
        stakeCents: 25,
        playerA: id,
        playerB: 'anon:s2',
        winnerSeat: 0,
        reason: 'finish',
        payoutCents: 45,
        rakeCents: 5,
        eloDelta: 16,
        fairnessCommit: 'c'.repeat(64),
        serverSeed: 's'.repeat(64),
      });
      await store.close();
    });

    it('clears queues', async () => {
      const store = make();
      await store.init();
      await store.queuePush(25, 's1');
      await store.queuePush(25, 's2');
      await store.queueRemove('s1');
      await store.queueClear();
      await store.close();
    });

    it('tracks daily-challenge captures, awards a ticket, resets next day', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 10);
      await store.getOrCreatePlayer(id, { name: 'C', flag: '🌍' });
      const day1 = '2026-07-11';
      const day2 = '2026-07-12';

      expect(await store.getChallenge(id, day1)).toMatchObject({ progress: 0, target: 3, completed: false, tickets: 0 });

      const c1 = await store.addCapture(id, day1);
      expect(c1).toMatchObject({ progress: 1, completed: false, tickets: 0 });
      await store.addCapture(id, day1);
      const c3 = await store.addCapture(id, day1); // third capture completes
      expect(c3).toMatchObject({ progress: 3, completed: true, tickets: 1 });

      // extra captures the same day: no double ticket
      const c4 = await store.addCapture(id, day1);
      expect(c4).toMatchObject({ progress: 4, completed: true, tickets: 1 });
      expect(await store.getChallenge(id, day1)).toMatchObject({ progress: 4, completed: true, tickets: 1 });

      // new day resets progress but keeps the ticket
      expect(await store.getChallenge(id, day2)).toMatchObject({ progress: 0, completed: false, tickets: 1 });
      const d2 = await store.addCapture(id, day2);
      expect(d2).toMatchObject({ progress: 1, completed: false, tickets: 1 });

      await store.close();
    });

    it('tracks a login streak, rewards D3/D7, resets on a gap', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 10);
      await store.getOrCreatePlayer(id, { name: 'S', flag: '🌍' });

      // consecutive days 1..3 → ticket at D3
      expect(await store.recordLogin(id, '2026-07-01', '2026-06-30')).toMatchObject({ days: 1, rewardGranted: 0, tickets: 0 });
      // same day again: no change
      expect(await store.recordLogin(id, '2026-07-01', '2026-06-30')).toMatchObject({ days: 1, rewardGranted: 0 });
      expect(await store.recordLogin(id, '2026-07-02', '2026-07-01')).toMatchObject({ days: 2, rewardGranted: 0 });
      const d3 = await store.recordLogin(id, '2026-07-03', '2026-07-02');
      expect(d3).toMatchObject({ days: 3, rewardGranted: 1, tickets: 1 });

      // a gap resets the streak to 1 (keeps tickets)
      const gap = await store.recordLogin(id, '2026-07-10', '2026-07-09');
      expect(gap).toMatchObject({ days: 1, rewardGranted: 0, tickets: 1 });

      await store.close();
    });

    it('rewards a 7-day streak with +2 tickets', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 10);
      await store.getOrCreatePlayer(id, { name: 'S', flag: '🌍' });
      const days = ['08-01', '08-02', '08-03', '08-04', '08-05', '08-06', '08-07'].map((d) => `2026-${d}`);
      let last: Awaited<ReturnType<typeof store.recordLogin>> | undefined;
      for (let i = 0; i < days.length; i++) {
        const prev = i === 0 ? '2026-07-31' : days[i - 1]!;
        last = await store.recordLogin(id, days[i]!, prev);
      }
      // D3 gave +1, D7 gave +2 → 3 tickets total, streak 7
      expect(last).toMatchObject({ days: 7, rewardGranted: 2, tickets: 3 });

      await store.close();
    });

    it('awards league points, ranks within a division, and rolls over promote/relegate', async () => {
      const store = make();
      await store.init();
      const tag = Math.random().toString(16).slice(2, 8);
      const ids = ['p1', 'p2', 'p3', 'p4', 'p5'].map((n) => `anon:${tag}-${n}`);
      for (const id of ids) await store.getOrCreatePlayer(id, { name: id.slice(-2), flag: '🌍' });

      // distinct weekly points in Silver (default division 1)
      const pts = [50, 40, 30, 20, 10];
      let leadState = await store.addLeaguePoints(ids[0]!, pts[0]!);
      for (let i = 1; i < ids.length; i++) leadState = await store.addLeaguePoints(ids[i]!, pts[i]!);

      const top = await store.getLeague(ids[0]!);
      expect(top).toMatchObject({ division: 1, points: 50, rank: 1 });
      expect(top.top[0]).toMatchObject({ points: 50 });
      // leaderboard is descending
      expect(top.top.map((e) => e.points)).toEqual([...top.top.map((e) => e.points)].sort((a, b) => b - a));

      const mid = await store.getLeague(ids[2]!); // 30 pts → 2 players ahead
      expect(mid).toMatchObject({ points: 30, rank: 3 });

      const { promoted, relegated } = await store.rolloverLeagues();
      // top 3 promote to Gold(2); bottom 3 relegate but the middle (p3) is
      // already promoted → only p4,p5 relegate to Bronze(0)
      expect(promoted).toBe(3);
      expect(relegated).toBe(2);
      expect((await store.getLeague(ids[0]!)).division).toBe(2);
      expect((await store.getLeague(ids[2]!)).division).toBe(2);
      expect((await store.getLeague(ids[4]!)).division).toBe(0);
      // points reset after rollover
      expect((await store.getLeague(ids[0]!)).points).toBe(0);

      await store.close();
    });

    it('cashes back 20% of rake after 3 staked losses, resets on a win', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 8);
      await store.getOrCreatePlayer(id, { name: 'T', flag: '🌍' });

      // rake 4 cents per staked loss (25c stake game)
      expect(await store.applyAntiTilt(id, false, 4)).toMatchObject({ cents: 0, totalCents: 0 });
      expect(await store.applyAntiTilt(id, false, 4)).toMatchObject({ cents: 0, totalCents: 0 });
      // 3rd loss: 20% of 12 = round(2.4) = 2 cents cashback
      expect(await store.applyAntiTilt(id, false, 4)).toMatchObject({ cents: 2, totalCents: 2 });
      expect(await store.getCashback(id)).toBe(2);

      // streak reset after the grant: two more losses don't trigger again
      await store.applyAntiTilt(id, false, 4);
      await store.applyAntiTilt(id, false, 4);
      expect(await store.getCashback(id)).toBe(2);

      // a win resets the accumulated rake, so the count starts over
      expect(await store.applyAntiTilt(id, true, 0)).toMatchObject({ cents: 0, totalCents: 2 });
      await store.applyAntiTilt(id, false, 10);
      await store.applyAntiTilt(id, false, 10);
      const third = await store.applyAntiTilt(id, false, 10); // 20% of 30 = 6
      expect(third).toMatchObject({ cents: 6, totalCents: 8 });

      await store.close();
    });

    it('tracks daily stake, resets next day, and honours self-exclusion (E5.2)', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 8);
      await store.getOrCreatePlayer(id, { name: 'L', flag: '🌍' });
      const d1 = '2026-08-10';
      const d2 = '2026-08-11';

      expect(await store.getLimits(id, d1)).toMatchObject({ dailyLimitCents: 200, stakedTodayCents: 0, selfExcludedUntil: null });

      await store.addDailyStake(id, d1, 100);
      await store.addDailyStake(id, d1, 50);
      expect(await store.getLimits(id, d1)).toMatchObject({ stakedTodayCents: 150 });
      // next day resets the daily total
      expect(await store.getLimits(id, d2)).toMatchObject({ stakedTodayCents: 0 });

      // lower the daily limit
      await store.setLimits(id, { dailyLimitCents: 50 });
      expect((await store.getLimits(id, d2)).dailyLimitCents).toBe(50);

      // self-exclude until d2; on d1 it's active, after d2 it has expired
      await store.setLimits(id, { selfExcludedUntil: d2 });
      expect((await store.getLimits(id, d1)).selfExcludedUntil).toBe(d2);
      expect((await store.getLimits(id, '2026-08-12')).selfExcludedUntil).toBeNull();

      await store.close();
    });

    it('meta key/value round-trips', async () => {
      const store = make();
      await store.init();
      expect(await store.getMeta('leagueWeek')).toBeDefined();
      await store.setMeta('leagueWeek', '2026-W28');
      expect(await store.getMeta('leagueWeek')).toBe('2026-W28');
      await store.setMeta('leagueWeek', '2026-W29');
      expect(await store.getMeta('leagueWeek')).toBe('2026-W29');
      await store.close();
    });
  });
}

storeContract('MemoryStore', () => new MemoryStore());

const REDIS_URL = process.env.REDIS_URL;
const DATABASE_URL = process.env.DATABASE_URL;
if (REDIS_URL && DATABASE_URL) {
  storeContract(
    'PersistentStore',
    () => new PersistentStore(REDIS_URL, DATABASE_URL),
    async () => {
      const store = new PersistentStore(REDIS_URL, DATABASE_URL);
      await store.init();
      await store.deleteSession('tok1');
      await store.deleteRoom('g1');
      await store.queueClear();
      await store.close();
    },
  );
} else {
  describe.skip('PersistentStore (set REDIS_URL + DATABASE_URL to run)', () => {
    it('skipped', () => {});
  });
}

describe('Room snapshot/restore', () => {
  it('restores state, dice index and streaks; the game continues identically', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    const room = new Room('g2', 25, a, b, createFairness('x'.repeat(16), 'y'.repeat(16)));
    room.start();
    // play a few turns deterministically (commit-reveal dice are reproducible)
    for (let i = 0; i < 6 && !room.isOver(); i++) {
      const st = room.getState();
      if (st.phase === 'awaiting-roll') room.roll(st.turn);
      else if (st.phase === 'awaiting-move' && st.legal.length > 0) room.move(st.turn, st.legal[0]!);
    }
    const snap = room.toSnapshot();
    room.suspend();

    const a2 = makeClient('a');
    const b2 = makeClient('b');
    const restored = Room.fromSnapshot(JSON.parse(JSON.stringify(snap)), a2, b2);
    expect(restored.getState()).toEqual(room.getState());
    expect(restored.toSnapshot()).toEqual(snap);

    // same fairness seed + same dice index -> the next roll matches on both rooms
    if (!room.isOver() && room.getState().phase === 'awaiting-roll') {
      const turn = room.getState().turn;
      room.roll(turn);
      restored.roll(turn);
      expect(restored.getState()).toEqual(room.getState());
    }
    room.suspend();
    restored.suspend();
  });

  it('attach resyncs a reconnecting client with state and turn deadline', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    const room = new Room('g3', 0, a, b, createFairness('x'.repeat(16), 'y'.repeat(16)));
    room.start();
    const late = makeClient('a');
    room.attach(0, late);
    const types = late.inbox.map((m) => m.t);
    expect(types).toEqual(['game.state', 'game.turn']);
    room.suspend();
  });

  it('fires onChange on every transition and onResult once at the end', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    const room = new Room('g4', 25, a, b, createFairness('x'.repeat(16), 'y'.repeat(16)));
    let changes = 0;
    let results = 0;
    room.onChange = () => changes++;
    room.onResult = (r) => {
      results++;
      expect(r.gameId).toBe('g4');
      expect(r.payoutCents + r.rakeCents).toBe(50);
    };
    room.start();
    expect(changes).toBeGreaterThan(0);
    room.resign(1);
    expect(results).toBe(1);
    expect(room.isOver()).toBe(true);
    room.suspend();
  });
});
