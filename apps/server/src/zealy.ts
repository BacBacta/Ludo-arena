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

export type ZealyCheck = 'mint' | 'games1' | 'daily1' | 'games4' | 'daily4' | 'win3' | 'marathon25';

const CHECKS: readonly ZealyCheck[] = ['mint', 'games1', 'daily1', 'games4', 'daily4', 'win3', 'marathon25'];

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

/** The Zealy user id from an API-task payload sent with "Zealy Connect"
 *  identification. Field name tolerant (their payload shape has varied):
 *  accounts['zealy-connect'] / accounts.zealyConnect / userId / id / user.id.
 *  Lowercased so binding lookups are case-stable (UUIDs compare fine). */
export function zealyUserIdFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as {
    accounts?: { [k: string]: unknown };
    userId?: unknown;
    id?: unknown;
    user?: { id?: unknown };
  };
  const cands = [b.accounts?.['zealy-connect'], b.accounts?.zealyConnect, b.userId, b.id, b.user?.id];
  for (const c of cands) {
    if (typeof c === 'string') {
      const v = c.trim().toLowerCase();
      if (/^[a-z0-9_-]{8,64}$/.test(v)) return v;
    }
  }
  return null;
}

/** Extract a Zealy user id from whatever the player pasted: their profile LINK
 *  (…zealy.io/cw/<community>/users/<id>, query/hash tolerated) or the raw id.
 *  Null = nothing id-shaped in there. */
export function parseZealyProfileId(input: string | null | undefined): string | null {
  if (!input) return null;
  let v = input.trim();
  if (v.includes('zealy.io')) {
    const path = v.split(/[?#]/)[0] ?? '';
    const segs = path.split('/').filter(Boolean);
    v = segs[segs.length - 1] ?? '';
  }
  v = v.toLowerCase();
  return /^[a-z0-9_-]{8,64}$/.test(v) ? v : null;
}

/** Payload shape probe for telemetry when identification fails: top-level and
 *  accounts KEY NAMES only (never values) — tells us what Zealy actually sends
 *  so the tolerant parser can be extended from logs instead of guesses. */
export function zealyPayloadKeys(body: unknown): string {
  if (!body || typeof body !== 'object') return '(none)';
  const b = body as { accounts?: object };
  const top = Object.keys(b).join(',');
  const acc = b.accounts && typeof b.accounts === 'object' ? ` accounts:[${Object.keys(b.accounts).join(',')}]` : '';
  return (top + acc) || '(none)';
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
 *  sprint rules: an abandon (resign/timeout) is not a completed game, and a
 *  game the anti-farm audit voided never happened.
 *
 *  House-bot games COUNT for the player (operator decision, sprint launch):
 *  the bot exists to fill matchmaking at quiet hours, and a real staked
 *  on-chain game against it costs the player the same 1c and pays the same
 *  pot — punishing the player for the platform's own liquidity fill reads as
 *  a rigged quest. Farming the bot stays bounded elsewhere: the bot never
 *  earns XP (it has no Zealy account), the per-pair daily staked cap limits
 *  grinding one opponent, every win against the bot costs the HOUSE money
 *  (runway), and the marathon still demands 3 distinct opponents — the bot
 *  can only ever be one of them. */
export function zealyStats(games: readonly ZealyGame[], todayUtc: string, voided: ReadonlySet<string>): Omit<ZealyStats, 'minted'> {
  let finished = 0;
  let finishedToday = 0;
  let winsToday = 0;
  const opponents = new Set<string>();
  for (const g of games) {
    if (g.reason !== 'finish' || voided.has(g.id)) continue;
    finished += 1;
    opponents.add(g.opponent);
    if (g.endedAt.slice(0, 10) === todayUtc) {
      finishedToday += 1;
      if (g.won) winsToday += 1;
    }
  }
  return { finished, finishedToday, winsToday, opponents: opponents.size };
}

/** Thresholds per check — one source of truth for verdicts AND messages.
 *  `games1` is the ACTIVATION rung: the sprint's first game quest asked for 4,
 *  which is ~15 minutes of play before any reward, and production showed the
 *  leak exactly there (12 Passes minted in a day against ~6 staked games). One
 *  finished game is ~3 minutes — a claim the player can reach while they still
 *  have the app open.
 *
 *  `daily1` is that same rung fenced to TODAY, and it is the one the sprint
 *  should publish: a lifetime counter is retroactive, so every player who had
 *  already played collected the reward without playing again — the opposite of
 *  what an activation quest is for. Windowed to the UTC day, nobody can claim
 *  without playing, and a newcomer who just minted still clears it with their
 *  first 3-minute game. */
export const ZEALY_GOALS = { games1: 1, daily1: 1, games4: 4, daily4: 4, win3: 3, marathon25: 25, marathonOpponents: 3 } as const;

/** Compact 0x1234…abcd for player-facing messages. */
export function shortWallet(wallet: string | null | undefined): string {
  return wallet && wallet.length >= 12 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : 'your linked wallet';
}

/** The quest verdict. `ok:false` messages are shown to the player by Zealy, so
 *  they say what progress IS and what still counts — a rejection that reads as
 *  "no" with no reason just generates support pings. The wallet Zealy sent is
 *  echoed back in mint rejections: the dominant failure in production is the
 *  player linking a DIFFERENT wallet to Zealy than the one they play with, and
 *  seeing the concrete address is what makes that click. */
export function zealyVerdict(check: ZealyCheck, s: ZealyStats, wallet?: string): { ok: boolean; message: string } {
  const w = shortWallet(wallet);
  if (!s.minted && check !== 'mint') {
    return { ok: false, message: `No Race Pass found for ${w} (the wallet linked to your Zealy profile). Play on ludoarena.xyz with THAT wallet (connect MetaMask via "Switch wallet"), or link your game wallet on Zealy: Profile → Linked accounts.` };
  }
  switch (check) {
    case 'mint':
      return s.minted
        ? { ok: true, message: 'Race Pass verified on-chain. Welcome to the race!' }
        : { ok: false, message: `No Race Pass found for ${w} (the wallet linked to your Zealy profile) — is this the wallet you play with? Mint on ludoarena.xyz (Race tab) with THIS wallet, or link the right one on Zealy: Profile → Linked accounts.` };
    case 'games1':
      return s.finished >= ZEALY_GOALS.games1
        ? { ok: true, message: 'Your first game is on-chain. Welcome to the arena!' }
        : { ok: false, message: `No completed game yet for ${w} — open the Race tab and play your first 1v1. It takes about 3 minutes, and a game you leave mid-match doesn't count.` };
    case 'daily1':
      return s.finishedToday >= ZEALY_GOALS.daily1
        ? { ok: true, message: 'One game played today. Come back tomorrow!' }
        : { ok: false, message: `No game finished today for ${w} — open the Race tab and play one 1v1. It takes about 3 minutes (UTC day; a game you leave mid-match doesn't count).` };
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
