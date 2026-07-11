/**
 * In-memory Store: dev fallback when REDIS_URL/DATABASE_URL are not set.
 * Same semantics as PersistentStore within one process lifetime — by design
 * it does NOT survive a restart (see AGENTS.md / BACKLOG E2.1).
 */
import type { GameRecord, RoomSnapshot, SessionRecord, SettlementJob, Store } from './types.js';
import {
  ANTI_TILT,
  DAILY_CHALLENGE,
  DEFAULT_DIVISION,
  DIVISIONS,
  LEAGUE_PROMOTE,
  LEAGUE_RELEGATE,
  STREAK_REWARDS,
  type ChallengeState,
  type LeaderboardEntry,
  type LeagueState,
  type StakeCents,
  type StreakState,
} from '@ludo/shared';

const LEADERBOARD_TOP = 5;

interface PlayerRow {
  wallet?: string;
  name: string;
  flag: string;
  elo: number;
  challengeDate?: string;
  captures: number;
  done: boolean;
  tickets: number;
  lastLogin?: string;
  streakDays: number;
  division: number;
  weeklyPoints: number;
  lossStreak: number;
  lostRakeCents: number;
  cashbackCents: number;
}

export class MemoryStore implements Store {
  private sessions = new Map<string, SessionRecord>();
  private rooms = new Map<string, RoomSnapshot>();
  private queues = new Map<StakeCents, string[]>();
  private players = new Map<string, PlayerRow>();
  private games = new Map<string, GameRecord>();
  private settlements = new Map<string, SettlementJob>();
  private meta = new Map<string, string>();

  async init(): Promise<void> {}
  async close(): Promise<void> {}

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
    defaults: { wallet?: string; name: string; flag: string },
  ): Promise<{ elo: number }> {
    const existing = this.players.get(id);
    if (existing) return { elo: existing.elo };
    this.players.set(id, {
      ...defaults,
      elo: 1200,
      captures: 0,
      done: false,
      tickets: 0,
      streakDays: 0,
      division: DEFAULT_DIVISION,
      weeklyPoints: 0,
      lossStreak: 0,
      lostRakeCents: 0,
      cashbackCents: 0,
    });
    return { elo: 1200 };
  }
  async updateElo(id: string, elo: number): Promise<void> {
    const row = this.players.get(id);
    if (row) row.elo = elo;
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

  async recordLogin(playerId: string, today: string, yesterday: string): Promise<StreakState> {
    const row = this.players.get(playerId);
    if (!row) return { days: 1, tickets: 0, rewardGranted: 0 };
    if (row.lastLogin === today) {
      return { days: row.streakDays, tickets: row.tickets, rewardGranted: 0 };
    }
    row.streakDays = row.lastLogin === yesterday ? row.streakDays + 1 : 1;
    row.lastLogin = today;
    const rewardGranted = STREAK_REWARDS[row.streakDays] ?? 0;
    row.tickets += rewardGranted;
    return { days: row.streakDays, tickets: row.tickets, rewardGranted };
  }

  private leagueState(division: number, points: number): LeagueState {
    const inDivision = [...this.players.values()]
      .filter((p) => p.division === division)
      .sort((a, b) => b.weeklyPoints - a.weeklyPoints);
    const top: LeaderboardEntry[] = inDivision
      .filter((p) => p.weeklyPoints > 0)
      .slice(0, LEADERBOARD_TOP)
      .map((p) => ({ name: p.name, flag: p.flag, points: p.weeklyPoints }));
    const ahead = inDivision.filter((p) => p.weeklyPoints > points).length;
    const active = inDivision.filter((p) => p.weeklyPoints > 0).length;
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

  async rolloverLeagues(): Promise<{ promoted: number; relegated: number }> {
    const maxDiv = DIVISIONS.length - 1;
    // Snapshot standings first, then apply — so a promoted player is not
    // re-processed by the next division's pass.
    const moves = new Map<PlayerRow, number>();
    for (let d = 0; d <= maxDiv; d++) {
      const ranked = [...this.players.values()]
        .filter((p) => p.division === d && p.weeklyPoints > 0)
        .sort((a, b) => b.weeklyPoints - a.weeklyPoints);
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
    return { promoted, relegated };
  }

  async applyAntiTilt(playerId: string, won: boolean, rakeCents: number): Promise<{ cents: number; totalCents: number }> {
    const row = this.players.get(playerId);
    if (!row) return { cents: 0, totalCents: 0 };
    if (won) {
      row.lossStreak = 0;
      row.lostRakeCents = 0;
      return { cents: 0, totalCents: row.cashbackCents };
    }
    row.lossStreak += 1;
    row.lostRakeCents += rakeCents;
    if (row.lossStreak >= ANTI_TILT.losses) {
      const cents = Math.round((row.lostRakeCents * ANTI_TILT.rakeShareBps) / 10_000);
      row.cashbackCents += cents;
      row.lossStreak = 0;
      row.lostRakeCents = 0;
      return { cents, totalCents: row.cashbackCents };
    }
    return { cents: 0, totalCents: row.cashbackCents };
  }

  async getCashback(playerId: string): Promise<number> {
    return this.players.get(playerId)?.cashbackCents ?? 0;
  }

  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: string, value: string): Promise<void> {
    this.meta.set(key, value);
  }
}
