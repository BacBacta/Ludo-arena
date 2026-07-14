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
  type PublicProfile,
} from '@ludo/shared';
import type { GameResult, MatchInfo } from '../lib/session';
import { setSoundEnabled, soundEnabled } from '../lib/sound';
import { loadSkinId, saveSkinId } from '../lib/diceSkins';
import { loadFrameId, saveFrameId } from '../lib/avatarFrames';
import { loadAvatarId, saveAvatarId } from '../lib/avatars';
import { t } from '../lib/i18n';

const CACHE_KEY = 'ludo.retention';

/** Retention state cached client-side so the lobby shows it before connecting. */
export interface Profile {
  name: string;
  flag: string;
  elo: number;
  games: number;
  wins: number;
  /** My own opaque public id (what others use to view my profile). */
  pid?: string;
}

/** A player you've faced in 1v1, with YOUR local head-to-head record vs them —
 *  the social-memory feature (E-social C4). Purely client-side: the W/L is what
 *  this device has seen, so it needs no server round-trip. A rival = games >= 3. */
export interface RecentOpponent {
  pid?: string;
  name: string;
  flag: string;
  frame?: string;
  wins: number; // MY wins vs them
  losses: number; // MY losses vs them
  lastTs: number;
}

const RECENT_KEY = 'ludo.recentOpponents';
const RECENT_MAX = 8;
export const RIVAL_GAMES = 3; // played this many times → a rival

function loadRecentOpponents(): RecentOpponent[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? (JSON.parse(raw) as RecentOpponent[]) : [];
    return Array.isArray(arr) ? arr.slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function saveRecentOpponents(list: RecentOpponent[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

/** Upsert one finished 1v1 into the recent-opponents ledger (most-recent first). */
function recordOpponent(
  list: RecentOpponent[],
  opp: { pid?: string; name: string; flag: string; frame?: string },
  won: boolean,
  now: number,
): RecentOpponent[] {
  const existing = list.find((o) => o.pid === opp.pid);
  const merged = existing
    ? list.map((o) =>
        o.pid === opp.pid
          ? { ...o, name: opp.name, flag: opp.flag, frame: opp.frame, wins: o.wins + (won ? 1 : 0), losses: o.losses + (won ? 0 : 1), lastTs: now }
          : o,
      )
    : [{ pid: opp.pid, name: opp.name, flag: opp.flag, frame: opp.frame, wins: won ? 1 : 0, losses: won ? 0 : 1, lastTs: now }, ...list];
  return [...merged].sort((a, b) => b.lastTs - a.lastTs).slice(0, RECENT_MAX);
}

interface RetentionCache {
  challenge: ChallengeState;
  streak: StreakState;
  league: LeagueState;
  tickets: number;
  ownedSkins: string[];
  limits: LimitsState;
  profile: Profile;
}

const DEFAULT_RETENTION: RetentionCache = {
  challenge: { progress: 0, target: DAILY_CHALLENGE.captures, completed: false, tickets: 0 },
  streak: { days: 0, tickets: 0, rewardGranted: 0 },
  league: { division: DEFAULT_DIVISION, points: 0, rank: 0, size: 0, top: [] },
  tickets: 0,
  ownedSkins: [],
  limits: { dailyLimitCents: DEFAULT_DAILY_STAKE_LIMIT_CENTS, stakedTodayCents: 0, selfExcludedUntil: null },
  profile: { name: '', flag: '🌍', elo: 1200, games: 0, wins: 0 },
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
  /** Local 4-player practice game (you + 3 bots), separate from staked PvP. */
  practice4: boolean;
  /** Online 4-player Sit&Go (ticket entry, up to 4 humans + bot-fill). */
  online4: boolean;
  /** 4-player online stake per seat: 0 = free table, >0 = cUSD staked. */
  online4Stake: number;
  balanceCents: number;
  /** True once the balance comes from a connected wallet (no simulated debits). */
  walletBacked: boolean;
  stakeCents: StakeCents;
  challenge: ChallengeState;
  streak: StreakState;
  league: LeagueState;
  /** Total freeroll tickets; fed by both challenge and streak updates. */
  tickets: number;
  /** Premium dice skins unlocked (server-authoritative; cached for the lobby). */
  ownedSkins: string[];
  /** Own stable profile (identity + ELO + W/L), cached for the lobby card. */
  profile: Profile;
  recentOpponents: RecentOpponent[];
  /** Tap-on-avatar profile sheet: pid being viewed; data null while loading. */
  viewProfile: { pid: string; data: PublicProfile | null; failed?: boolean } | null;
  /** Responsible-gaming limits (E5.2). */
  limits: LimitsState;
  /** Geo-gating (E5.4): staked play disabled in this region. */
  stakingBlocked: boolean;
  match: MatchInfo | null;
  game: GameState | null;
  lastDice: { value: number; index: number; seat: Seat } | null;
  /** Latest emote per seat; `n` bumps each time so the float re-animates. */
  emotes: Record<number, { id: string; n: number }>;
  gifts: Record<number, { id: string; n: number }>;
  /** All rolls this game, for client-side fairness verification (E5.1). */
  diceHistory: Array<{ index: number; value: number; seat: Seat }>;
  turnDeadlineTs: number | null;
  /** Whose turn the HUD shows — updated by the turn event (deferred until a
   *  move finishes animating), so the indicator lags game.turn during a walk. */
  activeTurn: Seat;
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
  soundOn: boolean;
  /** Equipped dice skin id + picker modal state. */
  diceSkin: string;
  avatarFrame: string;
  /** Chosen profile avatar id (AVATARS); 'none' = show the flag instead. */
  avatar: string;
  diceModalOpen: boolean;
  /** 4-player mode chooser (practice / free online / real money) open state. */
  table4Open: boolean;
  profileEditOpen: boolean;
  /** First-session welcome (E6.4): open until the player has been onboarded. */
  onboardOpen: boolean;
  /** Age (18+) + Terms/Privacy consent, required once before staked play. */
  legalAccepted: boolean;
  legalOpen: boolean;
  /** Responsible-gaming reality check: periodic "you've been playing…" reminder. */
  realityOpen: boolean;
}

const ONBOARD_KEY = 'ludo.onboarded';
function firstSession(): boolean {
  try {
    return localStorage.getItem(ONBOARD_KEY) !== '1';
  } catch {
    return false;
  }
}
function markOnboarded(): void {
  try {
    localStorage.setItem(ONBOARD_KEY, '1');
  } catch {
    /* storage unavailable */
  }
}

/** Age (18+) + Terms/Privacy consent, required once before any staked play. */
const LEGAL_KEY = 'ludo.legal.v1';
function legalAcceptedInit(): boolean {
  try {
    return localStorage.getItem(LEGAL_KEY) === '1';
  } catch {
    return false;
  }
}
function markLegalAccepted(): void {
  try {
    localStorage.setItem(LEGAL_KEY, '1');
  } catch {
    /* storage unavailable */
  }
}

export const initialState: AppState = {
  screen: 'lobby',
  practice4: false,
  online4: false,
  online4Stake: 0,
  // No wallet yet → no balance. Staked play REQUIRES a connected wallet (no
  // simulated demo money); the header shows a connect CTA until SET_BALANCE.
  balanceCents: 0,
  walletBacked: false,
  // Default to Free: a cold, wallet-less visitor's first PLAY should be the free
  // practice game the onboarding promises — not a locked 25¢ tile that does nothing.
  stakeCents: 0,
  challenge: loadRetention().challenge,
  streak: loadRetention().streak,
  league: loadRetention().league,
  tickets: loadRetention().tickets,
  ownedSkins: loadRetention().ownedSkins,
  profile: loadRetention().profile,
  viewProfile: null,
  recentOpponents: loadRecentOpponents(),
  limits: loadRetention().limits,
  stakingBlocked: false,
  match: null,
  game: null,
  lastDice: null,
  emotes: {},
  gifts: {},
  diceHistory: [],
  turnDeadlineTs: null,
  activeTurn: 0,
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
  table4Open: false,
  profileEditOpen: false,
  soundOn: soundEnabled(),
  diceSkin: loadSkinId(),
  avatarFrame: loadFrameId(),
  avatar: loadAvatarId(),
  diceModalOpen: false,
  onboardOpen: firstSession(),
  legalAccepted: legalAcceptedInit(),
  legalOpen: false,
  realityOpen: false,
};

export type Action =
  | { type: 'SELECT_STAKE'; stake: StakeCents }
  | { type: 'START_MATCHMAKING'; botMode: boolean }
  | { type: 'START_PRACTICE4' }
  | { type: 'START_ONLINE4'; stakeCents: number }
  | { type: 'MATCH_FOUND'; match: MatchInfo }
  | { type: 'GAME_STATE'; game: GameState }
  | { type: 'DICE'; value: number; index: number; seat: Seat }
  | { type: 'EMOTE'; seat: number; id: string }
  | { type: 'GIFT'; from: number; to: number; id: string }
  | { type: 'CLEAR_EMOTES' }
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
  | { type: 'TICKETS'; total: number }
  | { type: 'OWNED_SKINS'; ownedIds: string[]; tickets?: number }
  | { type: 'PROFILE'; profile: Partial<Profile> }
  | { type: 'PROFILE_VIEW'; pid: string }
  | { type: 'PROFILE_INFO'; pid: string; profile: PublicProfile | null }
  | { type: 'PROFILE_CLOSE' }
  | { type: 'LIMITS_UPDATE'; limits: LimitsState }
  | { type: 'GEO'; stakingBlocked: boolean }
  | { type: 'SET_BALANCE'; cents: number }
  | { type: 'GO_LOBBY' }
  | { type: 'TOAST'; message: string }
  | { type: 'CLEAR_TOAST' }
  | { type: 'FAIR_MODAL'; open: boolean }
  | { type: 'SETTINGS'; open: boolean }
  | { type: 'TOGGLE_SOUND' }
  | { type: 'SET_DICE_SKIN'; id: string }
  | { type: 'EQUIP_FRAME'; id: string }
  | { type: 'EQUIP_AVATAR'; id: string }
  | { type: 'DICE_MODAL'; open: boolean }
  | { type: 'TABLE4_MODAL'; open: boolean }
  | { type: 'PROFILE_EDIT'; open: boolean }
  | { type: 'ONBOARD_DONE' }
  | { type: 'LEGAL_MODAL'; open: boolean }
  | { type: 'ACCEPT_LEGAL' }
  | { type: 'REALITY_CHECK'; open: boolean };

export function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'SELECT_STAKE':
      return { ...s, stakeCents: a.stake };
    case 'START_PRACTICE4':
      return { ...s, screen: 'game', practice4: true, online4: false, match: null, game: null, result: null, lastDice: null, emotes: {}, gifts: {} };
    case 'START_ONLINE4':
      return { ...s, screen: 'game', online4: true, online4Stake: a.stakeCents, practice4: false, match: null, game: null, result: null, lastDice: null, emotes: {}, gifts: {} };
    case 'START_MATCHMAKING':
      return {
        ...s,
        screen: 'matchmaking',
        practice4: false,
        online4: false,
        botMode: a.botMode,
        match: null,
        game: null,
        result: null,
        settleTxHash: null,
        refunded: false,
        lastDice: null,
        diceHistory: [],
        activeTurn: 0,
        turnDeadlineTs: null,
        staking: 'idle',
        privateCode: null,
      };
    case 'MATCH_FOUND':
      return {
        ...s,
        match: a.match,
        privateCode: null, emotes: {}, gifts: {}, // friend joined; the game is starting
        // Balance only ever changes via SET_BALANCE (refreshed from the wallet):
        // staked play requires a wallet, so there is no simulated debit anymore.
      };
    case 'GAME_STATE':
      return { ...s, screen: 'game', game: a.game };
    case 'DICE':
      return {
        ...s,
        lastDice: { value: a.value, index: a.index, seat: a.seat },
        diceHistory: [...s.diceHistory, { index: a.index, value: a.value, seat: a.seat }],
      };
    case 'EMOTE':
      return { ...s, emotes: { ...s.emotes, [a.seat]: { id: a.id, n: (s.emotes[a.seat]?.n ?? 0) + 1 } } };
    case 'GIFT': {
      // the gift floats over the RECIPIENT seat; toast the recipient in 1v1
      const gifts = { ...s.gifts, [a.to]: { id: a.id, n: (s.gifts[a.to]?.n ?? 0) + 1 } };
      const toast = s.match && a.to === s.match.seat && a.from !== a.to ? `${s.match.opponent.name} ${t('giftFrom')} ${a.id}` : s.toast;
      return { ...s, gifts, toast };
    }
    case 'CLEAR_EMOTES':
      return { ...s, emotes: {}, gifts: {} };
    case 'MOVED':
      // Challenge progress is server-authoritative (CHALLENGE_UPDATE), not derived here.
      return { ...s, game: a.game };
    case 'TURN':
      return { ...s, turnDeadlineTs: a.deadlineTs, activeTurn: a.seat };
    case 'GAME_OVER': {
      // On-chain payout is settled by the arbiter (E3.3) and reflected via
      // SET_BALANCE — no simulated credit (staked play requires a wallet).
      const base = { ...s, screen: 'end' as const, result: a.result, settleTxHash: null, refunded: false, reconnecting: false, staking: 'idle' as const };
      // Remember a REAL 1v1 opponent (pid present) + my result — the rivalry
      // ledger. Bots (no pid) and 4-player games are skipped.
      const opp = s.match?.opponent;
      if (opp?.pid && s.match) {
        const won = a.result.winner === s.match.seat;
        const recentOpponents = recordOpponent(s.recentOpponents, opp, won, Date.now());
        saveRecentOpponents(recentOpponents);
        return { ...base, recentOpponents };
      }
      return base;
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
    case 'TICKETS':
      return { ...s, tickets: a.total };
    case 'OWNED_SKINS':
      return { ...s, ownedSkins: a.ownedIds, tickets: a.tickets ?? s.tickets };
    case 'PROFILE': {
      // Merge only defined fields. (The session layer already suppresses profile
      // updates from wallet-less connections, so this never gets anon 0/0 data.)
      const next = { ...s.profile };
      if (a.profile.name) next.name = a.profile.name;
      if (a.profile.flag) next.flag = a.profile.flag;
      if (typeof a.profile.elo === 'number') next.elo = a.profile.elo;
      if (typeof a.profile.games === 'number') next.games = a.profile.games;
      if (typeof a.profile.wins === 'number') next.wins = a.profile.wins;
      if (a.profile.pid) next.pid = a.profile.pid;
      return { ...s, profile: next };
    }
    case 'PROFILE_VIEW':
      return { ...s, viewProfile: { pid: a.pid, data: null } };
    case 'PROFILE_INFO':
      // Ignore stale answers (the sheet moved on to another pid or closed) and a
      // late failure that would overwrite already-loaded data for the same pid.
      if (s.viewProfile?.pid !== a.pid) return s;
      if (a.profile === null && s.viewProfile.data) return s;
      return { ...s, viewProfile: { pid: a.pid, data: a.profile, failed: a.profile === null } };
    case 'PROFILE_CLOSE':
      return { ...s, viewProfile: null };
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
      return { ...s, screen: 'lobby', emotes: {}, gifts: {}, practice4: false, online4: false, match: null, game: null, result: null, reconnecting: false, staking: 'idle', privateCode: null };
    case 'TOAST':
      return { ...s, toast: a.message };
    case 'CLEAR_TOAST':
      return { ...s, toast: null };
    case 'FAIR_MODAL':
      return { ...s, fairModalOpen: a.open };
    case 'SETTINGS':
      return { ...s, settingsOpen: a.open };
    case 'TOGGLE_SOUND': {
      const soundOn = !s.soundOn;
      setSoundEnabled(soundOn);
      return { ...s, soundOn };
    }
    case 'SET_DICE_SKIN':
      saveSkinId(a.id);
      return { ...s, diceSkin: a.id };
    case 'EQUIP_FRAME':
      saveFrameId(a.id);
      return { ...s, avatarFrame: a.id };
    case 'EQUIP_AVATAR':
      saveAvatarId(a.id);
      return { ...s, avatar: a.id };
    case 'DICE_MODAL':
      return { ...s, diceModalOpen: a.open };
    case 'TABLE4_MODAL':
      return { ...s, table4Open: a.open };
    case 'PROFILE_EDIT':
      return { ...s, profileEditOpen: a.open };
    case 'ONBOARD_DONE':
      markOnboarded();
      return { ...s, onboardOpen: false };
    case 'LEGAL_MODAL':
      return { ...s, legalOpen: a.open };
    case 'ACCEPT_LEGAL':
      markLegalAccepted();
      return { ...s, legalAccepted: true, legalOpen: false };
    case 'REALITY_CHECK':
      return { ...s, realityOpen: a.open };
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

/** English money format: $0.25 (symbol first). */
export function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
