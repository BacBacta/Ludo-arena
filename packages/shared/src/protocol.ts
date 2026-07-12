/**
 * Client <-> server WebSocket protocol. Source of truth: this file.
 * Any evolution: change here FIRST, then server, then client (see AGENTS.md).
 */
import type { GameState, Seat } from '@ludo/game-engine';

/** Allowed stakes, in dollar cents (0 = practice). */
export const ALLOWED_STAKES_CENTS = [0, 10, 25, 50, 100, 200] as const;
export type StakeCents = (typeof ALLOWED_STAKES_CENTS)[number];

/** House share, in basis points (900 = 9%). */
export const RAKE_BPS = 900;

/** Daily challenge (E4.1): capture N opponent tokens in a day → freeroll tickets. */
export const DAILY_CHALLENGE = { captures: 3, rewardTickets: 1 } as const;

export interface ChallengeState {
  progress: number; // captures made today
  target: number; // DAILY_CHALLENGE.captures
  completed: boolean; // today's challenge done
  tickets: number; // total freeroll tickets held
}

/** Login-streak milestones (E4.2): consecutive-day count → freeroll tickets. */
export const STREAK_REWARDS: Record<number, number> = { 3: 1, 7: 2 };

export interface StreakState {
  days: number; // current consecutive-day streak
  tickets: number; // total freeroll tickets held (shared with the challenge)
  rewardGranted: number; // tickets granted by this login's milestone (0 if none)
}

/** Anti-tilt cashback (E4.5): after N consecutive staked losses, refund a
 *  share of the rake those games paid. */
export const ANTI_TILT = { losses: 3, rakeShareBps: 2000 } as const; // 20% of rake

/** Responsible gaming (E5.2): default/max daily stake cap per player, in cents. */
export const DEFAULT_DAILY_STAKE_LIMIT_CENTS = 200;
export const MAX_DAILY_STAKE_LIMIT_CENTS = 200;

/** Anti multi-accounting (E5.3): max staked games per day against the same wallet. */
export const MAX_DAILY_GAMES_VS_SAME = 3;

export interface LimitsState {
  dailyLimitCents: number;
  stakedTodayCents: number;
  selfExcludedUntil: string | null; // UTC date (YYYY-MM-DD) or null
}

/** Weekly league (E4.3): divisions bottom→top; new players start in Silver. */
export const DIVISIONS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'] as const;
export const DEFAULT_DIVISION = 1; // Silver
export const LEAGUE_PROMOTE = 3; // top N of a division promote each week
export const LEAGUE_RELEGATE = 3; // bottom N relegate

/** League points for a win, with a small stake bonus. */
export function leaguePointsForWin(stakeCents: number): number {
  return 10 + Math.floor(stakeCents / 25) * 2;
}

export interface LeaderboardEntry {
  name: string;
  flag: string;
  points: number;
}

export interface LeagueState {
  division: number; // index into DIVISIONS
  points: number; // weekly points
  rank: number; // 1-based within the division (0 if unranked)
  size: number; // active players in the division this week
  top: LeaderboardEntry[]; // top of the division this week
}

/** ISO-8601 week id (e.g. "2026-W28"), UTC — the league rollover boundary. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // nearest Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Winner payout = pot − rake, matching the server/escrow rounding (rake is floored). */
export function potCents(stake: StakeCents): number {
  const pot = stake * 2;
  return pot - Math.floor((pot * RAKE_BPS) / 10_000);
}

// ---------- Client -> Server ----------

export type ClientMsg =
  | { t: 'hello'; wallet?: string; sessionToken?: string; entropy: string; fingerprint?: string }
  | { t: 'queue.join'; stake: StakeCents }
  | { t: 'queue.leave' }
  // Private tables (E4.4): create returns a code; a friend joins with it.
  | { t: 'table.create'; stake: StakeCents }
  | { t: 'table.join'; code: string }
  // Responsible gaming (E5.2): lower the daily cap and/or self-exclude.
  | { t: 'limits.set'; dailyLimitCents?: number; selfExcludeDays?: number }
  | { t: 'game.roll' }
  | { t: 'game.move'; token: number }
  // Forfeit the current match on purpose (the only deliberate exit from a game).
  | { t: 'game.resign' }
  | { t: 'game.rematch' }
  | { t: 'ping' };

/** Private-table code: unambiguous charset, fixed length. */
export const TABLE_CODE_LEN = 6;
export const TABLE_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function isTableCode(s: string): boolean {
  return s.length === TABLE_CODE_LEN && [...s].every((c) => TABLE_CODE_CHARS.includes(c));
}

// ---------- Server -> Client ----------

export interface OpponentInfo {
  name: string;
  elo: number;
  flag: string;
}

export type GameOverReason = 'finish' | 'timeout-forfeit' | 'resign';

/** Everything a client needs to rebuild the game screen after a reconnection. */
export interface ResumedGame {
  gameId: string;
  seat: Seat;
  state: GameState;
  stakeCents: StakeCents;
  potCents: number;
  opponent: OpponentInfo;
  fairnessCommit: string;
}

export type ServerMsg =
  | {
      t: 'hello.ok';
      sessionToken: string;
      elo: number;
      resumed?: ResumedGame;
      challenge?: ChallengeState;
      streak?: StreakState;
      league?: LeagueState;
      cashbackCents?: number; // accumulated anti-tilt cashback (E4.5)
      limits?: LimitsState; // responsible-gaming state (E5.2)
      stakingBlocked?: boolean; // geo-gated region, staked play disabled (E5.4)
    }
  | { t: 'queue.ok'; position: number }
  // Private table created (E4.4); share `code` with a friend to join.
  | { t: 'table.created'; code: string; stakeCents: StakeCents }
  | {
      t: 'match.found';
      gameId: string;
      seat: Seat;
      opponent: OpponentInfo;
      stakeCents: StakeCents;
      potCents: number;
      fairnessCommit: string;
    }
  | { t: 'game.state'; state: GameState }
  | { t: 'game.dice'; value: number; index: number; seat: Seat }
  | {
      t: 'game.moved';
      seat: Seat;
      token: number;
      capture: boolean;
      finished: boolean;
      extraTurn: boolean;
      state: GameState;
    }
  | { t: 'game.turn'; seat: Seat; deadlineTs: number }
  | {
      t: 'game.over';
      winner: Seat;
      reason: GameOverReason;
      payoutCents: number;
      rakeCents: number;
      eloDelta: number;
      fairnessReveal: { serverSeed: string; entropies: [string, string] };
      txHash?: string;
    }
  // On-chain settlement confirmation, sent after game.over once the arbiter's
  // settle() tx is mined (E3.3). Decoupled so game.over is never blocked on chain latency.
  | { t: 'game.settled'; gameId: string; txHash: string; winner: Seat }
  // Stake refunded on-chain because the opponent never joined within the escrow
  // timeout (E3.4); the lone staker gets their stake back.
  | { t: 'game.refunded'; gameId: string; txHash: string }
  // Daily challenge progress/ticket update (E4.1).
  | { t: 'challenge.update'; challenge: ChallengeState }
  // Weekly league standings after a game (E4.3).
  | { t: 'league.update'; league: LeagueState }
  // Anti-tilt cashback granted after a losing streak (E4.5).
  | { t: 'cashback'; cents: number; totalCents: number }
  // Responsible-gaming state after hello or a limits.set (E5.2).
  | { t: 'limits.update'; limits: LimitsState }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong' };

export type ErrorCode =
  | 'BAD_STATE'
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL_MOVE'
  | 'BAD_MESSAGE'
  | 'LIMIT_REACHED'
  | 'INSUFFICIENT_ESCROW'
  | 'TABLE_NOT_FOUND'
  | 'INTERNAL';

// ---------- Helpers ----------

export function parseClientMsg(raw: string): ClientMsg | null {
  if (raw.length > 1024) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || typeof (obj as { t?: unknown }).t !== 'string')
    return null;
  const m = obj as ClientMsg;
  switch (m.t) {
    case 'hello':
      if (typeof m.entropy !== 'string' || m.entropy.length < 16 || m.entropy.length > 128) return null;
      if (m.fingerprint !== undefined && (typeof m.fingerprint !== 'string' || m.fingerprint.length > 64)) return null;
      return m;
    case 'queue.join':
    case 'table.create':
      return (ALLOWED_STAKES_CENTS as readonly number[]).includes(m.stake) ? m : null;
    case 'table.join':
      return typeof m.code === 'string' && isTableCode(m.code) ? m : null;
    case 'limits.set': {
      const limitOk = m.dailyLimitCents === undefined || (Number.isInteger(m.dailyLimitCents) && m.dailyLimitCents >= 0 && m.dailyLimitCents <= MAX_DAILY_STAKE_LIMIT_CENTS);
      const exclOk = m.selfExcludeDays === undefined || (Number.isInteger(m.selfExcludeDays) && m.selfExcludeDays >= 0 && m.selfExcludeDays <= 365);
      return limitOk && exclOk ? m : null;
    }
    case 'game.move':
      return Number.isInteger(m.token) && m.token >= 0 && m.token <= 3 ? m : null;
    case 'queue.leave':
    case 'game.roll':
    case 'game.resign':
    case 'game.rematch':
    case 'ping':
      return m;
    default:
      return null;
  }
}
