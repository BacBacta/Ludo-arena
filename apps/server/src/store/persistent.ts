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
import {
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

-- Login streak (E4.2).
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_login DATE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS streak_days INTEGER NOT NULL DEFAULT 0;

-- Weekly league (E4.3).
ALTER TABLE players ADD COLUMN IF NOT EXISTS division INTEGER NOT NULL DEFAULT 1;
ALTER TABLE players ADD COLUMN IF NOT EXISTS weekly_points INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS players_league_idx ON players(division, weekly_points DESC);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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

  async recordLogin(playerId: string, today: string, yesterday: string): Promise<StreakState> {
    const cur = await this.pool.query<{ last_login: string | null; streak_days: number; freeroll_tickets: number }>(
      `SELECT to_char(last_login, 'YYYY-MM-DD') AS last_login, streak_days, freeroll_tickets FROM players WHERE id = $1`,
      [playerId],
    );
    const row = cur.rows[0];
    if (!row) return { days: 1, tickets: 0, rewardGranted: 0 };
    if (row.last_login === today) {
      return { days: row.streak_days, tickets: row.freeroll_tickets, rewardGranted: 0 };
    }
    const days = row.last_login === yesterday ? row.streak_days + 1 : 1;
    const rewardGranted = STREAK_REWARDS[days] ?? 0;
    const res = await this.pool.query<{ freeroll_tickets: number }>(
      `UPDATE players SET last_login = $2::date, streak_days = $3, freeroll_tickets = freeroll_tickets + $4, updated_at = now()
       WHERE id = $1 RETURNING freeroll_tickets`,
      [playerId, today, days, rewardGranted],
    );
    return { days, tickets: res.rows[0]?.freeroll_tickets ?? row.freeroll_tickets, rewardGranted };
  }

  private async leagueState(division: number, points: number): Promise<LeagueState> {
    const [top, agg] = await Promise.all([
      this.pool.query<{ name: string; flag: string; weekly_points: number }>(
        `SELECT name, flag, weekly_points FROM players
         WHERE division = $1 AND weekly_points > 0 ORDER BY weekly_points DESC LIMIT $2`,
        [division, LEADERBOARD_TOP],
      ),
      this.pool.query<{ ahead: string; active: string }>(
        `SELECT
           count(*) FILTER (WHERE weekly_points > $2) AS ahead,
           count(*) FILTER (WHERE weekly_points > 0) AS active
         FROM players WHERE division = $1`,
        [division, points],
      ),
    ]);
    const ahead = Number(agg.rows[0]?.ahead ?? 0);
    const active = Number(agg.rows[0]?.active ?? 0);
    const entries: LeaderboardEntry[] = top.rows.map((r) => ({ name: r.name, flag: r.flag, points: r.weekly_points }));
    return { division, points, rank: points > 0 ? ahead + 1 : 0, size: active, top: entries };
  }

  async addLeaguePoints(playerId: string, points: number): Promise<LeagueState> {
    const res = await this.pool.query<{ division: number; weekly_points: number }>(
      `UPDATE players SET weekly_points = weekly_points + $2, updated_at = now()
       WHERE id = $1 RETURNING division, weekly_points`,
      [playerId, points],
    );
    const row = res.rows[0];
    if (!row) return this.leagueState(DEFAULT_DIVISION, 0);
    return this.leagueState(row.division, row.weekly_points);
  }

  async getLeague(playerId: string): Promise<LeagueState> {
    const res = await this.pool.query<{ division: number; weekly_points: number }>(
      `SELECT division, weekly_points FROM players WHERE id = $1`,
      [playerId],
    );
    const row = res.rows[0];
    return this.leagueState(row?.division ?? DEFAULT_DIVISION, row?.weekly_points ?? 0);
  }

  async rolloverLeagues(): Promise<{ promoted: number; relegated: number }> {
    const maxDiv = DIVISIONS.length - 1;
    // Rank within each division by points; promote top N (below top division),
    // relegate bottom N (above bottom division), excluding just-promoted rows.
    const res = await this.pool.query<{ promoted: string; relegated: string }>(
      `WITH ranked AS (
         SELECT id, division,
           row_number() OVER (PARTITION BY division ORDER BY weekly_points DESC) AS rn,
           count(*) OVER (PARTITION BY division) AS n
         FROM players WHERE weekly_points > 0
       ),
       moves AS (
         SELECT id,
           CASE
             WHEN division < $1 AND rn <= $2 THEN division + 1
             WHEN division > 0 AND rn > n - $3 THEN division - 1
             ELSE division
           END AS new_division,
           division AS old_division
         FROM ranked
       ),
       applied AS (
         UPDATE players p SET division = m.new_division
         FROM moves m WHERE p.id = m.id AND m.new_division <> m.old_division
         RETURNING m.new_division > m.old_division AS up
       )
       SELECT
         count(*) FILTER (WHERE up) AS promoted,
         count(*) FILTER (WHERE NOT up) AS relegated
       FROM applied`,
      [maxDiv, LEAGUE_PROMOTE, LEAGUE_RELEGATE],
    );
    await this.pool.query(`UPDATE players SET weekly_points = 0 WHERE weekly_points <> 0`);
    return { promoted: Number(res.rows[0]?.promoted ?? 0), relegated: Number(res.rows[0]?.relegated ?? 0) };
  }

  async getMeta(key: string): Promise<string | null> {
    const res = await this.pool.query<{ value: string }>(`SELECT value FROM meta WHERE key = $1`, [key]);
    return res.rows[0]?.value ?? null;
  }
  async setMeta(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value],
    );
  }
}
