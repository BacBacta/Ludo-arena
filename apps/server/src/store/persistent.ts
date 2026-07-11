/**
 * Redis (hot state) + Postgres (durable records) Store.
 * Redis keys:
 *   session:{id} -> JSON SessionRecord (TTL 24 h, refreshed on write)
 *   room:{gameId} -> JSON RoomSnapshot
 *   rooms -> SET of active gameIds
 *   queue:{stake} -> LIST of session ids (observability / multi-node later)
 */
import { Redis } from 'ioredis';
import pg from 'pg';
import type { GameRecord, RoomSnapshot, SessionRecord, SettlementJob, Store } from './types.js';
import { DAILY_CHALLENGE, type ChallengeState, type StakeCents } from '@ludo/shared';

const SESSION_TTL_S = 24 * 3600;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  wallet TEXT UNIQUE,
  name TEXT NOT NULL,
  flag TEXT NOT NULL,
  elo INTEGER NOT NULL DEFAULT 1200,
  games_played INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily challenge (E4.1). Added via ALTER so existing databases migrate.
ALTER TABLE players ADD COLUMN IF NOT EXISTS challenge_date DATE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS challenge_captures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS challenge_done BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE players ADD COLUMN IF NOT EXISTS freeroll_tickets INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  stake_cents INTEGER NOT NULL,
  player_a TEXT NOT NULL REFERENCES players(id),
  player_b TEXT NOT NULL REFERENCES players(id),
  winner_seat SMALLINT NOT NULL,
  reason TEXT NOT NULL,
  payout_cents INTEGER NOT NULL,
  rake_cents INTEGER NOT NULL,
  elo_delta INTEGER NOT NULL,
  fairness_commit TEXT NOT NULL,
  server_seed TEXT NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS games_player_a_idx ON games(player_a);
CREATE INDEX IF NOT EXISTS games_player_b_idx ON games(player_b);

CREATE TABLE IF NOT EXISTS settlements (
  game_id TEXT PRIMARY KEY,
  winner_wallet TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS settlements_pending_idx ON settlements(status) WHERE status = 'pending';
`;

export class PersistentStore implements Store {
  private redis: Redis;
  private pool: pg.Pool;

  constructor(redisUrl: string, databaseUrl: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: true });
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    await this.redis.connect();
    await this.pool.query(SCHEMA_SQL);
  }

  async close(): Promise<void> {
    this.redis.disconnect();
    await this.pool.end();
  }

  // ---------- sessions ----------

  async saveSession(rec: SessionRecord): Promise<void> {
    await this.redis.set(`session:${rec.id}`, JSON.stringify(rec), 'EX', SESSION_TTL_S);
  }
  async loadSession(id: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(`session:${id}`);
    return raw ? (JSON.parse(raw) as SessionRecord) : null;
  }
  async deleteSession(id: string): Promise<void> {
    await this.redis.del(`session:${id}`);
  }

  // ---------- rooms ----------

  async saveRoom(snap: RoomSnapshot): Promise<void> {
    await this.redis
      .multi()
      .set(`room:${snap.gameId}`, JSON.stringify(snap))
      .sadd('rooms', snap.gameId)
      .exec();
  }
  async loadRooms(): Promise<RoomSnapshot[]> {
    const ids = await this.redis.smembers('rooms');
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map((id) => `room:${id}`));
    const snaps: RoomSnapshot[] = [];
    for (const [i, raw] of raws.entries()) {
      if (raw) snaps.push(JSON.parse(raw) as RoomSnapshot);
      else await this.redis.srem('rooms', ids[i]!); // stale index entry
    }
    return snaps;
  }
  async deleteRoom(gameId: string): Promise<void> {
    await this.redis.multi().del(`room:${gameId}`).srem('rooms', gameId).exec();
  }

  // ---------- queues ----------

  async queuePush(stake: StakeCents, sessionId: string): Promise<void> {
    await this.redis.rpush(`queue:${stake}`, sessionId);
  }
  async queueRemove(sessionId: string): Promise<void> {
    const keys = await this.redis.keys('queue:*');
    for (const key of keys) await this.redis.lrem(key, 0, sessionId);
  }
  async queueClear(): Promise<void> {
    const keys = await this.redis.keys('queue:*');
    if (keys.length > 0) await this.redis.del(keys);
  }

  // ---------- players & games ----------

  async getOrCreatePlayer(
    id: string,
    defaults: { wallet?: string; name: string; flag: string },
  ): Promise<{ elo: number }> {
    const res = await this.pool.query<{ elo: number }>(
      `INSERT INTO players (id, wallet, name, flag)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET updated_at = now()
       RETURNING elo`,
      [id, defaults.wallet ?? null, defaults.name, defaults.flag],
    );
    return { elo: res.rows[0]?.elo ?? 1200 };
  }

  async updateElo(id: string, elo: number): Promise<void> {
    await this.pool.query(
      `UPDATE players
       SET elo = $2, games_played = games_played + 1, updated_at = now()
       WHERE id = $1`,
      [id, elo],
    );
  }

  async recordGame(rec: GameRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO games (id, stake_cents, player_a, player_b, winner_seat, reason,
                          payout_cents, rake_cents, elo_delta, fairness_commit, server_seed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      [
        rec.gameId,
        rec.stakeCents,
        rec.playerA,
        rec.playerB,
        rec.winnerSeat,
        rec.reason,
        rec.payoutCents,
        rec.rakeCents,
        rec.eloDelta,
        rec.fairnessCommit,
        rec.serverSeed,
      ],
    );
  }

  async enqueueSettlement(job: SettlementJob): Promise<void> {
    await this.pool.query(
      `INSERT INTO settlements (game_id, winner_wallet, chain_id, status, attempts, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (game_id) DO NOTHING`,
      [job.gameId, job.winnerWallet, job.chainId, job.status, job.attempts, job.txHash ?? null],
    );
  }

  async listPendingSettlements(): Promise<SettlementJob[]> {
    const res = await this.pool.query<{
      game_id: string;
      winner_wallet: string;
      chain_id: number;
      status: SettlementJob['status'];
      attempts: number;
      tx_hash: string | null;
    }>(`SELECT game_id, winner_wallet, chain_id, status, attempts, tx_hash FROM settlements WHERE status = 'pending'`);
    return res.rows.map((r) => ({
      gameId: r.game_id,
      winnerWallet: r.winner_wallet,
      chainId: r.chain_id,
      status: r.status,
      attempts: r.attempts,
      txHash: r.tx_hash ?? undefined,
    }));
  }

  async markSettlement(gameId: string, status: SettlementJob['status'], attempts: number, txHash?: string): Promise<void> {
    await this.pool.query(
      `UPDATE settlements SET status = $2, attempts = $3, tx_hash = COALESCE($4, tx_hash), updated_at = now() WHERE game_id = $1`,
      [gameId, status, attempts, txHash ?? null],
    );
  }

  private challengeFrom(row: { challenge_date: string | null; challenge_captures: number; challenge_done: boolean; freeroll_tickets: number } | undefined, today: string): ChallengeState {
    const fresh = !row || row.challenge_date !== today;
    return {
      progress: fresh ? 0 : row!.challenge_captures,
      target: DAILY_CHALLENGE.captures,
      completed: fresh ? false : row!.challenge_done,
      tickets: row?.freeroll_tickets ?? 0,
    };
  }

  async getChallenge(playerId: string, today: string): Promise<ChallengeState> {
    const res = await this.pool.query<{ challenge_date: string | null; challenge_captures: number; challenge_done: boolean; freeroll_tickets: number }>(
      `SELECT to_char(challenge_date, 'YYYY-MM-DD') AS challenge_date, challenge_captures, challenge_done, freeroll_tickets FROM players WHERE id = $1`,
      [playerId],
    );
    return this.challengeFrom(res.rows[0], today);
  }

  async addCapture(playerId: string, today: string): Promise<ChallengeState> {
    // Day-reset + increment + award-on-completion in one statement.
    const res = await this.pool.query<{ challenge_captures: number; challenge_done: boolean; freeroll_tickets: number }>(
      `UPDATE players AS p SET
         challenge_date = $2::date,
         challenge_captures = c.captures,
         challenge_done = c.done,
         freeroll_tickets = p.freeroll_tickets + CASE WHEN c.done AND NOT c.was_done THEN $4 ELSE 0 END,
         updated_at = now()
       FROM (
         SELECT
           (CASE WHEN challenge_date = $2::date THEN challenge_captures ELSE 0 END) + 1 AS captures,
           (CASE WHEN challenge_date = $2::date THEN challenge_done ELSE false END) AS was_done,
           ((CASE WHEN challenge_date = $2::date THEN challenge_captures ELSE 0 END) + 1) >= $3 AS done
         FROM players WHERE id = $1
       ) AS c
       WHERE p.id = $1
       RETURNING p.challenge_captures, p.challenge_done, p.freeroll_tickets`,
      [playerId, today, DAILY_CHALLENGE.captures, DAILY_CHALLENGE.rewardTickets],
    );
    const row = res.rows[0];
    if (!row) return this.getChallenge(playerId, today); // no player row
    return { progress: row.challenge_captures, target: DAILY_CHALLENGE.captures, completed: row.challenge_done, tickets: row.freeroll_tickets };
  }
}
