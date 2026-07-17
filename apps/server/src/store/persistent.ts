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
import { pidFor } from './types.js';
import type { GameRecord, Room4Snapshot, RoomSnapshot, SessionRecord, SettlementJob, Store } from './types.js';
import {
  ALLOWED_STAKES_CENTS,
  ANTI_TILT,
  DAILY_CHALLENGE,
  DEFAULT_DAILY_STAKE_LIMIT_CENTS,
  DEFAULT_DIVISION,
  DIVISIONS,
  LEAGUE_PROMOTE,
  LEAGUE_RELEGATE,
  LEAGUE_REWARD_TOP,
  STREAK_REWARDS,
  type ChallengeState,
  type LeaderboardEntry,
  type LeagueState,
  type LimitsState,
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
-- Profile W/L (games_played already tracked in updateElo).
ALTER TABLE players ADD COLUMN IF NOT EXISTS wins INTEGER NOT NULL DEFAULT 0;
-- Public profile lookup (E-social): pid is an HMAC-keyed handle computed in Node
-- (pidFor(), server-secret keyed so clients can't reverse it) and stored here.
-- Null for rows created before this column; self-heals on the player's next
-- login (getOrCreatePlayer recomputes it), so no migration/backfill is needed.
ALTER TABLE players ADD COLUMN IF NOT EXISTS pid TEXT;
CREATE INDEX IF NOT EXISTS players_pid_idx ON players (pid);
-- Equipped avatar frame (E-social C3): cosmetic ring shown on the player's
-- public profile. Client-authoritative (sent in hello, same trust as skins).
ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_frame TEXT NOT NULL DEFAULT 'none';
-- Profile avatar (E-social): premium 3D identity picture, or 'none' → show flag.
ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped_avatar TEXT NOT NULL DEFAULT 'none';

-- Anti-tilt (E4.5): rewards are freeroll TICKETS, not cash. loss_streak drives
-- the grant; lost_rake_cents/cashback_cents are legacy columns from the retired
-- cents-cashback design, kept only to avoid a destructive migration — never paid.
ALTER TABLE players ADD COLUMN IF NOT EXISTS loss_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS lost_rake_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS cashback_cents INTEGER NOT NULL DEFAULT 0;
-- Premium dice skins unlocked with tickets (cosmetic sink).
ALTER TABLE players ADD COLUMN IF NOT EXISTS owned_skins TEXT[] NOT NULL DEFAULT '{}';

-- Responsible gaming (E5.2).
ALTER TABLE players ADD COLUMN IF NOT EXISTS stake_date DATE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS staked_today_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS daily_limit_cents INTEGER NOT NULL DEFAULT 200;
ALTER TABLE players ADD COLUMN IF NOT EXISTS self_excluded_until DATE;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Anti multi-accounting (E5.3): staked games per day between a canonical pair.
CREATE TABLE IF NOT EXISTS pair_games (
  day DATE NOT NULL,
  player_lo TEXT NOT NULL,
  player_hi TEXT NOT NULL,
  cnt INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, player_lo, player_hi)
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
-- 4p durability: tag each job with its escrow variant so the 2p and 4p durable
-- queues each resume only their own pending jobs. Added via ALTER so existing
-- databases migrate; legacy rows default to the 1v1 '2p' path.
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS variant TEXT NOT NULL DEFAULT '2p';
`;

export class PersistentStore implements Store {
  private redis: Redis;
  private pool: pg.Pool;

  constructor(redisUrl: string, databaseUrl: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: true });
    this.pool = new pg.Pool({ connectionString: databaseUrl });
    // node-postgres emits 'error' on idle-client failures; unhandled, that is an
    // uncaught exception → process exit mid-match. Log and let the pool recover.
    this.pool.on('error', (err) => console.error('[pg] idle client error', err));
    // ioredis won't crash on its own, but without a listener the errors are silent.
    this.redis.on('error', (err) => console.error('[redis] connection error', err.message));
  }

  async init(): Promise<void> {
    await this.redis.connect();
    await this.pool.query(SCHEMA_SQL);
  }

  /** Postgres-backed settlements + game records survive a restart. */
  settlementDurable(): boolean {
    return true;
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
  async saveRoom4(snap: Room4Snapshot): Promise<void> {
    await this.redis
      .multi()
      .set(`room4:${snap.gameId}`, JSON.stringify(snap))
      .sadd('rooms4', snap.gameId)
      .exec();
  }
  async loadRooms4(): Promise<Room4Snapshot[]> {
    const ids = await this.redis.smembers('rooms4');
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map((id) => `room4:${id}`));
    const snaps: Room4Snapshot[] = [];
    for (const [i, raw] of raws.entries()) {
      if (raw) snaps.push(JSON.parse(raw) as Room4Snapshot);
      else await this.redis.srem('rooms4', ids[i]!); // stale index entry
    }
    return snaps;
  }
  async deleteRoom4(gameId: string): Promise<void> {
    await this.redis.multi().del(`room4:${gameId}`).srem('rooms4', gameId).exec();
  }

  // ---------- queues ----------

  async queuePush(stake: StakeCents, sessionId: string): Promise<void> {
    await this.redis.rpush(`queue:${stake}`, sessionId);
  }
  async queueRemove(sessionId: string): Promise<void> {
    // Iterate the fixed stake tiers instead of KEYS('queue:*') (KEYS is O(N) and
    // blocks the Redis event loop; this ran on every disconnect/leave/pairing).
    const pipe = this.redis.pipeline();
    for (const stake of ALLOWED_STAKES_CENTS) pipe.lrem(`queue:${stake}`, 0, sessionId);
    await pipe.exec();
  }
  async queueClear(): Promise<void> {
    await this.redis.del(...ALLOWED_STAKES_CENTS.map((s) => `queue:${s}`));
  }

  // ---------- players & games ----------

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
    const res = await this.pool.query<{ elo: number; games_played: number; wins: number; name: string; flag: string }>(
      // frame ($6): NOT NULL column → COALESCE to 'none' on insert; keep existing
      // on a frame-less hello. name/flag: an edited profile ($7/$8) overwrites the
      // stored identity; a hello without edits keeps it (COALESCE), so a returning
      // player never loses their custom name/flag to the derived fallback.
      `INSERT INTO players (id, wallet, name, flag, pid, equipped_frame, equipped_avatar)
       VALUES ($1, $2, COALESCE($7, $3), COALESCE($8, $4), $5, COALESCE($6, 'none'), COALESCE($9, 'none'))
       ON CONFLICT (id) DO UPDATE SET updated_at = now(), pid = EXCLUDED.pid,
         equipped_frame = COALESCE($6, players.equipped_frame),
         equipped_avatar = COALESCE($9, players.equipped_avatar),
         name = COALESCE($7, players.name),
         flag = COALESCE($8, players.flag)
       RETURNING elo, games_played, wins, name, flag`,
      [id, defaults.wallet ?? null, defaults.name, defaults.flag, pidFor(id), defaults.frame ?? null, defaults.customName ?? null, defaults.customFlag ?? null, defaults.avatar ?? null],
    );
    const r = res.rows[0];
    return {
      elo: r?.elo ?? 1200,
      gamesPlayed: r?.games_played ?? 0,
      wins: r?.wins ?? 0,
      name: r?.name ?? defaults.customName ?? defaults.name,
      flag: r?.flag ?? defaults.customFlag ?? defaults.flag,
    };
  }

  async recordWin(id: string): Promise<void> {
    await this.pool.query(`UPDATE players SET wins = wins + 1, updated_at = now() WHERE id = $1`, [id]);
  }

  async recordPlayed(id: string): Promise<void> {
    await this.pool.query(`UPDATE players SET games_played = games_played + 1, updated_at = now() WHERE id = $1`, [id]);
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
      `INSERT INTO settlements (game_id, winner_wallet, chain_id, status, attempts, tx_hash, variant)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (game_id) DO NOTHING`,
      [job.gameId, job.winnerWallet, job.chainId, job.status, job.attempts, job.txHash ?? null, job.variant ?? '2p'],
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
      variant: '2p' | '4p';
    }>(`SELECT game_id, winner_wallet, chain_id, status, attempts, tx_hash, variant FROM settlements WHERE status = 'pending'`);
    return res.rows.map((r) => ({
      gameId: r.game_id,
      winnerWallet: r.winner_wallet,
      chainId: r.chain_id,
      status: r.status,
      attempts: r.attempts,
      txHash: r.tx_hash ?? undefined,
      variant: r.variant,
    }));
  }

  async markSettlement(gameId: string, status: SettlementJob['status'], attempts: number, txHash?: string): Promise<void> {
    await this.pool.query(
      `UPDATE settlements SET status = $2, attempts = $3, tx_hash = COALESCE($4, tx_hash), updated_at = now() WHERE game_id = $1`,
      [gameId, status, attempts, txHash ?? null],
    );
  }

  async hasSettlement(gameId: string): Promise<boolean> {
    const res = await this.pool.query(`SELECT 1 FROM settlements WHERE game_id = $1`, [gameId]);
    return (res.rowCount ?? 0) > 0;
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
      this.pool.query<{ name: string; flag: string; weekly_points: number; pid: string | null }>(
        `SELECT name, flag, weekly_points, pid FROM players
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
    const entries: LeaderboardEntry[] = top.rows.map((r) => ({ name: r.name, flag: r.flag, points: r.weekly_points, pid: r.pid ?? undefined }));
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

  async rolloverLeagues(): Promise<{ promoted: number; relegated: number; ticketsAwarded: number }> {
    const maxDiv = DIVISIONS.length - 1;
    // Reward the week's top finishers FIRST (on their played division, before any
    // promotion changes it and before points reset): top-N get division+1 tickets.
    const reward = await this.pool.query<{ awarded: string }>(
      `WITH ranked AS (
         SELECT id, division,
           row_number() OVER (PARTITION BY division ORDER BY weekly_points DESC) AS rn
         FROM players WHERE weekly_points > 0
       ),
       granted AS (
         UPDATE players p SET freeroll_tickets = freeroll_tickets + (r.division + 1), updated_at = now()
         FROM ranked r WHERE p.id = r.id AND r.rn <= $1
         RETURNING (r.division + 1) AS t
       )
       SELECT COALESCE(sum(t), 0) AS awarded FROM granted`,
      [LEAGUE_REWARD_TOP],
    );
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
    return {
      promoted: Number(res.rows[0]?.promoted ?? 0),
      relegated: Number(res.rows[0]?.relegated ?? 0),
      ticketsAwarded: Number(reward.rows[0]?.awarded ?? 0),
    };
  }

  async applyAntiTilt(playerId: string, won: boolean): Promise<{ grantedTickets: number; totalTickets: number }> {
    if (won) {
      const res = await this.pool.query<{ freeroll_tickets: number }>(
        `UPDATE players SET loss_streak = 0 WHERE id = $1 RETURNING freeroll_tickets`,
        [playerId],
      );
      return { grantedTickets: 0, totalTickets: res.rows[0]?.freeroll_tickets ?? 0 };
    }
    // Increment the streak; on the threshold, grant ticket(s) and reset —
    // all in one statement. (Tickets replace the old cents cashback: a real,
    // spendable reward with no unbacked cash liability.)
    const res = await this.pool.query<{ freeroll_tickets: number; granted: number }>(
      `WITH cur AS (
         SELECT loss_streak + 1 AS streak FROM players WHERE id = $1
       ),
       calc AS (
         SELECT streak >= $2 AS hit,
           CASE WHEN streak >= $2 THEN $3 ELSE 0 END::int AS grant,
           streak FROM cur
       )
       UPDATE players p SET
         loss_streak = CASE WHEN c.hit THEN 0 ELSE c.streak END,
         freeroll_tickets = p.freeroll_tickets + c.grant,
         updated_at = now()
       FROM calc c WHERE p.id = $1
       RETURNING p.freeroll_tickets, c.grant AS granted`,
      [playerId, ANTI_TILT.losses, ANTI_TILT.rewardTickets],
    );
    const row = res.rows[0];
    if (!row) return { grantedTickets: 0, totalTickets: 0 };
    return { grantedTickets: row.granted, totalTickets: row.freeroll_tickets };
  }

  async grantTickets(playerId: string, n: number): Promise<number> {
    const res = await this.pool.query<{ freeroll_tickets: number }>(
      `UPDATE players SET freeroll_tickets = freeroll_tickets + $2, updated_at = now()
       WHERE id = $1 RETURNING freeroll_tickets`,
      [playerId, n],
    );
    return res.rows[0]?.freeroll_tickets ?? 0;
  }

  async spendTickets(playerId: string, n: number): Promise<number | null> {
    // Atomic conditional decrement: no row updated = insufficient balance.
    const res = await this.pool.query<{ freeroll_tickets: number }>(
      `UPDATE players SET freeroll_tickets = freeroll_tickets - $2, updated_at = now()
       WHERE id = $1 AND freeroll_tickets >= $2 RETURNING freeroll_tickets`,
      [playerId, n],
    );
    return res.rows[0]?.freeroll_tickets ?? null;
  }

  async getOwnedSkins(playerId: string): Promise<string[]> {
    const res = await this.pool.query<{ owned_skins: string[] }>(`SELECT owned_skins FROM players WHERE id = $1`, [playerId]);
    return res.rows[0]?.owned_skins ?? [];
  }

  async ownSkin(playerId: string, skinId: string): Promise<string[]> {
    // array_append only if not already present (idempotent), returns the new list.
    const res = await this.pool.query<{ owned_skins: string[] }>(
      `UPDATE players SET
         owned_skins = CASE WHEN $2 = ANY(owned_skins) THEN owned_skins ELSE array_append(owned_skins, $2) END,
         updated_at = now()
       WHERE id = $1 RETURNING owned_skins`,
      [playerId, skinId],
    );
    return res.rows[0]?.owned_skins ?? [];
  }

  async getLimits(playerId: string, today: string): Promise<LimitsState> {
    const res = await this.pool.query<{ stake_date: string | null; staked_today_cents: number; daily_limit_cents: number; self_excluded_until: string | null }>(
      `SELECT to_char(stake_date, 'YYYY-MM-DD') AS stake_date, staked_today_cents, daily_limit_cents,
              to_char(self_excluded_until, 'YYYY-MM-DD') AS self_excluded_until
       FROM players WHERE id = $1`,
      [playerId],
    );
    const row = res.rows[0];
    const excluded = row?.self_excluded_until && row.self_excluded_until >= today ? row.self_excluded_until : null;
    return {
      dailyLimitCents: row?.daily_limit_cents ?? DEFAULT_DAILY_STAKE_LIMIT_CENTS,
      stakedTodayCents: row && row.stake_date === today ? row.staked_today_cents : 0,
      selfExcludedUntil: excluded,
    };
  }

  async addDailyStake(playerId: string, today: string, cents: number): Promise<void> {
    await this.pool.query(
      `UPDATE players SET
         staked_today_cents = CASE WHEN stake_date = $2::date THEN staked_today_cents + $3 ELSE $3 END,
         stake_date = $2::date, updated_at = now()
       WHERE id = $1`,
      [playerId, today, cents],
    );
  }

  async setLimits(playerId: string, patch: { dailyLimitCents?: number; selfExcludedUntil?: string | null }): Promise<void> {
    await this.pool.query(
      `UPDATE players SET
         daily_limit_cents = COALESCE($2, daily_limit_cents),
         self_excluded_until = CASE WHEN $3::boolean THEN $4::date ELSE self_excluded_until END,
         updated_at = now()
       WHERE id = $1`,
      [playerId, patch.dailyLimitCents ?? null, patch.selfExcludedUntil !== undefined, patch.selfExcludedUntil ?? null],
    );
  }

  async pairGamesToday(a: string, b: string, today: string): Promise<number> {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const res = await this.pool.query<{ cnt: number }>(
      `SELECT cnt FROM pair_games WHERE day = $1::date AND player_lo = $2 AND player_hi = $3`,
      [today, lo, hi],
    );
    return res.rows[0]?.cnt ?? 0;
  }
  async bumpPairGame(a: string, b: string, today: string): Promise<void> {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    await this.pool.query(
      `INSERT INTO pair_games (day, player_lo, player_hi, cnt) VALUES ($1::date, $2, $3, 1)
       ON CONFLICT (day, player_lo, player_hi) DO UPDATE SET cnt = pair_games.cnt + 1`,
      [today, lo, hi],
    );
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
    const res = await this.pool.query<{
      id: string;
      name: string;
      flag: string;
      elo: number;
      games_played: number;
      wins: number;
      division: number;
      equipped_frame: string;
      equipped_avatar: string;
    }>(
      `SELECT id, name, flag, elo, games_played, wins, division, equipped_frame, equipped_avatar FROM players
       WHERE pid = $1 LIMIT 1`,
      [pid],
    );
    const r = res.rows[0];
    if (!r) return null;
    return { id: r.id, name: r.name, flag: r.flag, elo: r.elo, gamesPlayed: r.games_played, wins: r.wins, division: r.division, frame: r.equipped_frame || 'none', avatar: r.equipped_avatar || 'none' };
  }

  async headToHead(a: string, b: string): Promise<{ aWins: number; bWins: number }> {
    const res = await this.pool.query<{ a_wins: string; b_wins: string }>(
      `SELECT
         count(*) FILTER (WHERE (player_a = $1 AND winner_seat = 0) OR (player_b = $1 AND winner_seat = 1)) AS a_wins,
         count(*) FILTER (WHERE (player_a = $2 AND winner_seat = 0) OR (player_b = $2 AND winner_seat = 1)) AS b_wins
       FROM games
       WHERE (player_a = $1 AND player_b = $2) OR (player_a = $2 AND player_b = $1)`,
      [a, b],
    );
    return { aWins: Number(res.rows[0]?.a_wins ?? 0), bWins: Number(res.rows[0]?.b_wins ?? 0) };
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
