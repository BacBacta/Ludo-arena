/**
 * Zealy sprint verification — the endpoint behind the sprint's API quests.
 *
 * When a player claims an API quest, Zealy POSTs the player's identity
 * (including the wallet linked to their Zealy profile) to our endpoint with the
 * quest's check in the query string; a 200 auto-approves the claim, a 400
 * rejects it with a message the player sees. The checks read the SAME durable
 * game history and grant registry as the Race — so a Zealy claim can never
 * assert something the chain and the server didn't witness.
 *
 * Everything here is PURE (no store, no HTTP): the route in index.ts gathers
 * the inputs and serves the verdict, so every rule below is unit-tested.
 */
import type { GameOverReason } from '@ludo/shared';

export type ZealyCheck = 'mint' | 'games4' | 'daily4' | 'win3' | 'marathon25';

const CHECKS: readonly ZealyCheck[] = ['mint', 'games4', 'daily4', 'win3', 'marathon25'];

export function parseZealyCheck(raw: string | null | undefined): ZealyCheck | null {
  return CHECKS.includes(raw as ZealyCheck) ? (raw as ZealyCheck) : null;
}

/** The wallet Zealy knows for the claiming player. Zealy's API-task payload
 *  carries linked accounts under `accounts` — tolerate the shapes seen in the
 *  wild (accounts.wallet as string, or a top-level wallet). Anything that isn't
 *  a 0x-address is treated as absent: the player simply hasn't linked one. */
export function zealyWalletFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { accounts?: { wallet?: unknown }; wallet?: unknown };
  const cand = b.accounts?.wallet ?? b.wallet;
  if (typeof cand !== 'string') return null;
  const w = cand.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(w) ? w : null;
}

/** One durable game, reduced to what the sprint rules need. */
export interface ZealyGame {
  id: string;
  /** The OTHER player's id (lowercased wallet for wallet-backed players). */
  opponent: string;
  won: boolean;
  reason: GameOverReason;
  /** ISO timestamp of the finish. */
  endedAt: string;
  isHouseBot: boolean;
}

export interface ZealyStats {
  /** Race Pass minted + entry claimed (the race:grant registry). */
  minted: boolean;
  /** Genuinely finished games, sprint-wide (abandons/house-bot/voided out). */
  finished: number;
  /** Genuinely finished games today (UTC). */
  finishedToday: number;
  /** Genuine wins today (UTC). */
  winsToday: number;
  /** Distinct opponents across all counted games. */
  opponents: number;
}

/** Fold the game list into the numbers the verdicts read. The filters ARE the
 *  sprint rules: an abandon (resign/timeout) is not a completed game, a game
 *  against the operator house bot is not a real opponent, and a game the
 *  anti-farm audit voided never happened. */
export function zealyStats(games: readonly ZealyGame[], todayUtc: string, voided: ReadonlySet<string>): Omit<ZealyStats, 'minted'> {
  let finished = 0;
  let finishedToday = 0;
  let winsToday = 0;
  const opponents = new Set<string>();
  for (const g of games) {
    if (g.reason !== 'finish' || g.isHouseBot || voided.has(g.id)) continue;
    finished += 1;
    opponents.add(g.opponent);
    if (g.endedAt.slice(0, 10) === todayUtc) {
      finishedToday += 1;
      if (g.won) winsToday += 1;
    }
  }
  return { finished, finishedToday, winsToday, opponents: opponents.size };
}

/** Thresholds per check — one source of truth for verdicts AND messages. */
export const ZEALY_GOALS = { games4: 4, daily4: 4, win3: 3, marathon25: 25, marathonOpponents: 3 } as const;

/** The quest verdict. `ok:false` messages are shown to the player by Zealy, so
 *  they say what progress IS and what still counts — a rejection that reads as
 *  "no" with no reason just generates support pings. */
export function zealyVerdict(check: ZealyCheck, s: ZealyStats): { ok: boolean; message: string } {
  if (!s.minted && check !== 'mint') {
    return { ok: false, message: 'Mint your Race Pass on ludoarena.xyz first (Race tab) — with the wallet linked to your Zealy profile.' };
  }
  switch (check) {
    case 'mint':
      return s.minted
        ? { ok: true, message: 'Race Pass verified on-chain. Welcome to the race!' }
        : { ok: false, message: 'No Race Pass found for your linked wallet. Mint it on ludoarena.xyz (Race tab), and make sure the wallet linked to Zealy is the one you play with.' };
    case 'games4':
      return s.finished >= ZEALY_GOALS.games4
        ? { ok: true, message: `${s.finished} completed games verified. GG!` }
        : { ok: false, message: `${s.finished}/${ZEALY_GOALS.games4} completed games so far — abandoned games don't count. Keep playing!` };
    case 'daily4':
      return s.finishedToday >= ZEALY_GOALS.daily4
        ? { ok: true, message: `${s.finishedToday} completed games today. See you tomorrow!` }
        : { ok: false, message: `${s.finishedToday}/${ZEALY_GOALS.daily4} completed games today (UTC day) — abandons don't count.` };
    case 'win3':
      return s.winsToday >= ZEALY_GOALS.win3
        ? { ok: true, message: `${s.winsToday} wins today. Winner takes the pot!` }
        : { ok: false, message: `${s.winsToday}/${ZEALY_GOALS.win3} wins today (UTC day) — only games your opponent actually finished count.` };
    case 'marathon25': {
      if (s.finished < ZEALY_GOALS.marathon25) {
        return { ok: false, message: `${s.finished}/${ZEALY_GOALS.marathon25} completed games — keep going, your winnings fund the next ones.` };
      }
      return s.opponents >= ZEALY_GOALS.marathonOpponents
        ? { ok: true, message: `${s.finished} games against ${s.opponents} opponents. Marathon complete!` }
        : { ok: false, message: `${s.finished} games but only ${s.opponents} distinct opponents — the marathon needs at least ${ZEALY_GOALS.marathonOpponents}.` };
    }
  }
}
