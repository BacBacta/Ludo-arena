/**
 * Redis-only store: hot state (sessions, rooms, queues) is persisted to Redis
 * so a server restart does not kill in-progress games (the core of E2.1),
 * while durable records (players, ELO, challenges, league, …) stay in memory.
 * Use this when only REDIS_URL is set (e.g. Upstash free tier, no Postgres).
 * TLS is auto-enabled for rediss:// URLs.
 */
import { Redis } from 'ioredis';
import { MemoryStore } from './memory.js';
import type { Room4Snapshot, RoomSnapshot, SessionRecord } from './types.js';
import { ALLOWED_STAKES_CENTS, type StakeCents } from '@ludo/shared';

const SESSION_TTL_S = 24 * 3600;

export class RedisOnlyStore extends MemoryStore {
  private redis: Redis;

  constructor(redisUrl: string) {
    super();
    this.redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
    this.redis.on('error', (err) => console.error('[redis] connection error', err.message));
  }

  override async init(): Promise<void> {
    await this.redis.connect();
  }
  override async close(): Promise<void> {
    this.redis.disconnect();
  }

  // ---------- sessions ----------
  override async saveSession(rec: SessionRecord): Promise<void> {
    await this.redis.set(`session:${rec.id}`, JSON.stringify(rec), 'EX', SESSION_TTL_S);
  }
  override async loadSession(id: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(`session:${id}`);
    return raw ? (JSON.parse(raw) as SessionRecord) : null;
  }
  override async deleteSession(id: string): Promise<void> {
    await this.redis.del(`session:${id}`);
  }

  // ---------- rooms ----------
  override async saveRoom(snap: RoomSnapshot): Promise<void> {
    await this.redis.multi().set(`room:${snap.gameId}`, JSON.stringify(snap)).sadd('rooms', snap.gameId).exec();
  }
  override async loadRooms(): Promise<RoomSnapshot[]> {
    const ids = await this.redis.smembers('rooms');
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map((id) => `room:${id}`));
    const snaps: RoomSnapshot[] = [];
    for (const [i, raw] of raws.entries()) {
      if (raw) snaps.push(JSON.parse(raw) as RoomSnapshot);
      else await this.redis.srem('rooms', ids[i]!);
    }
    return snaps;
  }
  override async deleteRoom(gameId: string): Promise<void> {
    await this.redis.multi().del(`room:${gameId}`).srem('rooms', gameId).exec();
  }
  // 4-player rooms (G-5): MUST override MemoryStore's in-memory versions, or a
  // staked 4p game would live only in this process and vanish on restart —
  // stranding 4 real deposits with no record to settle or refund.
  override async saveRoom4(snap: Room4Snapshot): Promise<void> {
    await this.redis.multi().set(`room4:${snap.gameId}`, JSON.stringify(snap)).sadd('rooms4', snap.gameId).exec();
  }
  override async loadRooms4(): Promise<Room4Snapshot[]> {
    const ids = await this.redis.smembers('rooms4');
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map((id) => `room4:${id}`));
    const snaps: Room4Snapshot[] = [];
    for (const [i, raw] of raws.entries()) {
      if (raw) snaps.push(JSON.parse(raw) as Room4Snapshot);
      else await this.redis.srem('rooms4', ids[i]!);
    }
    return snaps;
  }
  override async deleteRoom4(gameId: string): Promise<void> {
    await this.redis.multi().del(`room4:${gameId}`).srem('rooms4', gameId).exec();
  }

  // ---------- queues ----------
  override async queuePush(stake: StakeCents, sessionId: string): Promise<void> {
    await this.redis.rpush(`queue:${stake}`, sessionId);
  }
  override async queueRemove(sessionId: string): Promise<void> {
    // Fixed stake tiers instead of KEYS('queue:*') (KEYS blocks the Redis loop).
    const pipe = this.redis.pipeline();
    for (const stake of ALLOWED_STAKES_CENTS) pipe.lrem(`queue:${stake}`, 0, sessionId);
    await pipe.exec();
  }
  override async queueClear(): Promise<void> {
    await this.redis.del(...ALLOWED_STAKES_CENTS.map((s) => `queue:${s}`));
  }
}
