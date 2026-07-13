/**
 * Client <-> server WebSocket protocol. Source of truth: this file.
 * Any evolution: change here FIRST, then server, then client (see AGENTS.md).
 */
import type { Game4, GameState, Seat } from '@ludo/game-engine';

/** Allowed stakes, in dollar cents (0 = practice). Rationalised to 3 real tiers
 *  (25¢ / $1 / $5) to concentrate matchmaking liquidity instead of splintering it
 *  across six levels. The 10¢/50¢/$2 rungs were dropped: 10¢ floored to only ~5%
 *  effective rake (gas ate the margin), and fewer rungs = fatter queues per rung,
 *  which matters most for the 4-seat staked table that needs four real stakers. */
export const ALLOWED_STAKES_CENTS = [0, 25, 100, 500] as const;
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

/** Anti-tilt bonus (E4.5): after N consecutive staked losses the player is
 *  granted freeroll ticket(s) — a real, spendable reward (see FREEROLL) with no
 *  unbacked cash liability (the old cents-cashback had no payout path). */
export const ANTI_TILT = { losses: 3, rewardTickets: 1 } as const;

/** Daily freeroll (v1): a ticket-gated free 1v1 — entry costs a ticket, the
 *  winner takes both entries plus a house bonus. */
export const FREEROLL = { entryTickets: 1, winnerTickets: 3 } as const;

/** 4-player online Sit&Go paid in freeroll TICKETS (no cUSD escrow yet): seats
 *  fill with real players + bots; entry costs a ticket, winner takes the prize
 *  (1 ticket sinks per game — the ticket-economy equivalent of the rake). */
export const FREEROLL4 = { seats: 4, entryTickets: 1, winnerTickets: 3, botFillMs: 12_000 } as const;

/** 4-player table config. A FREE table fills empty seats with bots after
 *  `botFillMs`; a cUSD-STAKED table needs 4 real stakers (bots have no funds)
 *  and is cancelled + refunded if it doesn't fill within `stakedFillMs`. */
export const TABLE4 = { seats: 4, botFillMs: 12_000, stakedFillMs: 60_000 } as const;

/** Premium cosmetics catalog (rec 6 — revenue that doesn't touch the rake). Each
 *  item is acquirable two independent ways:
 *   • SPENDING freeroll tickets — a soft-currency sink, live today (skin.buy);
 *   • BUYING with cUSD — real treasury revenue, settled on-chain through the
 *     CosmeticsStore contract. That rail stays DORMANT until the store is
 *     deployed (same deferred pattern as the staked 4-player table), so `cents`
 *     is advisory until `cosmeticsStoreAvailable` flips true on the client.
 *  `kind` groups the store UI (dice faces vs board themes). Ownership is one flat
 *  server-authoritative set keyed by id, shared by both rails and both kinds. */
export type CosmeticKind = 'dice' | 'board';
export interface CosmeticItem {
  id: string;
  kind: CosmeticKind;
  tickets: number; // freeroll-ticket price (0 = not ticket-purchasable)
  cents: number; // cUSD price in cents (0 = not cUSD-purchasable)
}
// Dice cosmetics ship first (full skin infra + rendering already exist). Board
// themes are a planned `kind: 'board'` extension — deferred until the board can
// be re-themed without touching gameplay-critical token/cell colours.
export const PREMIUM_COSMETICS: readonly CosmeticItem[] = [
  { id: 'obsidian', kind: 'dice', tickets: 5, cents: 100 },
  { id: 'aurora', kind: 'dice', tickets: 10, cents: 200 },
] as const;

/** Ticket price map, derived for backward compatibility (server spend + skin.buy
 *  validation + the dice picker all key off this). id → ticket price. */
export const PREMIUM_SKINS: Record<string, number> = Object.fromEntries(
  PREMIUM_COSMETICS.filter((c) => c.tickets > 0).map((c) => [c.id, c.tickets]),
);

export function cosmeticById(id: string): CosmeticItem | undefined {
  return PREMIUM_COSMETICS.find((c) => c.id === id);
}
/** cUSD price (cents) for a cosmetic, or 0 if it isn't cUSD-purchasable. */
export function cosmeticCents(id: string): number {
  return cosmeticById(id)?.cents ?? 0;
}

/** Responsible gaming (E5.2): default/max daily stake cap per player, in cents.
 *  Raised from $2 to $5 so the top ($5) tier is playable within a day's cap while
 *  still bounding exposure; a player may always lower their own cap in Settings. */
export const DEFAULT_DAILY_STAKE_LIMIT_CENTS = 500;
export const MAX_DAILY_STAKE_LIMIT_CENTS = 500;

/** Current Terms-of-Service / consent version. Bumped whenever the legal terms
 *  change so a stale acceptance no longer satisfies the staked-play gate; the
 *  server records which version each player accepted (18+/ToS, audit-compliance).
 *  Keep in lockstep with the in-app legal copy. */
export const TOS_VERSION = '2026-07-01';

/** The exact message a client signs to prove wallet ownership (SIWE-style). Both
 *  sides MUST build it identically or verification fails. */
export function walletProofMessage(nonce: string): string {
  return `Ludo Arena — verify wallet ownership.\nNonce: ${nonce}`;
}

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

/** Weekly league reward (E4.3): the top N of each division get freeroll tickets
 *  on rollover, scaled by division (Bronze top-3 → 1 … Diamond top-3 → 5). A
 *  bounded weekly faucet that finally makes climbing the league worth something. */
export const LEAGUE_REWARD_TOP = 3;
export function leagueRewardTickets(division: number): number {
  return division + 1;
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

/** 4-player winner payout = 4·stake − rake (same rounding as potCents). */
export function potCents4(stake: number): number {
  const pot = stake * 4;
  return pot - Math.floor((pot * RAKE_BPS) / 10_000);
}

// ---------- Client -> Server ----------

export type ClientMsg =
  // Anti-grinding: new clients send `entropyCommit` = sha256(entropy) and reveal
  // the raw `entropy` via `game.entropy` after match.found. `entropy` is kept
  // optional for backward compatibility with clients that still send it raw.
  | {
      t: 'hello';
      wallet?: string;
      sessionToken?: string;
      entropy?: string;
      entropyCommit?: string;
      fingerprint?: string;
      // 18+/ToS consent the client has recorded locally; the server persists it
      // (per wallet) and requires a match to the current TOS_VERSION for staked play.
      consent?: { tosVersion: string; age18: boolean };
    }
  // Wallet ownership proof (SIWE-style): sign the `walletNonce` from hello.ok so
  // the server can bind RG limits / self-exclusion to a *verified* address.
  | { t: 'wallet.prove'; signature: string }
  // Reveal this session's raw entropy (verified against the hello commit) — sent
  // once, right after match.found, before the game's dice are finalized.
  | { t: 'game.entropy'; entropy: string }
  | { t: 'queue.join'; stake: StakeCents; freeroll?: boolean }
  // 4-player online table. stakeCents 0 (or omitted) = FREE table (bot-fill);
  // an allowed cUSD stake = staked table (4 real stakers, escrow pot).
  // roll/move/resign are reused.
  | { t: 'queue.join4'; stakeCents?: number }
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
  // Unlock a premium dice skin by spending its ticket price (PREMIUM_SKINS).
  | { t: 'skin.buy'; skinId: string }
  // Claim a cosmetic bought with cUSD on-chain (CosmeticsStore): the server
  // verifies the tx emitted Purchased(buyer=provenWallet, itemId=keccak(id))
  // before granting ownership. Dormant until the store is deployed (rec 6).
  | { t: 'cosmetic.claim'; txHash: string; id: string }
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
      limits?: LimitsState; // responsible-gaming state (E5.2)
      ownedSkins?: string[]; // premium skins the player has unlocked (server-authoritative)
      stakingBlocked?: boolean; // geo-gated region, staked play disabled (E5.4)
      // Wallet ownership proof (SIWE): if a wallet was supplied but isn't proven
      // yet, `walletNonce` is the string to sign; `walletProven` reflects state.
      walletNonce?: string;
      walletProven?: boolean;
      // The ToS version the server has on record as accepted for this player (so
      // the client knows whether it must re-prompt before staked play).
      consentTosVersion?: string;
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
  // Freeroll tickets granted (anti-tilt bonus E4.5, or a freeroll win).
  | { t: 'tickets.grant'; granted: number; total: number; reason: 'anti-tilt' | 'freeroll-win' | 'sync' }
  // Premium-skin ownership after a successful skin.buy (spend confirmed), with the
  // player's full owned list and new ticket total.
  | { t: 'skin.owned'; ownedIds: string[]; tickets: number }
  // Responsible-gaming state after hello or a limits.set (E5.2).
  | { t: 'limits.update'; limits: LimitsState }
  // ---- 4-player online (Game4 state; seats 0-3) ----
  | {
      t: 'match.found4';
      gameId: string;
      seat: number; // 0-3
      players: Player4Info[]; // index = seat
      entryTickets: number; // legacy ticket entry (0 for free/cUSD tables)
      prizeTickets: number; // legacy ticket prize (0 for free/cUSD tables)
      stakeCents: number; // 0 = free table; >0 = cUSD stake per seat
      potCents: number; // winner's cUSD payout (4*stake - rake); 0 for free
      fairnessCommit: string;
    }
  | { t: 'game.state4'; state: Game4 }
  | { t: 'game.dice4'; value: number; index: number; seat: number }
  | { t: 'game.moved4'; seat: number; token: number; capture: boolean; state: Game4 }
  | { t: 'game.turn4'; seat: number; deadlineTs: number }
  | {
      t: 'game.over4';
      winner: number; // 0-3
      prizeTickets: number; // legacy ticket prize (0 for free/cUSD)
      payoutCents: number; // winner's cUSD payout (0 for free)
      rakeCents: number; // rake taken from the pot (0 for free)
      fairnessReveal: { serverSeed: string; seeds: string[] };
    }
  // 4-player on-chain settlement confirmed (arbiter settle() mined).
  | { t: 'game.settled4'; gameId: string; txHash: string; winner: number }
  // 4-player stake refunded on-chain (table didn't fill, or a stuck game).
  | { t: 'game.refunded4'; gameId: string; txHash: string }
  | { t: 'error'; code: ErrorCode; message: string }
  | { t: 'pong' };

/** A seat in a 4-player game (real player or bot). */
export interface Player4Info {
  name: string;
  flag: string;
  bot: boolean;
}

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
    case 'hello': {
      const commitOk = typeof m.entropyCommit === 'string' && /^[0-9a-f]{64}$/.test(m.entropyCommit);
      const rawOk = typeof m.entropy === 'string' && m.entropy.length >= 16 && m.entropy.length <= 128;
      if (!commitOk && !rawOk) return null; // need a commit (new) or raw entropy (legacy)
      if (m.fingerprint !== undefined && (typeof m.fingerprint !== 'string' || m.fingerprint.length > 64)) return null;
      if (m.consent !== undefined) {
        const c = m.consent as { tosVersion?: unknown; age18?: unknown };
        if (typeof c !== 'object' || c === null || typeof c.tosVersion !== 'string' || c.tosVersion.length > 32 || typeof c.age18 !== 'boolean') return null;
      }
      return m;
    }
    case 'wallet.prove':
      return typeof m.signature === 'string' && /^0x[0-9a-fA-F]{130,3000}$/.test(m.signature) ? m : null;
    case 'game.entropy':
      return typeof m.entropy === 'string' && m.entropy.length >= 16 && m.entropy.length <= 128 ? m : null;
    case 'skin.buy':
      return typeof m.skinId === 'string' && Object.prototype.hasOwnProperty.call(PREMIUM_SKINS, m.skinId) ? m : null;
    case 'cosmetic.claim':
      return typeof m.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(m.txHash) && typeof m.id === 'string' && cosmeticById(m.id) !== undefined ? m : null;
    case 'queue.join':
      if (m.freeroll !== undefined && typeof m.freeroll !== 'boolean') return null;
      return (ALLOWED_STAKES_CENTS as readonly number[]).includes(m.stake) ? m : null;
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
    case 'queue.join4':
      // free (0/undefined) or a supported cUSD stake only
      return m.stakeCents === undefined || (ALLOWED_STAKES_CENTS as readonly number[]).includes(m.stakeCents) ? m : null;
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
