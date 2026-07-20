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
import type { Store } from './store/types.js';

export interface RaceScoreConfig {
  winPoints: number; // points for winning an event game
  playPoints: number; // participation points for the loser
  /** Games vs the SAME opponent that still score in a day. 0 = UNLIMITED. */
  maxVsSamePerDay: number;
  /** Total scored games per player per day. 0 = UNLIMITED. */
  maxScoredPerDay: number;
}

/** Defaults from env. A light anti wash-trading guard: only the first 5 wins vs
 *  the SAME opponent per day score (so a single accomplice can't be farmed
 *  endlessly), while the total scored games per player stays UNLIMITED (0) — the
 *  event still optimises for raw on-chain volume. Both are env-tunable (0 = no
 *  cap) so the guard can be loosened or tightened with no code change. */
export const DEFAULT_RACE_SCORE: RaceScoreConfig = {
  winPoints: Number(process.env.RACE_WIN_POINTS ?? '3'),
  playPoints: Number(process.env.RACE_PLAY_POINTS ?? '1'),
  maxVsSamePerDay: Number(process.env.RACE_MAX_VS_SAME_PER_DAY ?? '5'),
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

export interface ScoreInput {
  winnerWallet: string;
  winnerName: string;
  loserWallet: string;
  loserName: string;
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

    const winnerScores = underCap(wVs, cfg.maxVsSamePerDay) && underCap(wDaily, cfg.maxScoredPerDay);
    const loserScores = underCap(lDaily, cfg.maxScoredPerDay);
    const winnerGained = winnerScores ? cfg.winPoints : 0;
    const loserGained = loserScores ? cfg.playPoints : 0;
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
