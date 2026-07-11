/**
 * Global state — a single reducer, no external dependency.
 * Every screen/balance mutation goes through dispatch (traceable, testable).
 */
import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import type { GameState, Seat } from '@ludo/game-engine';
import type { StakeCents } from '@ludo/shared';
import type { GameResult, MatchInfo } from '../lib/session';

export type Screen = 'lobby' | 'matchmaking' | 'game' | 'end';

export interface AppState {
  screen: Screen;
  balanceCents: number;
  stakeCents: StakeCents;
  streakDays: number;
  challengeProgress: number;
  match: MatchInfo | null;
  game: GameState | null;
  lastDice: { value: number; index: number; seat: Seat } | null;
  turnDeadlineTs: number | null;
  result: GameResult | null;
  botMode: boolean;
  reconnecting: boolean;
  toast: string | null;
  fairModalOpen: boolean;
}

export const initialState: AppState = {
  screen: 'lobby',
  balanceCents: 500,
  stakeCents: 25,
  streakDays: 3,
  challengeProgress: 1,
  match: null,
  game: null,
  lastDice: null,
  turnDeadlineTs: null,
  result: null,
  botMode: false,
  reconnecting: false,
  toast: null,
  fairModalOpen: false,
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
  | { type: 'GO_LOBBY' }
  | { type: 'TOAST'; message: string }
  | { type: 'CLEAR_TOAST' }
  | { type: 'FAIR_MODAL'; open: boolean };

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
        lastDice: null,
      };
    case 'MATCH_FOUND':
      return {
        ...s,
        match: a.match,
        // stake debited on lock (simulated until E3.2 is wired)
        balanceCents: s.balanceCents - a.match.stakeCents,
      };
    case 'GAME_STATE':
      return { ...s, screen: 'game', game: a.game };
    case 'DICE':
      return { ...s, lastDice: { value: a.value, index: a.index, seat: a.seat } };
    case 'MOVED': {
      const challengeProgress =
        a.capture && a.game.turn !== undefined && s.challengeProgress < 3
          ? s.challengeProgress + 1
          : s.challengeProgress;
      return { ...s, game: a.game, challengeProgress };
    }
    case 'TURN':
      return { ...s, turnDeadlineTs: a.deadlineTs };
    case 'GAME_OVER': {
      const won = a.result.winner === (s.match?.seat ?? 0);
      return {
        ...s,
        screen: 'end',
        result: a.result,
        reconnecting: false,
        balanceCents: won ? s.balanceCents + a.result.payoutCents : s.balanceCents,
      };
    }
    case 'RECONNECTING':
      return { ...s, reconnecting: true };
    case 'RESUME':
      // reconnection resync: no balance change (the stake was already debited)
      return { ...s, screen: 'game', match: a.match, game: a.game, reconnecting: false };
    case 'GO_LOBBY':
      return { ...s, screen: 'lobby', match: null, game: null, result: null, reconnecting: false };
    case 'TOAST':
      return { ...s, toast: a.message };
    case 'CLEAR_TOAST':
      return { ...s, toast: null };
    case 'FAIR_MODAL':
      return { ...s, fairModalOpen: a.open };
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
