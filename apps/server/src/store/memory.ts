/**
 * In-memory Store: dev fallback when REDIS_URL/DATABASE_URL are not set.
 * Same semantics as PersistentStore within one process lifetime — by design
 * it does NOT survive a restart (see AGENTS.md / BACKLOG E2.1).
 */
import type { GameRecord, RoomSnapshot, SessionRecord, SettlementJob, Store } from './types.js';
import type { StakeCents } from '@ludo/shared';

interface PlayerRow {
  wallet?: string;
  name: string;
  flag: string;
  elo: number;
}

export class MemoryStore implements Store {
  private sessions = new Map<string, SessionRecord>();
  private rooms = new Map<string, RoomSnapshot>();
  private queues = new Map<StakeCents, string[]>();
  private players = new Map<string, PlayerRow>();
  private games = new Map<string, GameRecord>();
  private settlements = new Map<string, SettlementJob>();

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
    this.players.set(id, { ...defaults, elo: 1200 });
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
}
