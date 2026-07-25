/**
 * Race Week scoring + leaderboard. Standalone (the weekly league was retired):
 * every FINISHED event game between two Race Week participants awards points,
 * with anti-wash-trading guards, and a leaderboard reads the top N + a player's
 * own rank. All state lives in the store's meta KV (no new Store methods):
 *   race:board                       → { [wallet]: { name, points } }
 *   race:daily:<wallet>:<day>        → games this player has scored today
 *   race:vs:<wallet>:<opp>:<day>     → games scored vs THIS opponent today
 * so a farmer can't inflate their score by replaying one accomplice all day.
 *
 * The board is a single JSON blob mutated read-modify-write; the whole scoreGame
 * runs under an in-process mutex so concurrent finishes can't lose an update
 * (single Fly process → an async chain is enough, no cross-node coordination).
 */
import type { GameOverReason } from '@ludo/shared';
import type { Store } from './store/types.js';

/** A game the LOSER gave up (resign / timeout-forfeit) rather than a real
 *  finish. Wash-traders throw games this way, so an abandon-win scores less and
 *  a thrown loss earns no participation point. */
function isAbandon(reason: GameOverReason): boolean {
  return reason === 'resign' || reason === 'timeout-forfeit';
}

export interface RaceScoreConfig {
  winPoints: number; // points for winning a genuinely-FINISHED event game
  /** Points for a win the opponent handed over by abandoning (resign/timeout).
   *  Lower than winPoints so a farmer whose accomplice throws games earns less;
   *  0 = an abandon-win scores nothing. */
  abandonWinPoints: number;
  playPoints: number; // participation points for the loser
  /** When true, the loser earns participation points ONLY on a genuine finish —
   *  a player who resigns/times out (throws the game) earns nothing. Kills the
   *  "lose on purpose for the +1" farm. */
  participationRequiresFinish: boolean;
  /** Games vs the SAME opponent that still score in a day. 0 = UNLIMITED. */
  maxVsSamePerDay: number;
  /** Total scored games per player per day. 0 = UNLIMITED. */
  maxScoredPerDay: number;
}

/** Defaults from env. Anti wash-trading guards (hardened after the launch audit
 *  found reciprocal-farming clusters): a win only scores full points on a REAL
 *  finish (an abandon-win is discounted), participation points require a genuine
 *  finish (no reward for throwing a game), only the first 2 wins vs the SAME
 *  opponent per day score, and the total scored games per day stays uncapped by
 *  default. All env-tunable so the guards can be re-balanced with no code change. */
export const DEFAULT_RACE_SCORE: RaceScoreConfig = {
  winPoints: Number(process.env.RACE_WIN_POINTS ?? '3'),
  abandonWinPoints: Number(process.env.RACE_ABANDON_WIN_POINTS ?? '1'),
  playPoints: Number(process.env.RACE_PLAY_POINTS ?? '1'),
  participationRequiresFinish: (process.env.RACE_PARTICIPATION_REQUIRES_FINISH ?? 'true').trim() !== 'false',
  maxVsSamePerDay: Number(process.env.RACE_MAX_VS_SAME_PER_DAY ?? '2'),
  maxScoredPerDay: Number(process.env.RACE_MAX_SCORED_PER_DAY ?? '0'),
};

/** A cap of 0 (or less) means "no cap". */
function underCap(count: number, cap: number): boolean {
  return cap <= 0 || count < cap;
}

export interface BoardEntry {
  wallet: string;
  name: string;
  points: number;
}
interface BoardBlob {
  [wallet: string]: { name: string; points: number };
}

const BOARD_KEY = 'race:board';

/** True iff the wallet is a Race Week participant (claimed its Pass-gated
 *  grant). Only games between two participants score — event games only. */
export async function isRaceParticipant(store: Store, wallet: string): Promise<boolean> {
  return !!(await store.getMeta(`race:grant:${wallet.toLowerCase()}`));
}

async function readBoard(store: Store): Promise<BoardBlob> {
  const raw = await store.getMeta(BOARD_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as BoardBlob;
  } catch {
    return {};
  }
}

async function bumpCounter(store: Store, key: string): Promise<number> {
  const n = Number((await store.getMeta(key)) || '0') + 1;
  await store.setMeta(key, String(n));
  return n;
}
async function readCounter(store: Store, key: string): Promise<number> {
  return Number((await store.getMeta(key)) || '0');
}

// In-process mutex so read-modify-write of the board/counters can't interleave.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

/** Counters a single award decision depends on (all for the game's OWN day). */
export interface AwardCounters {
  /** Games the winner has already SCORED today. */
  winnerDaily: number;
  /** Games the winner has already scored today AGAINST THIS opponent. */
  winnerVsLoser: number;
  /** Games the loser has already scored today. */
  loserDaily: number;
}

/**
 * The award rule for ONE finished event game — PURE, so the live path and the
 * replay (void-race-games) can never drift apart. Extracted from scoreEventGame:
 * an operator voiding a farmed game must recompute the board with EXACTLY the
 * rules that produced it, caps included, or the correction is itself wrong.
 */
export function awardForGame(reason: GameOverReason, counters: AwardCounters, cfg: RaceScoreConfig = DEFAULT_RACE_SCORE): { winnerGained: number; loserGained: number } {
  const abandon = isAbandon(reason);
  // An abandon-win scores the (lower) abandonWinPoints; a real finish the full
  // winPoints. Still subject to the per-opponent + per-day caps.
  const winValue = abandon ? cfg.abandonWinPoints : cfg.winPoints;
  const winnerScores = winValue > 0 && underCap(counters.winnerVsLoser, cfg.maxVsSamePerDay) && underCap(counters.winnerDaily, cfg.maxScoredPerDay);
  // The loser earns participation ONLY on a genuine finish (when configured) —
  // throwing a game (resign/timeout) is worth nothing.
  const loserEligible = !(cfg.participationRequiresFinish && abandon);
  const loserScores = loserEligible && cfg.playPoints > 0 && underCap(counters.loserDaily, cfg.maxScoredPerDay);
  return { winnerGained: winnerScores ? winValue : 0, loserGained: loserScores ? cfg.playPoints : 0 };
}

export interface ScoreInput {
  winnerWallet: string;
  winnerName: string;
  loserWallet: string;
  loserName: string;
  /** How the game ended — 'finish' scores full; an abandon (resign/timeout)
   *  discounts the win and denies the loser participation points. */
  reason: GameOverReason;
  day: string; // utcToday()
}

/** Award points for one finished event game (both players are participants).
 *  Returns the points actually granted (0 when a daily/anti-collusion cap
 *  suppressed scoring — the game still counts for on-chain volume, just not for
 *  the leaderboard). No-op unless BOTH wallets are Race Week participants. */
export async function scoreEventGame(store: Store, input: ScoreInput, cfg: RaceScoreConfig = DEFAULT_RACE_SCORE): Promise<{ winnerGained: number; loserGained: number }> {
  const w = input.winnerWallet.toLowerCase();
  const l = input.loserWallet.toLowerCase();
  if (!(await isRaceParticipant(store, w)) || !(await isRaceParticipant(store, l))) {
    return { winnerGained: 0, loserGained: 0 };
  }
  return serialize(async () => {
    // Anti-wash: the WINNER only scores if under both the per-opponent and the
    // per-day caps (a farmer replaying one accomplice, or grinding all day, is
    // capped). The loser's participation point is under the same daily cap.
    const wDaily = await readCounter(store, `race:daily:${w}:${input.day}`);
    const wVs = await readCounter(store, `race:vs:${w}:${l}:${input.day}`);
    const lDaily = await readCounter(store, `race:daily:${l}:${input.day}`);

    const { winnerGained, loserGained } = awardForGame(input.reason, { winnerDaily: wDaily, winnerVsLoser: wVs, loserDaily: lDaily }, cfg);
    if (winnerGained === 0 && loserGained === 0) return { winnerGained: 0, loserGained: 0 };

    const board = await readBoard(store);
    if (winnerGained > 0) {
      board[w] = { name: input.winnerName, points: (board[w]?.points ?? 0) + winnerGained };
      await bumpCounter(store, `race:daily:${w}:${input.day}`);
      await bumpCounter(store, `race:vs:${w}:${l}:${input.day}`);
    }
    if (loserGained > 0) {
      board[l] = { name: input.loserName, points: (board[l]?.points ?? 0) + loserGained };
      await bumpCounter(store, `race:daily:${l}:${input.day}`);
    }
    await store.setMeta(BOARD_KEY, JSON.stringify(board));
    return { winnerGained, loserGained };
  });
}

/** Top `limit` players + the caller's own rank/points (1-indexed; rank 0 = not
 *  yet on the board). Ties broken by name for a stable order. */
export async function raceLeaderboard(
  store: Store,
  myWallet: string | undefined,
  limit = 20,
): Promise<{ top: Array<BoardEntry & { rank: number }>; myRank: number; myPoints: number }> {
  const board = await readBoard(store);
  const sorted: BoardEntry[] = Object.entries(board)
    .map(([wallet, v]) => ({ wallet, name: v.name, points: v.points }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  const me = myWallet?.toLowerCase();
  const myIndex = me ? sorted.findIndex((e) => e.wallet === me) : -1;
  const top = sorted.slice(0, limit).map((e, i) => ({ ...e, rank: i + 1 }));
  return {
    top,
    myRank: myIndex >= 0 ? myIndex + 1 : 0,
    myPoints: myIndex >= 0 ? sorted[myIndex]!.points : 0,
  };
}

/** One finished event game, as the replay consumes it (chronological order). */
export interface ReplayGame {
  /** Durable game id — what an operator voids. */
  id: string;
  winnerWallet: string;
  winnerName: string;
  loserWallet: string;
  loserName: string;
  reason: GameOverReason;
  /** UTC day key (YYYY-MM-DD) of ended_at — the caps are per-day. */
  day: string;
}

/**
 * Rebuild the leaderboard from the durable game history, SKIPPING voided games.
 *
 * Why rebuild rather than subtract: the board stores only totals, and the award
 * rule is stateful (per-day and per-opponent caps). Subtracting a farmed game's
 * points would leave the caps it consumed still spent, so a legitimate game that
 * was capped out BEHIND the farm would stay unrewarded — the correction would
 * punish the honest player twice. Replaying in chronological order with the
 * voided games removed gives the board the event would have had if those games
 * had never been played, which is exactly what "invalidate" should mean.
 *
 * Pure and deterministic (same games + same voided set ⇒ same board), so an
 * operator can dry-run it, inspect the diff, and re-run it safely. Uses the same
 * awardForGame rule as live scoring, so the two cannot drift.
 */
export function replayRaceBoard(
  games: readonly ReplayGame[],
  voided: ReadonlySet<string>,
  cfg: RaceScoreConfig = DEFAULT_RACE_SCORE,
): { board: BoardBlob; daily: Map<string, number>; vs: Map<string, number> } {
  const board: BoardBlob = {};
  const daily = new Map<string, number>(); // `${wallet}:${day}`
  const vs = new Map<string, number>(); // `${winner}:${loser}:${day}`
  const get = (m: Map<string, number>, k: string): number => m.get(k) ?? 0;

  for (const g of games) {
    if (voided.has(g.id)) continue; // the farmed game never happened
    const w = g.winnerWallet.toLowerCase();
    const l = g.loserWallet.toLowerCase();
    const wDailyKey = `${w}:${g.day}`;
    const lDailyKey = `${l}:${g.day}`;
    const vsKey = `${w}:${l}:${g.day}`;
    const { winnerGained, loserGained } = awardForGame(
      g.reason,
      { winnerDaily: get(daily, wDailyKey), winnerVsLoser: get(vs, vsKey), loserDaily: get(daily, lDailyKey) },
      cfg,
    );
    if (winnerGained > 0) {
      board[w] = { name: g.winnerName, points: (board[w]?.points ?? 0) + winnerGained };
      daily.set(wDailyKey, get(daily, wDailyKey) + 1);
      vs.set(vsKey, get(vs, vsKey) + 1);
    }
    if (loserGained > 0) {
      board[l] = { name: g.loserName, points: (board[l]?.points ?? 0) + loserGained };
      daily.set(lDailyKey, get(daily, lDailyKey) + 1);
    }
  }
  return { board, daily, vs };
}
