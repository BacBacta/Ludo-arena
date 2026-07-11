/**
 * Global state — a single reducer, no external dependency.
 * Every screen/balance mutation goes through dispatch (traceable, testable).
 */
import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import type { GameState, Seat } from '@ludo/game-engine';
import {
  DAILY_CHALLENGE,
  DEFAULT_DAILY_STAKE_LIMIT_CENTS,
  DEFAULT_DIVISION,
  type ChallengeState,
  type LeagueState,
  type LimitsState,
  type StakeCents,
  type StreakState,
} from '@ludo/shared';
import type { GameResult, MatchInfo } from '../lib/session';

const CACHE_KEY = 'ludo.retention';

/** Retention state cached client-side so the lobby shows it before connecting. */
interface RetentionCache {
  challenge: ChallengeState;
  streak: StreakState;
  league: LeagueState;
  tickets: number;
  cashbackCents: number;
  limits: LimitsState;
}

const DEFAULT_RETENTION: RetentionCache = {
  challenge: { progress: 0, target: DAILY_CHALLENGE.captures, completed: false, tickets: 0 },
  streak: { days: 0, tickets: 0, rewardGranted: 0 },
  league: { division: DEFAULT_DIVISION, points: 0, rank: 0, size: 0, top: [] },
  tickets: 0,
  cashbackCents: 0,
  limits: { dailyLimitCents: DEFAULT_DAILY_STAKE_LIMIT_CENTS, stakedTodayCents: 0, selfExcludedUntil: null },
};

function loadRetention(): RetentionCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? { ...DEFAULT_RETENTION, ...(JSON.parse(raw) as RetentionCache) } : DEFAULT_RETENTION;
  } catch {
    return DEFAULT_RETENTION;
  }
}

export function saveRetention(cache: RetentionCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage unavailable */
  }
}

export type Screen = 'lobby' | 'matchmaking' | 'game' | 'end';

/** On-chain stake lifecycle for the current staked match (E3.2). */
export type StakingState = 'idle' | 'approving' | 'joining' | 'locked' | 'failed';

export interface AppState {
  screen: Screen;
  balanceCents: number;
  /** True once the balance comes from a connected wallet (no simulated debits). */
  walletBacked: boolean;
  stakeCents: StakeCents;
  challenge: ChallengeState;
  streak: StreakState;
  league: LeagueState;
  /** Total freeroll tickets; fed by both challenge and streak updates. */
  tickets: number;
  /** Accumulated anti-tilt cashback in cents (E4.5). */
  cashbackCents: number;
  /** Responsible-gaming limits (E5.2). */
  limits: LimitsState;
  /** Geo-gating (E5.4): staked play disabled in this region. */
  stakingBlocked: boolean;
  match: MatchInfo | null;
  game: GameState | null;
  lastDice: { value: number; index: number; seat: Seat } | null;
  /** All rolls this game, for client-side fairness verification (E5.1). */
  diceHistory: Array<{ index: number; value: number; seat: Seat }>;
  turnDeadlineTs: number | null;
  result: GameResult | null;
  /** On-chain payout tx hash once the arbiter settle() is mined (E3.3). */
  settleTxHash: string | null;
  /** True + tx hash when the stake was refunded (opponent never joined, E3.4). */
  refunded: boolean;
  botMode: boolean;
  reconnecting: boolean;
  staking: StakingState;
  /** Private-table code shown while waiting for a friend to join (E4.4). */
  privateCode: string | null;
  toast: string | null;
  fairModalOpen: boolean;
  settingsOpen: boolean;
}

export const initialState: AppState = {
  screen: 'lobby',
  balanceCents: 500,
  walletBacked: false,
  stakeCents: 25,
  challenge: loadRetention().challenge,
  streak: loadRetention().streak,
  league: loadRetention().league,
  tickets: loadRetention().tickets,
  cashbackCents: loadRetention().cashbackCents,
  limits: loadRetention().limits,
  stakingBlocked: false,
  match: null,
  game: null,
  lastDice: null,
  diceHistory: [],
  turnDeadlineTs: null,
  result: null,
  settleTxHash: null,
  refunded: false,
  botMode: false,
  reconnecting: false,
  staking: 'idle',
  privateCode: null,
  toast: null,
  fairModalOpen: false,
  settingsOpen: false,
};

export type Action =
  | { type: 'SELECT_STAKE'; stake: StakeCents }
  | { type: 'START_MATCHMAKING'; botMode: boolean }
  | { type: 'MATCH_FOUND'; match: MatchInfo }
  | { type: 'GAME_STATE'; game: GameState }
  | { type: 'DICE'; value: number; index: number; seat: Seat }
  | { type: 'MOVED'; game: GameState; capture: boolean }
  | { type: 'TURN'; seat: Seat; deadlineTs: number }
  | { type: 'GAME_OVER'; result: GameResult }
  | { type: 'RECONNECTING' }
  | { type: 'RESUME'; match: MatchInfo; game: GameState }
  | { type: 'STAKING'; status: StakingState }
  | { type: 'SETTLED'; txHash: string }
  | { type: 'REFUNDED'; txHash: string }
  | { type: 'CHALLENGE_UPDATE'; challenge: ChallengeState }
  | { type: 'STREAK_UPDATE'; streak: StreakState }
  | { type: 'LEAGUE_UPDATE'; league: LeagueState }
  | { type: 'TABLE_CREATED'; code: string }
  | { type: 'CASHBACK'; totalCents: number }
  | { type: 'LIMITS_UPDATE'; limits: LimitsState }
  | { type: 'GEO'; stakingBlocked: boolean }
  | { type: 'SET_BALANCE'; cents: number }
  | { type: 'GO_LOBBY' }
  | { type: 'TOAST'; message: string }
  | { type: 'CLEAR_TOAST' }
  | { type: 'FAIR_MODAL'; open: boolean }
  | { type: 'SETTINGS'; open: boolean };

export function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'SELECT_STAKE':
      return { ...s, stakeCents: a.stake };
    case 'START_MATCHMAKING':
      return {
        ...s,
        screen: 'matchmaking',
        botMode: a.botMode,
        match: null,
        game: null,
        result: null,
        settleTxHash: null,
        refunded: false,
        lastDice: null,
        diceHistory: [],
        staking: 'idle',
        privateCode: null,
      };
    case 'MATCH_FOUND':
      return {
        ...s,
        match: a.match,
        privateCode: null, // friend joined; the game is starting
        // Wallet-backed games lock funds on-chain (balance refreshed from the
        // wallet). Without a wallet, keep the simulated debit for the dev demo.
        balanceCents: s.walletBacked ? s.balanceCents : s.balanceCents - a.match.stakeCents,
      };
    case 'GAME_STATE':
      return { ...s, screen: 'game', game: a.game };
    case 'DICE':
      return {
        ...s,
        lastDice: { value: a.value, index: a.index, seat: a.seat },
        diceHistory: [...s.diceHistory, { index: a.index, value: a.value, seat: a.seat }],
      };
    case 'MOVED':
      // Challenge progress is server-authoritative (CHALLENGE_UPDATE), not derived here.
      return { ...s, game: a.game };
    case 'TURN':
      return { ...s, turnDeadlineTs: a.deadlineTs };
    case 'GAME_OVER': {
      const won = a.result.winner === (s.match?.seat ?? 0);
      // On-chain payout is settled by the arbiter (E3.3) and reflected via
      // SET_BALANCE; only the simulated dev path credits the balance here.
      const balanceCents =
        !s.walletBacked && won ? s.balanceCents + a.result.payoutCents : s.balanceCents;
      return { ...s, screen: 'end', result: a.result, settleTxHash: null, refunded: false, reconnecting: false, staking: 'idle', balanceCents };
    }
    case 'SETTLED':
      return { ...s, settleTxHash: a.txHash };
    case 'REFUNDED':
      return { ...s, settleTxHash: a.txHash, refunded: true };
    case 'CHALLENGE_UPDATE':
      return { ...s, challenge: a.challenge, tickets: a.challenge.tickets };
    case 'STREAK_UPDATE':
      return { ...s, streak: a.streak, tickets: a.streak.tickets };
    case 'LEAGUE_UPDATE':
      return { ...s, league: a.league };
    case 'TABLE_CREATED':
      return { ...s, screen: 'matchmaking', privateCode: a.code };
    case 'CASHBACK':
      return { ...s, cashbackCents: a.totalCents };
    case 'LIMITS_UPDATE':
      return { ...s, limits: a.limits };
    case 'GEO':
      return { ...s, stakingBlocked: a.stakingBlocked };
    case 'RECONNECTING':
      return { ...s, reconnecting: true };
    case 'RESUME':
      // reconnection resync: no balance change (the stake was already locked)
      return { ...s, screen: 'game', match: a.match, game: a.game, reconnecting: false };
    case 'STAKING':
      return { ...s, staking: a.status };
    case 'SET_BALANCE':
      return { ...s, balanceCents: a.cents, walletBacked: true };
    case 'GO_LOBBY':
      return { ...s, screen: 'lobby', match: null, game: null, result: null, reconnecting: false, staking: 'idle', privateCode: null };
    case 'TOAST':
      return { ...s, toast: a.message };
    case 'CLEAR_TOAST':
      return { ...s, toast: null };
    case 'FAIR_MODAL':
      return { ...s, fairModalOpen: a.open };
    case 'SETTINGS':
      return { ...s, settingsOpen: a.open };
    default:
      return s;
  }
}

const StateCtx = createContext<AppState>(initialState);
const DispatchCtx = createContext<Dispatch<Action>>(() => undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <StateCtx.Provider value={state}>
      <DispatchCtx.Provider value={dispatch}>{children}</DispatchCtx.Provider>
    </StateCtx.Provider>
  );
}

export function useAppState(): AppState {
  return useContext(StateCtx);
}

export function useAppDispatch(): Dispatch<Action> {
  return useContext(DispatchCtx);
}

export function fmtCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
