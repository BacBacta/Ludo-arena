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

/** Winner payout = pot − rake, matching the server/escrow rounding (rake is floored). */
export function potCents(stake: StakeCents): number {
  const pot = stake * 2;
  return pot - Math.floor((pot * RAKE_BPS) / 10_000);
}

// ---------- Client -> Server ----------

export type ClientMsg =
  | { t: 'hello'; wallet?: string; sessionToken?: string; entropy: string }
  | { t: 'queue.join'; stake: StakeCents }
  | { t: 'queue.leave' }
  | { t: 'game.roll' }
  | { t: 'game.move'; token: number }
  | { t: 'game.rematch' }
  | { t: 'ping' };

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
  | { t: 'hello.ok'; sessionToken: string; elo: number; resumed?: ResumedGame; challenge?: ChallengeState; streak?: StreakState }
  | { t: 'queue.ok'; position: number }
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
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong' };

export type ErrorCode =
  | 'BAD_STATE'
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL_MOVE'
  | 'BAD_MESSAGE'
  | 'LIMIT_REACHED'
  | 'INSUFFICIENT_ESCROW'
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
      return typeof m.entropy === 'string' && m.entropy.length >= 16 && m.entropy.length <= 128
        ? m
        : null;
    case 'queue.join':
      return (ALLOWED_STAKES_CENTS as readonly number[]).includes(m.stake) ? m : null;
    case 'game.move':
      return Number.isInteger(m.token) && m.token >= 0 && m.token <= 3 ? m : null;
    case 'queue.leave':
    case 'game.roll':
    case 'game.rematch':
    case 'ping':
      return m;
    default:
      return null;
  }
}
