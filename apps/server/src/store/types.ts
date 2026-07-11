/**
 * Persistence layer (BACKLOG E2.1).
 * Hot state (sessions, rooms, queues) lives in Redis so a server restart
 * does not kill in-progress games. Durable records (players, games) live
 * in Postgres. MemoryStore keeps dev zero-config (no restart survival).
 */
import type { GameState, Seat } from '@ludo/game-engine';
import type { ChallengeState, GameOverReason, LeagueState, StakeCents, StreakState } from '@ludo/shared';

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
    defaults: { wallet?: string; name: string; flag: string },
  ): Promise<{ elo: number }>;
  updateElo(id: string, elo: number): Promise<void>;
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
  rolloverLeagues(): Promise<{ promoted: number; relegated: number }>;

  // Anti-tilt cashback (E4.5). Call once per player per staked game: a win
  // resets the streak; a loss accumulates the game's rake and, after
  // ANTI_TILT.losses in a row, credits a share of it (returned as `cents`).
  applyAntiTilt(playerId: string, won: boolean, rakeCents: number): Promise<{ cents: number; totalCents: number }>;
  getCashback(playerId: string): Promise<number>;

  // Generic key/value meta (e.g. the last-processed league week).
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

/** Stable player id: wallet when known, otherwise anonymous per-session. */
export function playerId(wallet: string | undefined, sessionId: string): string {
  return wallet ? wallet.toLowerCase() : `anon:${sessionId}`;
}
