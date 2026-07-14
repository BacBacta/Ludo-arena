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

/** In-game quick emotes: a FIXED, curated, positive/neutral set (no free text →
 *  no moderation surface, no harassment vector in a real-money game). Server
 *  rate-limits per seat. Ids are the emoji themselves. */
export const EMOTES = ['👍', '😂', '🔥', '😎', '🎉', '👏', '🤯', '😮', '😢', '💪', '🍀', '🎲'] as const;
export type Emote = (typeof EMOTES)[number];

/** Quick-chat presets: closed, localized-client-side ids (same zero-free-text
 *  policy as EMOTES). They travel on the SAME game.emote channel (same per-seat
 *  throttle); the client renders them as a speech bubble instead of an emoji. */
export const QUICK_CHATS = ['gg', 'ouch', 'hurry', 'rematch', 'gl', 'wow'] as const;
export type QuickChat = (typeof QUICK_CHATS)[number];

/** True when a game.emote id is a quick-chat preset (vs a plain emoji emote). */
export function isQuickChat(id: string): id is QuickChat {
  return (QUICK_CHATS as readonly string[]).includes(id);
}

/** Directed gifts (E-social): a small item you send to ONE chosen opponent in
 *  the current game (vs an emote, which broadcasts your own reaction). Free +
 *  server-throttled per sender. A fixed, friendly, curated set — no free text. */
export const GIFTS = ['☕', '🌹', '🍫', '🎁', '🍕', '🧋', '🍺', '🎂'] as const;
export type Gift = (typeof GIFTS)[number];
export function isGift(id: string): id is Gift {
  return (GIFTS as readonly string[]).includes(id);
}

/**
 * Public player profile (E-social): what ANY player may see about another by
 * tapping their avatar. Keyed by `pid` — an opaque server-derived hash, NEVER a
 * wallet address (MiniPay rule: no raw 0x surfaces) and NEVER reversible client-side.
 */
export interface PublicProfile {
  pid: string;
  name: string;
  flag: string;
  elo: number;
  games: number;
  wins: number;
  division: number; // index into DIVISIONS
  /** Equipped avatar frame id (AVATAR_FRAMES); absent = 'none'. */
  frame?: string;
  /** Chosen profile avatar id (AVATARS); absent/'none' = show the flag. */
  avatar?: string;
  /** Head-to-head vs the REQUESTER (their wins/losses against this player);
   *  present only when both identities are known to the server. */
  h2h?: { wins: number; losses: number };
}

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

/**
 * Avatar frames (E-social C3): a cosmetic ring around a player's avatar, visible
 * to EVERYONE (own profile card, in-game corners, the tap-to-view profile sheet)
 * — the first cosmetic that others actually see, which is the whole point after
 * profiles landed. Ids are the shared allowlist; the visual spec + progression
 * unlock rules live client-side (avatarFrames.ts). Frames are cosmetic-only and
 * client-equipped (sent in hello): the server just validates the id is real and
 * echoes it, exactly like the dice-skin trust model (no money → no proof). */
export const AVATAR_FRAMES = ['none', 'bronze', 'silver', 'gold', 'champion', 'neon'] as const;
export type AvatarFrame = (typeof AVATAR_FRAMES)[number];
export function isAvatarFrame(id: string): id is AvatarFrame {
  return (AVATAR_FRAMES as readonly string[]).includes(id);
}

/**
 * Profile avatars (E-social): a premium 3D character picture the player may set
 * as their identity INSTEAD of a bare flag — diverse by gender + skin tone, plus
 * a few character variants. Like frames, the id is the shared allowlist while the
 * images live client-side (apps/web/public/avatars, `av_<id>.png`); the server
 * just validates + echoes + persists the id (client-authoritative, no proof —
 * same trust model as frames/skins). `'none'` = fall back to the flag.
 */
export const AVATARS = [
  'none',
  // Person · Man · Woman, each across 6 skin tones (default + light→dark)
  'person_default', 'person_light', 'person_medium-light', 'person_medium', 'person_medium-dark', 'person_dark',
  'man_default', 'man_light', 'man_medium-light', 'man_medium', 'man_medium-dark', 'man_dark',
  'woman_default', 'woman_light', 'woman_medium-light', 'woman_medium', 'woman_medium-dark', 'woman_dark',
  // character variants (varied tones for diversity)
  'artist_dark', 'astronaut_medium-dark', 'student_medium', 'person_with_crown_light',
  'older_person_medium-dark', 'ninja_medium-light', 'health_worker_medium',
] as const;
export type Avatar = (typeof AVATARS)[number];
export function isAvatar(id: string): id is Avatar {
  return (AVATARS as readonly string[]).includes(id);
}

/** Editable-profile display-name bounds (shared by the client input + the server
 *  sanitizer). Short enough to fit the identity chip; long enough for a handle. */
export const PROFILE_NAME_MIN = 3;
export const PROFILE_NAME_MAX = 16;

/** A country flag emoji is either the neutral globe or exactly TWO Unicode
 *  regional-indicator symbols (U+1F1E6–U+1F1FF). This lets the server validate a
 *  custom flag without a 250-entry allowlist (any real country flag passes; a
 *  crafted emoji / text does not). Shared so the client picker agrees. */
export function isFlagEmoji(s: string): boolean {
  if (s === '🌍') return true;
  const cps = [...s].map((c) => c.codePointAt(0) ?? 0);
  return cps.length === 2 && cps.every((cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff);
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
  /** Opaque public id for profile.get (tap-on-leaderboard-row). */
  pid?: string;
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
      /** Equipped avatar frame id (cosmetic, client-authoritative like skins). */
      frame?: string;
      /** Chosen profile avatar id (AVATARS); client-authoritative like the frame. */
      avatar?: string;
      /** Custom display name (E-social: editable profile). Server SANITIZES it
       *  (length, charset, profanity/URL filter); an invalid value falls back to
       *  the derived name — the connection is never rejected over a cosmetic name. */
      name?: string;
      /** Custom country flag emoji (editable profile). Server validates it is a
       *  real flag; otherwise the derived/geo flag is used. */
      flag?: string;
      // 18+/ToS consent the client has recorded locally; the server persists it
      // (per wallet) and requires a match to the current TOS_VERSION for staked play.
      consent?: { tosVersion: string; age18: boolean };
      // True when running inside MiniPay: the wallet is auto-connected and trusted,
      // and MiniPay does NOT support personal_sign — so the server accepts the
      // address as proven WITHOUT a SIWE signature (which would fail there).
      miniPay?: boolean;
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
  // Send a quick emote or quick-chat to the current game (1v1 or 4p); id must
  // be in EMOTES or QUICK_CHATS (closed sets — no free text, ever).
  | { t: 'emote'; id: string }
  // Send a directed GIFT to one opponent seat in the current game (1v1 or 4p).
  | { t: 'gift'; to: number; id: string }
  // Fetch another player's public profile by their opaque pid (tap-on-avatar).
  | { t: 'profile.get'; pid: string }
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
  /** Opaque public id for profile.get (tap-on-avatar); absent for bots. */
  pid?: string;
  /** Equipped avatar frame id (AVATAR_FRAMES); absent = 'none'. */
  frame?: string;
  /** Chosen profile avatar id (AVATARS); absent/'none' = show the flag. */
  avatar?: string;
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
      // Own stable profile (identity): derived name + country flag + W/L record.
      // MiniPay: never surface a raw 0x address — this is the display identity.
      name?: string;
      flag?: string;
      games?: number;
      wins?: number;
      /** My own opaque public id (what others use to view my profile). */
      pid?: string;
      /** My own equipped avatar frame (echoed so a fresh client re-syncs it). */
      frame?: string;
      /** My own chosen profile avatar (echoed so a fresh client re-syncs it). */
      avatar?: string;
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
  // A player sent a quick emote (broadcast to the room; seat 0-3 for 1v1/4p).
  | { t: 'game.emote'; seat: number; id: string }
  // A gift `from` a seat was sent `to` another seat (id in GIFTS).
  | { t: 'game.gift'; from: number; to: number; id: string }
  // The turn clock expired and the server played automatically for a slow or
  // absent player; after `max` consecutive auto-plays the seat forfeits. Sent so
  // clients can EXPLAIN the pacing instead of looking silently stuck (UX).
  | { t: 'game.auto'; seat: Seat; count: number; max: number }
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
  // Another player's public profile (answer to profile.get); `pid` echoes the
  // request so a stale answer can't fill the wrong sheet.
  | { t: 'profile.info'; profile: PublicProfile }
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
  /** Opaque public id for profile.get (tap-on-avatar); absent for bots. */
  pid?: string;
  /** Equipped avatar frame id (AVATAR_FRAMES); absent = 'none'. */
  frame?: string;
  /** Chosen profile avatar id (AVATARS); absent/'none' = show the flag. */
  avatar?: string;
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
      if (m.miniPay !== undefined && typeof m.miniPay !== 'boolean') return null;
      // Frame is a cosmetic id: drop an unknown value rather than reject the
      // whole hello (a client on a newer catalog must still connect).
      if (m.frame !== undefined && (typeof m.frame !== 'string' || !isAvatarFrame(m.frame))) m.frame = undefined;
      // Avatar id: same cosmetic trust — drop an unknown value, never reject.
      if (m.avatar !== undefined && (typeof m.avatar !== 'string' || !isAvatar(m.avatar))) m.avatar = undefined;
      // Custom name: loose bound here (≤64 raw); the server sanitizes/filters.
      // Drop obviously-bad values instead of rejecting the connection.
      if (m.name !== undefined && (typeof m.name !== 'string' || m.name.length > 64)) m.name = undefined;
      // Custom flag: must be a real flag emoji, else drop → server derives.
      if (m.flag !== undefined && (typeof m.flag !== 'string' || !isFlagEmoji(m.flag))) m.flag = undefined;
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
    case 'emote':
      return typeof m.id === 'string' && ((EMOTES as readonly string[]).includes(m.id) || isQuickChat(m.id)) ? m : null;
    case 'gift':
      return typeof m.id === 'string' && isGift(m.id) && typeof m.to === 'number' && m.to >= 0 && m.to <= 3 ? m : null;
    case 'profile.get':
      // opaque pid: short hex hash — reject anything else (never a wallet)
      return typeof m.pid === 'string' && /^[0-9a-f]{8,32}$/.test(m.pid) ? m : null;
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
