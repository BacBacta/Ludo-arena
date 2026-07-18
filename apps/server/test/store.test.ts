import { describe, expect, it, afterEach } from 'vitest';
import { MemoryStore } from '../src/store/memory.js';
import { PersistentStore } from '../src/store/persistent.js';
import { playerId, type SessionRecord, type Store } from '../src/store/types.js';
import { Room, type Client } from '../src/room.js';
import { createFairness } from '../src/fairness.js';
import { ANTI_TILT, DEFAULT_DAILY_STAKE_LIMIT_CENTS, SEASON, STREAK_FREEZE, crownsForTier, type ServerMsg } from '@ludo/shared';

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

    it('hasSettlement reflects any settlement record (R-SETTLE-2 boot reconcile)', async () => {
      const store = make();
      await store.init();
      expect(await store.hasSettlement('gS')).toBe(false); // nothing enqueued yet
      await store.enqueueSettlement({ gameId: 'gS', winnerWallet: '0xabc', chainId: 11_142_220, status: 'pending', attempts: 0, variant: '2p' });
      expect(await store.hasSettlement('gS')).toBe(true);
      // still true once resolved (rows are marked, never deleted) → no false re-enqueue
      await store.markSettlement('gS', 'settled', 1, '0xtx');
      expect(await store.hasSettlement('gS')).toBe(true);
      expect(await store.hasSettlement('other')).toBe(false);
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

    it('bridges a one-day gap with a streak-freeze, resets on a bigger gap', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 10);
      await store.getOrCreatePlayer(id, { name: 'F', flag: '🌍' });

      // build a streak to day 2, then MISS one day (login on the 4th)
      await store.recordLogin(id, '2026-09-01', '2026-08-31', '2026-08-30');
      await store.recordLogin(id, '2026-09-02', '2026-09-01', '2026-08-31');
      // no freeze yet → the missed day resets the streak
      const noFreeze = await store.recordLogin(id, '2026-09-04', '2026-09-03', '2026-09-02');
      expect(noFreeze).toMatchObject({ days: 1, freezeUsed: false, daysAway: 2 });

      // grant a freeze, rebuild to day 2, miss a day → the freeze BRIDGES it
      expect(await store.grantStreakFreeze(id, 1)).toBe(1);
      await store.recordLogin(id, '2026-09-05', '2026-09-04', '2026-09-03');
      const bridged = await store.recordLogin(id, '2026-09-07', '2026-09-06', '2026-09-05');
      expect(bridged).toMatchObject({ days: 3, freezeUsed: true, freezes: 0 });

      // a TWO-day gap (missed two days) is too big for one freeze → reset
      await store.grantStreakFreeze(id, 1);
      const tooBig = await store.recordLogin(id, '2026-09-11', '2026-09-10', '2026-09-09');
      expect(tooBig).toMatchObject({ days: 1, freezeUsed: false, daysAway: 4 });

      await store.close();
    });

    it('buys streak-freezes with tickets, caps the inventory, refuses when broke', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 10);
      await store.getOrCreatePlayer(id, { name: 'B', flag: '🌍' });

      expect(await store.buyStreakFreeze(id)).toMatchObject({ ok: false, reason: 'insufficient' });
      await store.grantTickets(id, 100);
      const b1 = await store.buyStreakFreeze(id);
      expect(b1).toMatchObject({ ok: true, freezes: 1, tickets: 100 - STREAK_FREEZE.ticketCost });
      // buy up to the cap, then refuse as 'capped'
      while ((await store.getStreakFreezes(id)) < STREAK_FREEZE.max) await store.buyStreakFreeze(id);
      expect(await store.getStreakFreezes(id)).toBe(STREAK_FREEZE.max);
      expect(await store.buyStreakFreeze(id)).toMatchObject({ ok: false, reason: 'capped' });

      await store.close();
    });

    it('grantStreakFreeze never exceeds the cap', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 10);
      await store.getOrCreatePlayer(id, { name: 'G', flag: '🌍' });
      expect(await store.grantStreakFreeze(id, STREAK_FREEZE.max + 5)).toBe(STREAK_FREEZE.max);
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
      await store.addLeaguePoints(ids[0]!, pts[0]!);
      for (let i = 1; i < ids.length; i++) await store.addLeaguePoints(ids[i]!, pts[i]!);

      const top = await store.getLeague(ids[0]!);
      expect(top).toMatchObject({ division: 1, points: 50, rank: 1 });
      expect(top.top[0]).toMatchObject({ points: 50 });
      // leaderboard is descending
      expect(top.top.map((e) => e.points)).toEqual([...top.top.map((e) => e.points)].sort((a, b) => b - a));

      const mid = await store.getLeague(ids[2]!); // 30 pts → 2 players ahead
      expect(mid).toMatchObject({ points: 30, rank: 3 });

      const { promoted, relegated, ticketsAwarded } = await store.rolloverLeagues();
      // top 3 promote to Gold(2); bottom 3 relegate but the middle (p3) is
      // already promoted → only p4,p5 relegate to Bronze(0)
      expect(promoted).toBe(3);
      expect(relegated).toBe(2);
      expect((await store.getLeague(ids[0]!)).division).toBe(2);
      expect((await store.getLeague(ids[2]!)).division).toBe(2);
      expect((await store.getLeague(ids[4]!)).division).toBe(0);
      // points reset after rollover
      expect((await store.getLeague(ids[0]!)).points).toBe(0);
      // reward: top-3 of Silver (div 1) each got division+1 = 2 tickets = 6 total
      expect(ticketsAwarded).toBe(6);
      expect((await store.getChallenge(ids[0]!, '2026-08-10')).tickets).toBe(2); // a top-3 finisher
      expect((await store.getChallenge(ids[4]!, '2026-08-10')).tickets).toBe(0); // bottom finisher: none

      await store.close();
    });

    it('grants a freeroll ticket after 3 staked losses, resets on a win', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 8);
      await store.getOrCreatePlayer(id, { name: 'T', flag: '🌍' });

      expect(await store.applyAntiTilt(id, false)).toMatchObject({ grantedTickets: 0, totalTickets: 0 });
      expect(await store.applyAntiTilt(id, false)).toMatchObject({ grantedTickets: 0, totalTickets: 0 });
      // 3rd straight loss: +1 ticket, streak resets
      expect(await store.applyAntiTilt(id, false)).toMatchObject({ grantedTickets: 1, totalTickets: 1 });

      // streak reset after the grant: two more losses don't trigger again
      await store.applyAntiTilt(id, false);
      await store.applyAntiTilt(id, false);
      // a win resets the streak, so the count starts over
      expect(await store.applyAntiTilt(id, true)).toMatchObject({ grantedTickets: 0, totalTickets: 1 });
      await store.applyAntiTilt(id, false);
      await store.applyAntiTilt(id, false);
      expect(await store.applyAntiTilt(id, false)).toMatchObject({ grantedTickets: 1, totalTickets: 2 });

      await store.close();
    });

    it('anti-tilt reward is non-cash: a spendable ticket, never a cUSD balance (rec 4)', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 8);
      await store.getOrCreatePlayer(id, { name: 'A', flag: '🌍' });

      // three straight staked losses grant exactly ANTI_TILT.rewardTickets…
      await store.applyAntiTilt(id, false);
      await store.applyAntiTilt(id, false);
      const grant = await store.applyAntiTilt(id, false);
      expect(grant.grantedTickets).toBe(ANTI_TILT.rewardTickets);
      // …denominated in TICKETS only. The payload carries no cash/cents field, so
      // the loss-forgiveness bonus can never become an unbacked cUSD liability —
      // the invariant that keeps the model's payouts fully escrow-backed.
      expect(Object.keys(grant).sort()).toEqual(['grantedTickets', 'totalTickets']);
      // and the granted ticket is a REAL spendable balance (a funded sink), not a
      // phantom: it spends down to zero and can't be over-spent.
      expect(await store.spendTickets(id, ANTI_TILT.rewardTickets)).toBe(0);
      expect(await store.spendTickets(id, 1)).toBeNull();

      await store.close();
    });

    it('grants and atomically spends freeroll tickets', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 8);
      await store.getOrCreatePlayer(id, { name: 'S', flag: '🌍' });

      expect(await store.spendTickets(id, 1)).toBeNull(); // nothing to spend
      expect(await store.grantTickets(id, 3)).toBe(3);
      expect(await store.spendTickets(id, 1)).toBe(2);
      expect(await store.spendTickets(id, 2)).toBe(0);
      expect(await store.spendTickets(id, 1)).toBeNull(); // insufficient again
      // tickets surface in the challenge state shown to the client
      expect((await store.getChallenge(id, '2026-08-10')).tickets).toBe(0);

      await store.close();
    });

    it('records premium-skin ownership idempotently', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 8);
      await store.getOrCreatePlayer(id, { name: 'K', flag: '🌍' });

      expect(await store.getOwnedSkins(id)).toEqual([]);
      expect(await store.ownSkin(id, 'obsidian')).toEqual(['obsidian']);
      // idempotent: owning the same skin twice doesn't duplicate it
      expect(await store.ownSkin(id, 'obsidian')).toEqual(['obsidian']);
      const owned = await store.ownSkin(id, 'aurora');
      expect(owned.sort()).toEqual(['aurora', 'obsidian']);
      expect((await store.getOwnedSkins(id)).sort()).toEqual(['aurora', 'obsidian']);

      await store.close();
    });

    it('tracks daily stake, resets next day, and honours self-exclusion (E5.2)', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 8);
      await store.getOrCreatePlayer(id, { name: 'L', flag: '🌍' });
      const d1 = '2026-08-10';
      const d2 = '2026-08-11';

      expect(await store.getLimits(id, d1)).toMatchObject({ dailyLimitCents: DEFAULT_DAILY_STAKE_LIMIT_CENTS, stakedTodayCents: 0, selfExcludedUntil: null });

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

    it('counts staked games per opponent pair, canonically, per day (E5.3)', async () => {
      const store = make();
      await store.init();
      const a = '0xaaa' + Math.random().toString(16).slice(2, 6);
      const b = '0xbbb' + Math.random().toString(16).slice(2, 6);
      const day = '2026-09-01';

      expect(await store.pairGamesToday(a, b, day)).toBe(0);
      await store.bumpPairGame(a, b, day);
      await store.bumpPairGame(b, a, day); // order-independent
      expect(await store.pairGamesToday(a, b, day)).toBe(2);
      expect(await store.pairGamesToday(b, a, day)).toBe(2);
      // different day is separate
      expect(await store.pairGamesToday(a, b, '2026-09-02')).toBe(0);

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

    it('accrues season crowns, tracks daily games, and derives the tier', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 8);
      await store.getOrCreatePlayer(id, { name: 'C', flag: '🌍' });
      const now = '2026-07-18T00:00:00.000Z';
      const day1 = '2026-07-18';
      const day2 = '2026-07-19';

      // the season is global + durable, so its id is whatever the store is on
      // (fresh in-memory = 1; a durable Postgres may carry a later season) — assert
      // the invariants (a 28-day window, fresh per-player progress), not the number.
      const season = await store.getSeason(now);
      expect(season.id).toBeGreaterThanOrEqual(1);
      if (season.id === 1) {
        expect(new Date(season.endsAt).getTime() - new Date(season.startsAt).getTime())
          .toBe(SEASON.durationDays * 86_400_000);
      }

      // fresh progress: no crowns, tier 0, nothing claimed
      const p0 = await store.getSeasonProgress(id);
      expect(p0).toMatchObject({ seasonId: season.id, crowns: 0, premium: false, dailyGames: 0 });
      expect(p0.claimedFree).toEqual([]);

      // enough crowns to cross tier 1 (frontCost) with the daily counter incrementing
      const a1 = await store.addCrowns(id, crownsForTier(1), day1);
      expect(a1).toMatchObject({ crowns: crownsForTier(1), dailyGames: 1 });
      const a2 = await store.addCrowns(id, 0, day1);
      expect(a2.dailyGames).toBe(2);
      // new day resets the daily counter but keeps crowns
      const a3 = await store.addCrowns(id, 0, day2);
      expect(a3).toMatchObject({ crowns: crownsForTier(1), dailyGames: 1 });

      await store.close();
    });

    it('claims tiers idempotently per lane and toggles premium', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 8);
      await store.getOrCreatePlayer(id, { name: 'K', flag: '🌍' });

      expect(await store.claimSeasonTier(id, 1, 'free')).toBe(true);
      expect(await store.claimSeasonTier(id, 1, 'free')).toBe(false); // already claimed
      expect(await store.claimSeasonTier(id, 1, 'premium')).toBe(true); // separate lane
      expect(await store.claimSeasonTier(id, 2, 'free')).toBe(true);

      const p = await store.getSeasonProgress(id);
      expect([...p.claimedFree].sort((a, b) => a - b)).toEqual([1, 2]);
      expect(p.claimedPrem).toEqual([1]);

      expect(p.premium).toBe(false);
      await store.setSeasonPremium(id);
      await store.setSeasonCrownBoost(id, 1.25);
      const p2 = await store.getSeasonProgress(id);
      expect(p2).toMatchObject({ premium: true, crownBoost: 1.25 });

      await store.close();
    });

    it('consumes a premium-purchase tx hash exactly once (no cross-season replay)', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 8);
      await store.getOrCreatePlayer(id, { name: 'P', flag: '🌍' });
      const tx = '0x' + Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64);

      expect(await store.consumePremiumTx(tx, id, 1)).toBe(true); // first use unlocks
      expect(await store.consumePremiumTx(tx, id, 1)).toBe(false); // replay same season
      expect(await store.consumePremiumTx(tx, id, 2)).toBe(false); // replay a LATER season
      // case-insensitive (tx hashes may arrive mixed-case)
      expect(await store.consumePremiumTx(tx.toUpperCase(), id, 2)).toBe(false);
      // a different tx is independent
      const tx2 = '0x' + Math.random().toString(16).slice(2).padEnd(64, '1').slice(0, 64);
      expect(await store.consumePremiumTx(tx2, id, 1)).toBe(true);

      await store.close();
    });

    it('rolls the season over only past its end, resetting per-player progress', async () => {
      const store = make();
      await store.init();
      const id = 'anon:' + Math.random().toString(16).slice(2, 8);
      await store.getOrCreatePlayer(id, { name: 'R', flag: '🌍' });
      const start = '2026-07-18T00:00:00.000Z';
      const s1 = await store.getSeason(start);
      await store.addCrowns(id, 100, '2026-07-18');
      await store.setSeasonPremium(id);

      // before the end: no rollover
      const mid = new Date(new Date(s1.endsAt).getTime() - 1000).toISOString();
      expect(await store.rolloverSeason(mid)).toBe(false);
      expect((await store.getSeasonProgress(id)).crowns).toBe(100);

      // past the end: rolls to the next season, progress resets to fresh
      const after = new Date(new Date(s1.endsAt).getTime() + 1000).toISOString();
      expect(await store.rolloverSeason(after)).toBe(true);
      const s2 = await store.getSeason(after);
      expect(s2.id).toBe(s1.id + 1);
      const fresh = await store.getSeasonProgress(id);
      expect(fresh).toMatchObject({ seasonId: s2.id, crowns: 0, premium: false });

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
