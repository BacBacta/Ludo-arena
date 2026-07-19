/**
 * In-memory Store: dev fallback when REDIS_URL/DATABASE_URL are not set.
 * Same semantics as PersistentStore within one process lifetime — by design
 * it does NOT survive a restart (see AGENTS.md / BACKLOG E2.1).
 */
import { pidFor } from './types.js';
import type { BuyFreezeResult, GameRecord, Room4Snapshot, RoomSnapshot, SeasonMeta, SeasonProgress, SessionRecord, SettlementJob, Store } from './types.js';
import {
  ANTI_TILT,
  DAILY_CHALLENGE,
  SEASON,
  STREAK_FREEZE,
  DEFAULT_DAILY_STAKE_LIMIT_CENTS,
  DEFAULT_DIVISION,
  DIVISIONS,
  LEAGUE_PROMOTE,
  LEAGUE_RELEGATE,
  LEAGUE_REWARD_TOP,
  leagueRewardTickets,
  STREAK_REWARDS,
  type ChallengeState,
  type LeaderboardEntry,
  type LeagueState,
  type LimitsState,
  type StakeCents,
  type StreakState,
} from '@ludo/shared';

const LEADERBOARD_TOP = 5;

interface PlayerRow {
  wallet?: string;
  name: string;
  flag: string;
  elo: number;
  gamesPlayed: number;
  wins: number;
  frame: string;
  avatar: string;
  challengeDate?: string;
  captures: number;
  done: boolean;
  tickets: number;
  lastLogin?: string;
  streakDays: number;
  streakFreezes: number;
  division: number;
  weeklyPoints: number;
  lossStreak: number;
  lostRakeCents: number;
  cashbackCents: number;
  ownedSkins: string[];
  claimedSets: string[];
  stakeDate?: string;
  stakedTodayCents: number;
  dailyLimitCents: number;
  selfExcludedUntil?: string | null;
}

export class MemoryStore implements Store {
  private sessions = new Map<string, SessionRecord>();
  private rooms = new Map<string, RoomSnapshot>();
  private rooms4 = new Map<string, Room4Snapshot>();
  private queues = new Map<StakeCents, string[]>();
  private players = new Map<string, PlayerRow>();
  private games = new Map<string, GameRecord>();
  private settlements = new Map<string, SettlementJob>();
  private meta = new Map<string, string>();
  private season: SeasonMeta | null = null;
  private seasonProg = new Map<string, SeasonProgress>();
  private premiumTx = new Set<string>();
  private pairGames = new Map<string, number>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  /** In-memory settlement/records are lost on restart → not safe for real stakes. */
  settlementDurable(): boolean {
    return false;
  }

  async saveSession(rec: SessionRecord): Promise<void> {
    this.sessions.set(rec.id, structuredClone(rec));
  }
  async loadSession(id: string): Promise<SessionRecord | null> {
    const rec = this.sessions.get(id);
    return rec ? structuredClone(rec) : null;
  }
  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async saveRoom(snap: RoomSnapshot): Promise<void> {
    this.rooms.set(snap.gameId, structuredClone(snap));
  }
  async loadRooms(): Promise<RoomSnapshot[]> {
    return [...this.rooms.values()].map((s) => structuredClone(s));
  }
  async deleteRoom(gameId: string): Promise<void> {
    this.rooms.delete(gameId);
  }
  async saveRoom4(snap: Room4Snapshot): Promise<void> {
    this.rooms4.set(snap.gameId, structuredClone(snap));
  }
  async loadRooms4(): Promise<Room4Snapshot[]> {
    return [...this.rooms4.values()].map((s) => structuredClone(s));
  }
  async deleteRoom4(gameId: string): Promise<void> {
    this.rooms4.delete(gameId);
  }

  async queuePush(stake: StakeCents, sessionId: string): Promise<void> {
    const q = this.queues.get(stake) ?? [];
    q.push(sessionId);
    this.queues.set(stake, q);
  }
  async queueRemove(sessionId: string): Promise<void> {
    for (const [stake, q] of this.queues) {
      this.queues.set(
        stake,
        q.filter((id) => id !== sessionId),
      );
    }
  }
  async queueClear(): Promise<void> {
    this.queues.clear();
  }

  async getOrCreatePlayer(
    id: string,
    defaults: {
      wallet?: string;
      name: string;
      flag: string;
      frame?: string;
      avatar?: string;
      customName?: string;
      customFlag?: string;
    },
  ): Promise<{ elo: number; gamesPlayed: number; wins: number; name: string; flag: string }> {
    const existing = this.players.get(id);
    if (existing) {
      if (defaults.frame !== undefined) existing.frame = defaults.frame; // equip re-syncs on hello
      if (defaults.avatar !== undefined) existing.avatar = defaults.avatar;
      if (defaults.customName) existing.name = defaults.customName; // edited profile overwrites
      if (defaults.customFlag) existing.flag = defaults.customFlag;
      return { elo: existing.elo, gamesPlayed: existing.gamesPlayed ?? 0, wins: existing.wins ?? 0, name: existing.name, flag: existing.flag };
    }
    const row = {
      ...defaults,
      name: defaults.customName ?? defaults.name,
      flag: defaults.customFlag ?? defaults.flag,
      frame: defaults.frame ?? 'none',
      avatar: defaults.avatar ?? 'none',
      elo: 1200,
      gamesPlayed: 0,
      wins: 0,
      captures: 0,
      done: false,
      tickets: 0,
      streakDays: 0,
      streakFreezes: 0,
      division: DEFAULT_DIVISION,
      weeklyPoints: 0,
      lossStreak: 0,
      lostRakeCents: 0,
      cashbackCents: 0,
      ownedSkins: [],
      claimedSets: [],
      stakedTodayCents: 0,
      dailyLimitCents: DEFAULT_DAILY_STAKE_LIMIT_CENTS,
    };
    this.players.set(id, row);
    return { elo: 1200, gamesPlayed: 0, wins: 0, name: row.name, flag: row.flag };
  }
  async updateElo(id: string, elo: number): Promise<void> {
    const row = this.players.get(id);
    if (row) {
      row.elo = elo;
      row.gamesPlayed = (row.gamesPlayed ?? 0) + 1; // mirror the durable games_played++
    }
  }
  async recordWin(id: string): Promise<void> {
    const row = this.players.get(id);
    if (row) row.wins = (row.wins ?? 0) + 1;
  }
  async recordPlayed(id: string): Promise<void> {
    const row = this.players.get(id);
    if (row) row.gamesPlayed = (row.gamesPlayed ?? 0) + 1;
  }
  async recordGame(rec: GameRecord): Promise<void> {
    this.games.set(rec.gameId, structuredClone(rec));
  }

  async enqueueSettlement(job: SettlementJob): Promise<void> {
    this.settlements.set(job.gameId, structuredClone(job));
  }
  async listPendingSettlements(): Promise<SettlementJob[]> {
    return [...this.settlements.values()].filter((j) => j.status === 'pending').map((j) => structuredClone(j));
  }
  async markSettlement(gameId: string, status: SettlementJob['status'], attempts: number, txHash?: string): Promise<void> {
    const job = this.settlements.get(gameId);
    if (job) {
      job.status = status;
      job.attempts = attempts;
      if (txHash) job.txHash = txHash;
    }
  }
  async hasSettlement(gameId: string): Promise<boolean> {
    return this.settlements.has(gameId);
  }

  async getChallenge(playerId: string, today: string): Promise<ChallengeState> {
    const row = this.players.get(playerId);
    const fresh = !row || row.challengeDate !== today;
    return {
      progress: fresh ? 0 : row.captures,
      target: DAILY_CHALLENGE.captures,
      completed: fresh ? false : row.done,
      tickets: row?.tickets ?? 0,
    };
  }

  async addCapture(playerId: string, today: string): Promise<ChallengeState> {
    const row = this.players.get(playerId);
    if (!row) return this.getChallenge(playerId, today);
    if (row.challengeDate !== today) {
      row.challengeDate = today;
      row.captures = 0;
      row.done = false;
    }
    row.captures += 1;
    if (!row.done && row.captures >= DAILY_CHALLENGE.captures) {
      row.done = true;
      row.tickets += DAILY_CHALLENGE.rewardTickets;
    }
    return { progress: row.captures, target: DAILY_CHALLENGE.captures, completed: row.done, tickets: row.tickets };
  }

  // ---------- season pass ----------
  async getSeason(nowIso: string): Promise<SeasonMeta> {
    if (!this.season) {
      const ends = new Date(new Date(nowIso).getTime() + SEASON.durationDays * 86_400_000).toISOString();
      this.season = { id: 1, startsAt: nowIso, endsAt: ends };
    }
    return { ...this.season };
  }
  private prog(playerId: string): SeasonProgress {
    const cur = this.season?.id ?? 1;
    let p = this.seasonProg.get(playerId);
    if (!p || p.seasonId !== cur) {
      p = { seasonId: cur, crowns: 0, premium: false, claimedFree: [], claimedPrem: [], crownBoost: 1, dailyDate: null, dailyGames: 0 };
      this.seasonProg.set(playerId, p);
    }
    return p;
  }
  async getSeasonProgress(playerId: string): Promise<SeasonProgress> {
    const p = this.prog(playerId);
    return { ...p, claimedFree: [...p.claimedFree], claimedPrem: [...p.claimedPrem] };
  }
  async addCrowns(playerId: string, crowns: number, today: string): Promise<{ crowns: number; dailyGames: number }> {
    const p = this.prog(playerId);
    if (p.dailyDate !== today) { p.dailyDate = today; p.dailyGames = 0; }
    p.dailyGames += 1;
    p.crowns += Math.max(0, Math.round(crowns));
    return { crowns: p.crowns, dailyGames: p.dailyGames };
  }
  async claimSeasonTier(playerId: string, tier: number, lane: 'free' | 'premium'): Promise<boolean> {
    const p = this.prog(playerId);
    const arr = lane === 'free' ? p.claimedFree : p.claimedPrem;
    if (arr.includes(tier)) return false;
    arr.push(tier);
    return true;
  }
  async setSeasonPremium(playerId: string): Promise<void> {
    this.prog(playerId).premium = true;
  }
  async setSeasonCrownBoost(playerId: string, multiplier: number): Promise<void> {
    this.prog(playerId).crownBoost = multiplier;
  }
  async consumePremiumTx(txHash: string, _playerId: string, _seasonId: number): Promise<boolean> {
    const key = txHash.toLowerCase();
    if (this.premiumTx.has(key)) return false;
    this.premiumTx.add(key);
    return true;
  }
  async rolloverSeason(nowIso: string): Promise<boolean> {
    const s = await this.getSeason(nowIso);
    if (new Date(nowIso).getTime() < new Date(s.endsAt).getTime()) return false;
    const ends = new Date(new Date(nowIso).getTime() + SEASON.durationDays * 86_400_000).toISOString();
    this.season = { id: s.id + 1, startsAt: nowIso, endsAt: ends };
    // per-player progress resets lazily (prog() sees a new seasonId)
    return true;
  }

  async recordLogin(playerId: string, today: string, yesterday: string, twoDaysAgo?: string): Promise<StreakState> {
    const row = this.players.get(playerId);
    if (!row) return { days: 1, tickets: 0, rewardGranted: 0, freezes: 0, daysAway: 0 };
    if (row.lastLogin === today) {
      return { days: row.streakDays, tickets: row.tickets, rewardGranted: 0, freezes: row.streakFreezes, daysAway: 0 };
    }
    const daysAway = row.lastLogin ? Math.max(1, Math.round((Date.parse(today) - Date.parse(row.lastLogin)) / 86_400_000)) : 0;
    let freezeUsed = false;
    if (row.lastLogin === yesterday) {
      row.streakDays += 1;
    } else if (twoDaysAgo && row.lastLogin === twoDaysAgo && row.streakFreezes > 0) {
      // a streak-freeze bridges EXACTLY one missed day → the streak continues
      row.streakFreezes -= 1;
      row.streakDays += 1;
      freezeUsed = true;
    } else {
      row.streakDays = 1;
    }
    row.lastLogin = today;
    const rewardGranted = STREAK_REWARDS[row.streakDays] ?? 0;
    row.tickets += rewardGranted;
    return { days: row.streakDays, tickets: row.tickets, rewardGranted, freezes: row.streakFreezes, freezeUsed, daysAway };
  }

  async getStreak(playerId: string): Promise<StreakState> {
    const row = this.players.get(playerId);
    if (!row) return { days: 0, tickets: 0, rewardGranted: 0, freezes: 0 };
    return { days: row.streakDays, tickets: row.tickets, rewardGranted: 0, freezes: row.streakFreezes };
  }
  async getStreakFreezes(playerId: string): Promise<number> {
    return this.players.get(playerId)?.streakFreezes ?? 0;
  }
  async grantStreakFreeze(playerId: string, n: number): Promise<number> {
    const row = this.players.get(playerId);
    if (!row) return 0;
    row.streakFreezes = Math.min(STREAK_FREEZE.max, row.streakFreezes + Math.max(0, n));
    return row.streakFreezes;
  }
  async buyStreakFreeze(playerId: string): Promise<BuyFreezeResult> {
    const row = this.players.get(playerId);
    if (!row) return { ok: false, reason: 'insufficient' };
    if (row.streakFreezes >= STREAK_FREEZE.max) return { ok: false, reason: 'capped' };
    if (row.tickets < STREAK_FREEZE.ticketCost) return { ok: false, reason: 'insufficient' };
    row.tickets -= STREAK_FREEZE.ticketCost;
    row.streakFreezes += 1;
    return { ok: true, freezes: row.streakFreezes, tickets: row.tickets };
  }

  private leagueState(division: number, points: number): LeagueState {
    const inDivision = [...this.players.entries()]
      .filter(([, p]) => p.division === division)
      .sort(([, a], [, b]) => b.weeklyPoints - a.weeklyPoints);
    const top: LeaderboardEntry[] = inDivision
      .filter(([, p]) => p.weeklyPoints > 0)
      .slice(0, LEADERBOARD_TOP)
      .map(([id, p]) => ({ name: p.name, flag: p.flag, points: p.weeklyPoints, pid: pidFor(id) }));
    const ahead = inDivision.filter(([, p]) => p.weeklyPoints > points).length;
    const active = inDivision.filter(([, p]) => p.weeklyPoints > 0).length;
    return { division, points, rank: points > 0 ? ahead + 1 : 0, size: active, top };
  }

  async addLeaguePoints(playerId: string, points: number): Promise<LeagueState> {
    const row = this.players.get(playerId);
    if (!row) return this.leagueState(DEFAULT_DIVISION, 0);
    row.weeklyPoints += points;
    return this.leagueState(row.division, row.weeklyPoints);
  }

  async getLeague(playerId: string): Promise<LeagueState> {
    const row = this.players.get(playerId);
    return this.leagueState(row?.division ?? DEFAULT_DIVISION, row?.weeklyPoints ?? 0);
  }

  async rolloverLeagues(): Promise<{ promoted: number; relegated: number; ticketsAwarded: number }> {
    const maxDiv = DIVISIONS.length - 1;
    // Snapshot standings first, then apply — so a promoted player is not
    // re-processed by the next division's pass.
    const moves = new Map<PlayerRow, number>();
    let ticketsAwarded = 0;
    for (let d = 0; d <= maxDiv; d++) {
      const ranked = [...this.players.values()]
        .filter((p) => p.division === d && p.weeklyPoints > 0)
        .sort((a, b) => b.weeklyPoints - a.weeklyPoints);
      // reward the week's top finishers of this division (before points reset)
      for (const p of ranked.slice(0, LEAGUE_REWARD_TOP)) {
        const t = leagueRewardTickets(d);
        p.tickets += t;
        ticketsAwarded += t;
      }
      const promote = d < maxDiv ? new Set(ranked.slice(0, LEAGUE_PROMOTE)) : new Set<PlayerRow>();
      for (const p of promote) moves.set(p, d + 1);
      if (d > 0) {
        for (const p of ranked.slice(-LEAGUE_RELEGATE)) {
          if (!promote.has(p)) moves.set(p, d - 1);
        }
      }
    }
    let promoted = 0;
    let relegated = 0;
    for (const [p, newDiv] of moves) {
      if (newDiv > p.division) promoted++;
      else relegated++;
      p.division = newDiv;
    }
    for (const p of this.players.values()) p.weeklyPoints = 0;
    return { promoted, relegated, ticketsAwarded };
  }

  async applyAntiTilt(playerId: string, won: boolean): Promise<{ grantedTickets: number; totalTickets: number }> {
    const row = this.players.get(playerId);
    if (!row) return { grantedTickets: 0, totalTickets: 0 };
    if (won) {
      row.lossStreak = 0;
      return { grantedTickets: 0, totalTickets: row.tickets };
    }
    row.lossStreak += 1;
    if (row.lossStreak >= ANTI_TILT.losses) {
      row.lossStreak = 0;
      row.tickets += ANTI_TILT.rewardTickets;
      return { grantedTickets: ANTI_TILT.rewardTickets, totalTickets: row.tickets };
    }
    return { grantedTickets: 0, totalTickets: row.tickets };
  }

  async grantTickets(playerId: string, n: number): Promise<number> {
    const row = this.players.get(playerId);
    if (!row) return 0;
    row.tickets += n;
    return row.tickets;
  }

  async spendTickets(playerId: string, n: number): Promise<number | null> {
    const row = this.players.get(playerId);
    if (!row || row.tickets < n) return null;
    row.tickets -= n;
    return row.tickets;
  }

  // Friends (E-social 2): directional edges; friendship = the mutual pair.
  private friendEdges = new Map<string, Set<string>>();

  async addFriend(playerId: string, otherId: string): Promise<'requested' | 'friends'> {
    let mine = this.friendEdges.get(playerId);
    if (!mine) {
      mine = new Set();
      this.friendEdges.set(playerId, mine);
    }
    mine.add(otherId);
    return this.friendEdges.get(otherId)?.has(playerId) ? 'friends' : 'requested';
  }

  async removeFriend(playerId: string, otherId: string): Promise<void> {
    this.friendEdges.get(playerId)?.delete(otherId);
    this.friendEdges.get(otherId)?.delete(playerId);
  }

  async getFriendIds(playerId: string): Promise<string[]> {
    const mine = this.friendEdges.get(playerId);
    if (!mine) return [];
    return [...mine].filter((other) => this.friendEdges.get(other)?.has(playerId));
  }

  async getFriendRequestIds(playerId: string): Promise<string[]> {
    const mine = this.friendEdges.get(playerId);
    const out: string[] = [];
    for (const [other, targets] of this.friendEdges) {
      if (other !== playerId && targets.has(playerId) && !mine?.has(other)) out.push(other);
    }
    return out;
  }

  async getOutgoingRequestIds(playerId: string): Promise<string[]> {
    const mine = this.friendEdges.get(playerId);
    if (!mine) return [];
    return [...mine].filter((other) => !this.friendEdges.get(other)?.has(playerId));
  }

  async getOwnedSkins(playerId: string): Promise<string[]> {
    return [...(this.players.get(playerId)?.ownedSkins ?? [])];
  }

  async ownSkin(playerId: string, skinId: string): Promise<string[]> {
    const row = this.players.get(playerId);
    if (!row) return [];
    if (!row.ownedSkins.includes(skinId)) row.ownedSkins.push(skinId);
    return [...row.ownedSkins];
  }

  async getClaimedSets(playerId: string): Promise<string[]> {
    return [...(this.players.get(playerId)?.claimedSets ?? [])];
  }

  async claimSet(playerId: string, setId: string): Promise<string[]> {
    const row = this.players.get(playerId);
    if (!row) return [];
    if (!row.claimedSets.includes(setId)) row.claimedSets.push(setId);
    return [...row.claimedSets];
  }

  async getLimits(playerId: string, today: string): Promise<LimitsState> {
    const row = this.players.get(playerId);
    const excluded = row?.selfExcludedUntil && row.selfExcludedUntil >= today ? row.selfExcludedUntil : null;
    return {
      dailyLimitCents: row?.dailyLimitCents ?? DEFAULT_DAILY_STAKE_LIMIT_CENTS,
      stakedTodayCents: row && row.stakeDate === today ? row.stakedTodayCents : 0,
      selfExcludedUntil: excluded,
    };
  }

  async addDailyStake(playerId: string, today: string, cents: number): Promise<void> {
    const row = this.players.get(playerId);
    if (!row) return;
    if (row.stakeDate !== today) {
      row.stakeDate = today;
      row.stakedTodayCents = 0;
    }
    row.stakedTodayCents += cents;
  }

  async setLimits(playerId: string, patch: { dailyLimitCents?: number; selfExcludedUntil?: string | null }): Promise<void> {
    const row = this.players.get(playerId);
    if (!row) return;
    if (patch.dailyLimitCents !== undefined) row.dailyLimitCents = patch.dailyLimitCents;
    if (patch.selfExcludedUntil !== undefined) row.selfExcludedUntil = patch.selfExcludedUntil;
  }

  private pairKey(a: string, b: string, today: string): string {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return `${today}|${lo}|${hi}`;
  }
  async pairGamesToday(a: string, b: string, today: string): Promise<number> {
    return this.pairGames.get(this.pairKey(a, b, today)) ?? 0;
  }
  async bumpPairGame(a: string, b: string, today: string): Promise<void> {
    const key = this.pairKey(a, b, today);
    this.pairGames.set(key, (this.pairGames.get(key) ?? 0) + 1);
  }

  async getProfileByPid(pid: string): Promise<{
    id: string;
    name: string;
    flag: string;
    elo: number;
    gamesPlayed: number;
    wins: number;
    division: number;
    frame: string;
    avatar: string;
  } | null> {
    for (const [id, p] of this.players) {
      if (pidFor(id) === pid) {
        return { id, name: p.name, flag: p.flag, elo: p.elo, gamesPlayed: p.gamesPlayed, wins: p.wins, division: p.division, frame: p.frame || 'none', avatar: p.avatar || 'none' };
      }
    }
    return null;
  }

  async headToHead(a: string, b: string): Promise<{ aWins: number; bWins: number }> {
    let aWins = 0;
    let bWins = 0;
    for (const g of this.games.values()) {
      const winner = g.winnerSeat === 0 ? g.playerA : g.playerB;
      if ((g.playerA === a && g.playerB === b) || (g.playerA === b && g.playerB === a)) {
        if (winner === a) aWins++;
        else if (winner === b) bWins++;
      }
    }
    return { aWins, bWins };
  }

  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: string, value: string): Promise<void> {
    this.meta.set(key, value);
  }
}
