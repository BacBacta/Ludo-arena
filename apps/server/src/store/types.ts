/**
 * Persistence layer (BACKLOG E2.1).
 * Hot state (sessions, rooms, queues) lives in Redis so a server restart
 * does not kill in-progress games. Durable records (players, games) live
 * in Postgres. MemoryStore keeps dev zero-config (no restart survival).
 */
import { createHmac } from 'node:crypto';
import type { GameState, Seat } from '@ludo/game-engine';
import type { ChallengeState, GameOverReason, LeagueState, LimitsState, StakeCents, StreakState } from '@ludo/shared';

/** Serializable part of a Session (the ws handle and Room ref are rebuilt live). */
export interface SessionRecord {
  id: string;
  wallet?: string;
  entropy: string;
  name: string;
  flag: string;
  elo: number;
  stake: StakeCents | null;
  gameId: string | null;
  seat: Seat | null;
}

export interface RoomPlayer {
  sessionId: string;
  wallet?: string;
  name: string;
  flag: string;
  elo: number;
}

/** Full state needed to rebuild a Room after a restart. */
export interface RoomSnapshot {
  gameId: string;
  stakeCents: StakeCents;
  state: GameState;
  diceIndex: number;
  autoMoveStreak: [number, number];
  fairness: { serverSeed: string; commit: string; entropies: [string, string] };
  players: [RoomPlayer, RoomPlayer];
  /** Terminal flag: a snapshot taken after the winning move must NOT restore as
   *  a live game (else a post-crash clock could re-award it to the loser). */
  over?: boolean;
  /** Ticket-gated freeroll game (winner gets the ticket prize on finish). */
  freeroll?: boolean;
}

export interface GameRecord {
  gameId: string;
  stakeCents: StakeCents;
  playerA: string;
  playerB: string;
  winnerSeat: Seat;
  reason: GameOverReason;
  payoutCents: number;
  rakeCents: number;
  eloDelta: number;
  fairnessCommit: string;
  serverSeed: string;
}

/** Durable on-chain settlement job (E3.3): survives restarts, retried until mined. */
export interface SettlementJob {
  gameId: string;
  winnerWallet: string;
  chainId: number;
  status: 'pending' | 'settled' | 'failed' | 'refunded';
  attempts: number;
  txHash?: string;
}

export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  /** True only when settlement jobs + game records survive a restart (full
   *  Postgres). When false, staked play must be refused: a restart would drop
   *  pending settlements and lock player funds in escrow with no recovery. */
  settlementDurable(): boolean;

  // Sessions (hot)
  saveSession(rec: SessionRecord): Promise<void>;
  loadSession(id: string): Promise<SessionRecord | null>;
  deleteSession(id: string): Promise<void>;

  // Rooms (hot)
  saveRoom(snap: RoomSnapshot): Promise<void>;
  loadRooms(): Promise<RoomSnapshot[]>;
  deleteRoom(gameId: string): Promise<void>;

  // Queues (hot; membership only — pairing needs a live socket, so queues
  // are cleared at boot and re-filled as clients reconnect)
  queuePush(stake: StakeCents, sessionId: string): Promise<void>;
  queueRemove(sessionId: string): Promise<void>;
  queueClear(): Promise<void>;

  // Players & games (durable)
  getOrCreatePlayer(
    id: string,
    defaults: {
      wallet?: string;
      name: string; // derived fallback used only when creating a fresh row
      flag: string;
      frame?: string;
      avatar?: string;
      /** Custom display name/flag from an edited profile: overwrites the stored
       *  value when present; when absent the stored value is kept (COALESCE). */
      customName?: string;
      customFlag?: string;
    },
  ): Promise<{ elo: number; gamesPlayed: number; wins: number; name: string; flag: string }>;
  updateElo(id: string, elo: number): Promise<void>;
  /** Increment a player's win count (profile W/L). Called for the winner. */
  recordWin(id: string): Promise<void>;
  /** Increment games_played only (no ELO change) — for 4-player games, where
   *  updateElo (which bumps games_played) doesn't run. No-op for unknown ids. */
  recordPlayed(id: string): Promise<void>;
  recordGame(rec: GameRecord): Promise<void>;

  // Settlements (durable, E3.3)
  enqueueSettlement(job: SettlementJob): Promise<void>;
  listPendingSettlements(): Promise<SettlementJob[]>;
  markSettlement(gameId: string, status: SettlementJob['status'], attempts: number, txHash?: string): Promise<void>;

  // Daily challenge (E4.1). `today` is a UTC date string (YYYY-MM-DD); progress
  // resets when the stored day differs. Tickets persist across days.
  getChallenge(playerId: string, today: string): Promise<ChallengeState>;
  addCapture(playerId: string, today: string): Promise<ChallengeState>;

  // Login streak (E4.2). Once per UTC day: +1 if last login was `yesterday`,
  // reset to 1 otherwise; milestone rewards (STREAK_REWARDS) granted on the
  // crossing login. No-op re-return if already logged in today.
  recordLogin(playerId: string, today: string, yesterday: string): Promise<StreakState>;

  // Weekly league (E4.3). Points accumulate during the week; rolloverLeagues
  // (weekly cron) promotes/relegates and resets. getLeague includes the
  // division leaderboard.
  addLeaguePoints(playerId: string, points: number): Promise<LeagueState>;
  getLeague(playerId: string): Promise<LeagueState>;
  rolloverLeagues(): Promise<{ promoted: number; relegated: number; ticketsAwarded: number }>;

  /** Anti-tilt (E4.5): winner resets the loss streak; the loser's 3rd straight
   *  staked loss grants ANTI_TILT.rewardTickets freeroll tickets. */
  applyAntiTilt(playerId: string, won: boolean): Promise<{ grantedTickets: number; totalTickets: number }>;
  /** Freeroll ticket ledger: grant returns the new total; spend is atomic and
   *  returns the new total, or null when the balance is insufficient. */
  grantTickets(playerId: string, n: number): Promise<number>;
  spendTickets(playerId: string, n: number): Promise<number | null>;

  /** Premium dice-skin ownership. getOwnedSkins lists unlocked ids; ownSkin
   *  records one (idempotent) and returns the full list. */
  getOwnedSkins(playerId: string): Promise<string[]>;
  ownSkin(playerId: string, skinId: string): Promise<string[]>;

  // Responsible gaming (E5.2). `today` is a UTC date string; the daily staked
  // total resets when the stored day differs. selfExcludedUntil is null when
  // not excluded or the exclusion has expired.
  getLimits(playerId: string, today: string): Promise<LimitsState>;
  addDailyStake(playerId: string, today: string, cents: number): Promise<void>;
  setLimits(playerId: string, patch: { dailyLimitCents?: number; selfExcludedUntil?: string | null }): Promise<void>;

  // Anti multi-accounting (E5.3): count of staked games between two players today.
  pairGamesToday(a: string, b: string, today: string): Promise<number>;
  bumpPairGame(a: string, b: string, today: string): Promise<void>;

  // Public profiles (E-social). `id` in the result is the INTERNAL player key —
  // for follow-up store calls only, never sent to clients.
  getProfileByPid(pid: string): Promise<{
    id: string;
    name: string;
    flag: string;
    elo: number;
    gamesPlayed: number;
    wins: number;
    division: number;
    frame: string;
    avatar: string;
  } | null>;
  /** 1v1 head-to-head from recorded games (4p games are not GameRecords). */
  headToHead(a: string, b: string): Promise<{ aWins: number; bWins: number }>;

  // Generic key/value meta (e.g. the last-processed league week).
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

/** Stable player id: wallet when known, otherwise anonymous per-session. */
export function playerId(wallet: string | undefined, sessionId: string): string {
  return wallet ? wallet.toLowerCase() : `anon:${sessionId}`;
}

/**
 * Server secret keying the public-pid HMAC. A CONSTANT public salt (the old
 * design) let anyone with a wallet dictionary reverse pid → wallet offline,
 * re-exposing the very 0x we hide (MiniPay rule). Keying with a server secret
 * makes pid unlinkable without it. Set LUDO_PID_SECRET in prod (Fly secret);
 * the dev fallback is deterministic so local pids stay stable across restarts.
 * Rotating the secret invalidates stored pids — they self-heal on next login
 * (getOrCreatePlayer recomputes the column), so no migration is needed.
 */
const PID_SECRET = process.env.LUDO_PID_SECRET?.trim() || 'ludo-dev-pid-secret';

/**
 * Opaque PUBLIC player id (E-social): what other clients use to view a profile.
 * Derived in Node only (HMAC-keyed, non-reversible by clients) and stored in the
 * players.pid column so lookups stay indexed without the secret ever touching
 * SQL. Never a raw wallet / session id (MiniPay rule: no raw 0x surfaces).
 */
export function pidFor(id: string): string {
  return createHmac('sha256', PID_SECRET).update(`ludo-pid:${id}`).digest('hex').slice(0, 16);
}
