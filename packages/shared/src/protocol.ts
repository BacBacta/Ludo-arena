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

/** DEFAULT house share, in basis points (900 = 9%) — the fallback for any stake
 *  without a per-tier entry, and what the escrows snapshot when no tier rake is
 *  configured on-chain. */
export const RAKE_BPS = 900;

/** Degressive per-tier rake (bps). The flat 9% under-monetised the acquisition
 *  tier (where fixed settlement gas rivals the fee) and over-taxed the retention
 *  tier (where the most rake-productive players live) — the inverse of the cost
 *  structure. Mirrored on-chain via LudoEscrow{,N}.setTierRakeBps(token, stake,
 *  bps) — seeded by the deploy script; the contract snapshots the tier rake per
 *  game at join, so this display table MUST be kept in step with the deployed
 *  configuration (same rule as RAKE_BPS before it). */
export const RAKE_BPS_BY_STAKE: Readonly<Record<number, number>> = {
  25: 1000, // 10% — acquisition tier, carries the per-settlement gas overhead
  100: 800, // 8%
  500: 600, // 6% — retention tier, priced to keep high-stake players
};

/** The rake (bps) for a stake, falling back to the flat default. */
export function rakeBpsFor(stakeCents: number): number {
  return RAKE_BPS_BY_STAKE[stakeCents] ?? RAKE_BPS;
}

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

/** Streak-freeze (season Phase 3): a ticket-bought item that protects the login
 *  streak across ONE missed day (loss-aversion retention + a ticket sink). Also
 *  granted by the season track (streakFreeze reward). `max` caps hoarding. */
export const STREAK_FREEZE = { ticketCost: 4, max: 3 } as const;

export interface StreakState {
  days: number; // current consecutive-day streak
  tickets: number; // total freeroll tickets held (shared with the challenge)
  rewardGranted: number; // tickets granted by this login's milestone (0 if none)
  freezes?: number; // streak-freezes held (inventory)
  freezeUsed?: boolean; // a freeze was consumed on THIS login to bridge a missed day
  daysAway?: number; // days since the previous login (for the win-back offer); 0/1 = active
}

/** Win-back / comeback offer (season Phase 3): returning after an absence grants
 *  non-cashable tickets, tiered by days away. NEVER for self-excluded / limit-hit
 *  players (RG). The stake-only credit tier (14-30d) is deferred — it needs a
 *  non-withdrawable stake-credit primitive that doesn't exist yet. */
export const WINBACK_TIERS: ReadonlyArray<{ minDaysAway: number; tickets: number }> = [
  { minDaysAway: 7, tickets: 5 },
  { minDaysAway: 3, tickets: 2 },
];
/** The comeback reward for `daysAway`, or null if below the first threshold. */
export function winbackFor(daysAway: number): { minDaysAway: number; tickets: number } | null {
  return WINBACK_TIERS.find((tier) => daysAway >= tier.minDaysAway) ?? null;
}
export interface Comeback {
  daysAway: number;
  tickets: number;
}

/** Anti-tilt bonus (E4.5): after N consecutive staked losses the player is
 *  granted freeroll ticket(s) — a real, spendable reward (see FREEROLL) with no
 *  unbacked cash liability (the old cents-cashback had no payout path). */
export const ANTI_TILT = { losses: 3, rewardTickets: 1 } as const;

/** Daily freeroll: a ticket-gated free 1v1. Net-neutral-leaning by design — each
 *  of the 2 players stakes `entryTickets`, the winner takes `winnerTickets`
 *  (2·2 = 4 in / 3 out = a slight SINK, not a faucet). This is deliberate: the
 *  economy sim showed a house-bonus faucet here drives runaway ticket inflation,
 *  so the freeroll now gently removes tickets from circulation instead. */
export const FREEROLL = { entryTickets: 2, winnerTickets: 3 } as const;

// ---- Season pass (anti-churn keystone) — see docs/SEASON_PASS_SPEC.md ---------
/** Crowns are earned by playing and fill a ~28-day track of TIERS; each tier
 *  grants a reward. Crowns never convert to money; the pass is the wealth-
 *  proportional ticket sink AND the main retention driver. */
export const SEASON = {
  tierCount: 50,
  durationDays: 28,
  crownPerGame: 10,
  winBonus: 5,
  firstWinDaily: 15,   // first win of the UTC day
  challengeDaily: 20,  // daily challenge completed
  softCapGames: 10,    // beyond this many games/day, per-game crowns decay…
  softCapCrown: 3,     // …to this (anti-grind, preserves 28-day pacing)
  // front-loaded tier cost: first `frontTiers` cheap → fast early rewards (D1 hook)
  frontTiers: 5,
  frontCost: 30,
  laterCost: 55,
} as const;

/** Premium season pass (Phase 2): a one-time-per-season USDT purchase that unlocks
 *  the premium reward lane. Bought through the existing CosmeticsStore rail — the
 *  server verifies the on-chain Purchased(buyer, keccak(itemId)) like a cosmetic.
 *  `itemId` is the store catalogue key; `cents` is the price ($1.50 = a conversion
 *  loss-leader, see docs/SEASON_PASS_SPEC.md §4). */
export const SEASON_PREMIUM = { itemId: 'season-premium', cents: 150 } as const;

/** Cumulative crowns needed to REACH tier t (1..tierCount). */
export function crownsForTier(t: number): number {
  if (t <= 0) return 0;
  const f = Math.min(t, SEASON.frontTiers);
  const l = Math.max(0, t - SEASON.frontTiers);
  return f * SEASON.frontCost + l * SEASON.laterCost;
}
/** The tier a player has REACHED with `crowns` (0..tierCount). */
export function tierFromCrowns(crowns: number): number {
  let t = 0;
  while (t < SEASON.tierCount && crownsForTier(t + 1) <= crowns) t++;
  return t;
}

export type RewardKind = 'tickets' | 'cosmetic' | 'streakFreeze' | 'crownBoost' | 'title';
export interface Reward {
  kind: RewardKind;
  amount?: number; // tickets count, or boost % (e.g. 25)
  id?: string;     // cosmetic / title id
}
export interface TierDef {
  tier: number; // 1..tierCount
  free: Reward;
  premium: Reward;
}
export interface SeasonState {
  id: number;
  endsAt: string; // ISO
  tierCount: number;
  crowns: number; // THIS player's crowns this season
  tier: number;   // reached tier (0..tierCount)
  premium: boolean;
  claimedFree: number[];
  claimedPrem: number[];
  tiers: TierDef[]; // the reward table (content)
}

/** Season-exclusive dice-skin pool (season Phase 4 — content cadence). These are
 *  PASS-ONLY: never unlockable by progression or purchasable, so owning one is a
 *  season badge of honour (scarcity/status, §10). The visuals are procedural (no
 *  art assets) and live in the client's DICE_SKINS. Each season draws a distinct
 *  set via `seasonSkinsFor`; the recurring content task APPENDS new ids here so the
 *  rotation keeps producing fresh exclusives (docs/SEASON_PASS_SPEC.md §4-Content). */
export const SEASON_SKINS: readonly string[] = [
  'season-aurora', 'season-crimson', 'season-abyss', 'season-verdant',
  'season-solar', 'season-frost', 'season-void', 'season-royal',
];
/** The `count` season-exclusive skins for a season, rotating so consecutive
 *  seasons get disjoint sets until the pool wraps (then the art task has appended
 *  more). Deterministic → the same season always yields the same set. */
export function seasonSkinsFor(seasonId: number, count: number): string[] {
  const base = ((seasonId - 1) * count) % SEASON_SKINS.length;
  return Array.from({ length: count }, (_, i) => SEASON_SKINS[(base + i) % SEASON_SKINS.length]!);
}

/** The season reward table (content) for `seasonId`. Rhythm per §15: no empty
 *  tier; free = tickets + streak-freeze at 15/35 + a season-exclusive skin at
 *  25/50; premium = crown boost early, exclusive skins at 20/40, a legendary title
 *  at 50. Cosmetic ids are the season's own exclusives (rotated per season). */
export function seasonTiers(seasonId = 1): TierDef[] {
  const [freeA, freeB, premA, premB] = seasonSkinsFor(seasonId, 4);
  const tiers: TierDef[] = [];
  for (let t = 1; t <= SEASON.tierCount; t++) {
    const free: Reward =
      t === 25 ? { kind: 'cosmetic', id: freeA }
      : t === SEASON.tierCount ? { kind: 'cosmetic', id: freeB }
      : t === 15 || t === 35 ? { kind: 'streakFreeze', amount: 1 }
      : { kind: 'tickets', amount: t % 5 === 0 ? 3 : 2 };
    const premium: Reward =
      t === 3 ? { kind: 'crownBoost', amount: 25 }
      : t === SEASON.tierCount ? { kind: 'title', id: `season-${seasonId}-legend` }
      : t === 20 ? { kind: 'cosmetic', id: premA }
      : t === 40 ? { kind: 'cosmetic', id: premB }
      : { kind: 'tickets', amount: t % 5 === 0 ? 5 : 3 };
    tiers.push({ tier: t, free, premium });
  }
  return tiers;
}

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
export type CosmeticKind = 'dice' | 'board' | 'token' | 'entrance' | 'victory' | 'frame';
export interface CosmeticItem {
  id: string;
  kind: CosmeticKind;
  tickets: number; // freeroll-ticket price (0 = not ticket-purchasable)
  cents: number; // cUSD price in cents (0 = not cUSD-purchasable)
}
// Dice cosmetics ship first (full skin infra + rendering already exist). Board
// themes are a planned `kind: 'board'` extension — deferred until the board can
// be re-themed without touching gameplay-critical token/cell colours.
//
// TICKET prices follow the calibrated economy model (SEASON_PASS_SPEC §10:
// Common 15 · Rare 50 · Epic 120 · Legendary 250). The catalog had shipped at
// 5-15 tickets — 10-16× under calibration — while the season track alone
// faucets ~98 tickets/season to an engaged player: the whole cosmetic sink was
// exhaustible in days, re-creating the ticket glut the economy sim flagged.
// cUSD `cents` are deliberately UNCHANGED: the on-chain CosmeticsStore listings
// are the source of truth for that rail, and repricing it is a listing op, not
// a protocol constant.
export const PREMIUM_COSMETICS: readonly CosmeticItem[] = [
  { id: 'obsidian', kind: 'dice', tickets: 15, cents: 100 }, // common
  { id: 'aurora', kind: 'dice', tickets: 120, cents: 200 }, // epic
  // Ultra-premium 3D-rendered dice (WebGL PBR materials + a dedicated roll sound).
  { id: 'crystal', kind: 'dice', tickets: 120, cents: 200 }, // epic
  { id: 'ember', kind: 'dice', tickets: 50, cents: 150 }, // rare
  { id: 'gold', kind: 'dice', tickets: 250, cents: 300 }, // legendary
  // TOKEN skins (cosmetics phase 1): the piece the OPPONENT stares at all game —
  // the highest-visibility social surface (benchmark: Yalla entrance effects,
  // Carrom animated strikers). Heritage patterns are pure SVG geometry (~2 KB),
  // tinted by the seat colour so gameplay readability is never touched.
  { id: 'tok-wax', kind: 'token', tickets: 15, cents: 49 }, // common — wax-print dots
  { id: 'tok-kente', kind: 'token', tickets: 50, cents: 99 }, // rare — kente bands
  { id: 'tok-bogolan', kind: 'token', tickets: 50, cents: 99 }, // rare — mudcloth zigzag
  { id: 'tok-gilded', kind: 'token', tickets: 120, cents: 199 }, // epic — gold foil
  // ENTRANCE effects (Yalla's proven #1 social item): played at match start,
  // seen by BOTH players. Pure CSS/emoji bursts — zero asset bytes.
  { id: 'fx-sparkle', kind: 'entrance', tickets: 50, cents: 99 }, // rare
  { id: 'fx-goldrain', kind: 'entrance', tickets: 120, cents: 199 }, // epic
  // BOARD themes (cosmetics phase 2): re-skin the board's NEUTRAL surfaces only
  // (plate, track cells, home squares) — the four seat colours are untouchable
  // (gameplay readability). Local view only, never relayed: like Ludo King,
  // each player plays on the board THEY bought.
  { id: 'brd-night', kind: 'board', tickets: 50, cents: 99 }, // rare — midnight plate
  { id: 'brd-savanna', kind: 'board', tickets: 50, cents: 99 }, // rare — warm sand
  { id: 'brd-royal', kind: 'board', tickets: 120, cents: 199 }, // epic — velvet + gold
  // VICTORY effects (cosmetics phase 2): the winner's flourish on the end screen,
  // seen by BOTH players — the loser watching your crown drop is the social sell.
  { id: 'vx-fireworks', kind: 'victory', tickets: 50, cents: 99 }, // rare
  { id: 'vx-crown', kind: 'victory', tickets: 120, cents: 199 }, // epic
  // PURCHASABLE animated avatar frames (cosmetics phase 2): the existing eight
  // premium frames stay progression rewards; these two are shop-only flexes.
  // Ids must ALSO be in AVATAR_FRAMES (the hello allowlist).
  { id: 'fr-sunburst', kind: 'frame', tickets: 120, cents: 199 }, // epic — rotating rays
  { id: 'fr-leopard', kind: 'frame', tickets: 250, cents: 299 }, // legendary — spotted shimmer
  // LEGENDARY "Savane Royale" line (cosmetics phase 3): the top of the catalog,
  // one item per kind so completing the set means buying across the whole shop.
  { id: 'tok-lion', kind: 'token', tickets: 250, cents: 499 }, // legendary — golden mane
  { id: 'brd-serengeti', kind: 'board', tickets: 250, cents: 499 }, // legendary — dusk savanna
  { id: 'vx-stampede', kind: 'victory', tickets: 250, cents: 499 }, // legendary — animal parade
] as const;

/**
 * Collection albums (cosmetics phase 3 — Monopoly-GO-style completion pull):
 * a set is COMPLETE when every itemId is in the player's owned list; completing
 * one pays a one-time ticket bonus, claimed explicitly via `collection.claim`
 * (server-authoritative + idempotent — the claim is recorded per player).
 * Free/progression cosmetics are deliberately excluded: sets are a catalog
 * sink, so every slot is a purchase (or a gift — gifts count, same owned set).
 */
export interface CosmeticSet {
  id: string;
  /** Catalog item ids that complete the set (ALL must be owned). */
  itemIds: readonly string[];
  /** Freeroll tickets granted ONCE on claim. */
  rewardTickets: number;
}
export const COSMETIC_SETS: readonly CosmeticSet[] = [
  // Heritage fabrics — the phase-1 pawn line (entry-level set, common+rare).
  { id: 'set-heritage', itemIds: ['tok-wax', 'tok-kente', 'tok-bogolan'], rewardTickets: 25 },
  // All that glitters — gold across four kinds (rare+epic).
  { id: 'set-gold', itemIds: ['tok-gilded', 'fx-goldrain', 'vx-crown', 'fr-sunburst'], rewardTickets: 50 },
  // Savane Royale — the legendary line, one item per kind.
  { id: 'set-royale', itemIds: ['tok-lion', 'brd-serengeti', 'vx-stampede', 'fr-leopard'], rewardTickets: 100 },
] as const;
export function cosmeticSetById(id: string): CosmeticSet | undefined {
  return COSMETIC_SETS.find((s) => s.id === id);
}

/** Seasonal rotation (phase 3b — content cadence without content cost): every
 *  season FEATURES one set, rotating deterministically with the season id, and
 *  claiming the featured set DURING its season pays ×FEATURED_SET_MULTIPLIER.
 *  Sets never leave the album (off-season claims pay the base bonus) — the
 *  rotation creates urgency, not unavailability. Client and server derive the
 *  same answer from the same season id, zero sync needed. */
export const FEATURED_SET_MULTIPLIER = 2;
export function featuredSetIdFor(seasonId: number): string {
  return COSMETIC_SETS[(Math.max(1, Math.floor(seasonId)) - 1) % COSMETIC_SETS.length]!.id;
}

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
export const AVATAR_FRAMES = [
  'none', 'bronze', 'silver', 'gold', 'champion', 'neon',
  // Ultra-premium illustrated + animated frames (SVG overlays, client-rendered).
  'laurel', 'flame', 'frost', 'circuit', 'royal', 'nebula', 'ruby', 'jade',
  // Shop-only animated frames (cosmetics phase 2) — also in PREMIUM_COSMETICS.
  'fr-sunburst', 'fr-leopard',
] as const;
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
export const DEFAULT_DAILY_STAKE_LIMIT_CENTS = 1500;
export const MAX_DAILY_STAKE_LIMIT_CENTS = 1500;

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
  return pot - Math.floor((pot * rakeBpsFor(stake)) / 10_000);
}

/** 4-player winner payout = 4·stake − rake (same rounding as potCents). */
export function potCents4(stake: number): number {
  const pot = stake * 4;
  return pot - Math.floor((pot * rakeBpsFor(stake)) / 10_000);
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
      /** Equipped DICE skin id — relayed so the opponent sees my die roll (the
       *  flagship premium cosmetic). Not catalog-restricted: progression/season
       *  dice ids live client-side, so it's a loose-bounded string; the client's
       *  skinById falls back to classic for anything unknown. */
      diceSkin?: string;
      /** Equipped token (pawn) skin id — relayed to the opponent in match.found
       *  so they SEE it on my pieces (cosmetics phase 1). Catalog-validated. */
      tokenSkin?: string;
      /** Equipped entrance effect id, played at match start on my board side. */
      entranceFx?: string;
      /** Equipped victory effect id — the flourish BOTH players see on the end
       *  screen when I win (cosmetics phase 2). Catalog-validated. */
      victoryFx?: string;
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
  // Rematch carries a FRESH entropy commit so the next game gets its own
  // commit-reveal (the server binds a new seed without knowing the raw value).
  | { t: 'game.rematch'; entropyCommit?: string }
  // Decline a rematch the last opponent offered (or leave the end screen): the
  // server tells them so they stop waiting instead of hanging on "searching…".
  | { t: 'rematch.decline' }
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
  // Season pass: claim the reward for a REACHED tier on a lane. The server checks
  // the tier is unlocked (crowns) and — for 'premium' — that the pass is owned,
  // then grants the reward idempotently and pushes back a fresh season.state.
  | { t: 'season.claim'; tier: number; lane: 'free' | 'premium' }
  // Unlock the premium pass for the current season: the server verifies the USDT
  // purchase tx (Purchased(buyer, keccak(SEASON_PREMIUM.itemId)) on the
  // CosmeticsStore) like cosmetic.claim, then flips premium on + retro-unlocks.
  | { t: 'season.buyPremium'; txHash: string }
  // Buy one streak-freeze with tickets (season Phase 3 sink).
  | { t: 'streak.buyFreeze' }
  // ---- Friends & challenges (E-social 2): persistent, MUTUAL-consent graph ----
  // add = "I want to be friends with pid": first direction is a request, the
  // reciprocal add seals the friendship. remove tears down BOTH directions,
  // silently (no notification to the other side — de-friending must not be a
  // conflict trigger). challenge creates a private table AND (when the friend
  // has a live session) pushes them an in-app offer; the code doubles as the
  // WhatsApp deep link for offline friends — WhatsApp IS the notification layer.
  | { t: 'friend.add'; pid: string }
  | { t: 'friend.remove'; pid: string }
  | { t: 'friend.challenge'; pid: string; stake: StakeCents }
  // Gift a premium cosmetic to a MUTUAL friend, paid with MY tickets (phase 2:
  // Yalla's gift economy, ticket rail only). The grant is durable server-side;
  // the live in-app toast is best-effort (WhatsApp remains the offline channel).
  | { t: 'friend.gift'; pid: string; id: string }
  // Claim the one-time ticket bonus for a COMPLETED cosmetic set (phase 3).
  // Server verifies every item of the set is owned; idempotent per player.
  | { t: 'collection.claim'; setId: string }
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
  /** Equipped DICE skin — shown on this player's die in the opponent's HUD
   *  (the premium 3D dice are the flagship flex). Absent = seat-colour die. */
  diceSkin?: string;
  /** Equipped token (pawn) skin — the opponent SEES it on my pieces all game
   *  (cosmetics phase 1). Catalog-validated server-side; absent = classic. */
  tokenSkin?: string;
  /** Equipped entrance effect, played at match start on my side of the board. */
  entranceFx?: string;
  /** Equipped victory effect — if THEY win, this plays on MY end screen too. */
  victoryFx?: string;
}

/** A friend (or friend-requester) as shown on the lobby: public identity only —
 *  keyed by opaque pid (never a wallet), same rule as PublicProfile. `online`
 *  is a SNAPSHOT (the lobby sync is one-shot): true = the player has a live
 *  server session right now (queueing or playing). */
export interface FriendInfo {
  pid: string;
  name: string;
  flag: string;
  elo: number;
  avatar?: string;
  frame?: string;
  online?: boolean;
}

/** Caps on the social graph: enough for a real circle, bounded for the hello
 *  payload (each entry is a profile lookup at hello time). */
export const FRIENDS_MAX = 24;
export const FRIEND_REQUESTS_MAX = 12;

export type GameOverReason = 'finish' | 'timeout-forfeit' | 'resign';

/** Everything a client needs to rebuild the game screen after a reconnection. */
export interface ResumedGame {
  gameId: string;
  seat: Seat;
  state: GameState;
  stakeCents: StakeCents;
  potCents: number;
  opponent: OpponentInfo;
  /** My label for this game — see `match.found`'s `youName`. Re-sent on resume so
   *  a reconnect keeps the same pair of labels on both screens. */
  youName?: string;
  fairnessCommit: string;
}

/** The on-chain settlement contracts the server is configured to settle against,
 *  advertised in hello.ok so the client can verify its own bundled addresses match
 *  before locking any real stake (guards a server/client address drift, e.g. after
 *  a contract redeploy). Addresses are lowercase-comparable hex strings. */
export interface SettlementContracts {
  chainId: number;
  /** LudoEscrow (1v1); absent if the 1v1 arbiter is not configured. */
  escrow?: string;
  /** LudoEscrowN (4-player); absent if the N-player arbiter is not configured. */
  escrowN?: string;
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
      claimedSets?: string[]; // cosmetic-set bonuses already claimed (phase 3)
      season?: SeasonState; // current season pass state (crowns, tier, claims, reward table)
      comeback?: Comeback; // win-back offer surfaced on return after an absence (Phase 3)
      stakingBlocked?: boolean; // geo-gated region, staked play disabled (E5.4)
      // Wallet ownership proof (SIWE): if a wallet was supplied but isn't proven
      // yet, `walletNonce` is the string to sign; `walletProven` reflects state.
      walletNonce?: string;
      walletProven?: boolean;
      // The ToS version the server has on record as accepted for this player (so
      // the client knows whether it must re-prompt before staked play).
      consentTosVersion?: string;
      // The on-chain contracts the SERVER will settle against. The client MUST
      // refuse to deposit into any escrow whose address (or chain) differs from
      // these: the server resolves its escrow from a Fly secret while the client
      // resolves it from a copy vendored into its own bundle, so a redeploy that
      // updates one but not the other would send the stake to an escrow the server
      // never settles — funds stuck until the 24 h refundActive. Present only when
      // settlement is armed (an arbiter is configured). See SettlementContracts.
      contracts?: SettlementContracts;
      /** Mutual friends with an online SNAPSHOT (walletProven sessions only). */
      friends?: FriendInfo[];
      /** Players who asked to be my friend (pending my reciprocal add). */
      friendRequests?: FriendInfo[];
      /** Requests I SENT that await the other side's reciprocal add — the
       *  sender's view of pending invitations (withdrawable via friend.remove). */
      friendsOutgoing?: FriendInfo[];
    }
  | { t: 'queue.ok'; position: number }
  // ---- Friends & challenges (E-social 2) ----
  // Ack for friend.add: 'requested' = waiting for their reciprocal add,
  // 'friends' = the edge just became mutual.
  | { t: 'friend.added'; pid: string; status: 'requested' | 'friends' }
  // Live refresh of both lists, pushed to a player whose graph just changed
  // while they had an active session (their next hello re-syncs otherwise).
  | { t: 'friends.update'; friends: FriendInfo[]; requests: FriendInfo[]; outgoing?: FriendInfo[] }
  // A friend challenges me RIGHT NOW: accept = the normal table.join(code);
  // ignore/decline is simply not joining (tables expire server-side).
  | { t: 'friend.challenge.offer'; code: string; stakeCents: StakeCents; from: FriendInfo }
  // Ack for friend.gift: tickets were spent, the friend now owns `id` (durable).
  | { t: 'friend.gifted'; pid: string; id: string; tickets: number }
  // Live push to the RECIPIENT of a gift (when they're connected): who sent it,
  // what it is, and their refreshed owned list. Offline recipients simply find
  // the item owned at their next hello (the giver tells them on WhatsApp).
  | { t: 'friend.gift.received'; from: FriendInfo; id: string; ownedIds: string[] }
  // Ack for collection.claim: the set bonus was granted (or had already been —
  // idempotent). `tickets` = new balance; `claimedSets` = full claimed list;
  // `granted` = tickets THIS claim paid (base ×2 when the set was the season's
  // featured one; 0 on an idempotent re-claim).
  | { t: 'collection.claimed'; setId: string; tickets: number; claimedSets: string[]; granted: number }
  // Your last opponent clicked Rematch and is waiting; `name` is their display
  // label. The end screen surfaces an Accept/Decline offer instead of the game
  // silently depending on both sides happening to click.
  | { t: 'rematch.offer'; name: string }
  // A rematch you were waiting on won't happen: the opponent declined or left.
  | { t: 'rematch.cancelled'; reason: 'declined' | 'left' }
  // Private table created (E4.4); share `code` with a friend to join.
  | { t: 'table.created'; code: string; stakeCents: StakeCents }
  | {
      t: 'match.found';
      gameId: string;
      seat: Seat;
      opponent: OpponentInfo;
      /** MY display name for THIS game. Normally just my own name, but when both
       *  players carry the same one (guest names come from a fixed pool) the
       *  server disambiguates the pair — "Nia" / "Nia 2" — and both clients must
       *  render the same labels. The client's own name is local, so without this
       *  the two screens would disagree. Optional: older clients fall back to
       *  their local profile name. `match.found4` needs no equivalent — it already
       *  ships every seat's name in `players`. */
      youName?: string;
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
  // Login streak / streak-freeze state after a buyFreeze (season Phase 3).
  | { t: 'streak.update'; streak: StreakState }
  // Full season pass state — sent on hello and after a season.claim (the reward
  // table is static, so the client keeps `tiers` and only needs the light
  // `season.progress` push mid-session).
  | { t: 'season.state'; season: SeasonState }
  // Lightweight per-game push: crowns earned (and the tier it unlocked). Lets the
  // client animate the track filling without re-sending the whole reward table.
  | { t: 'season.progress'; crowns: number; tier: number; gained: number; dailyGames: number }
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
  /** Equipped cosmetics (4p extension): dice skin (shown on this seat's die),
   *  pawn skin drawn on this seat's pieces, entrance burst at match start,
   *  victory flourish if this seat wins. Absent for bots. */
  diceSkin?: string;
  tokenSkin?: string;
  entranceFx?: string;
  victoryFx?: string;
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
      // Token skin / entrance fx: must be catalog ids of the right kind — drop
      // unknown values (same never-reject cosmetic posture as frame/avatar).
      // diceSkin is loose-bounded (progression/season dice ids aren't in the
      // shared catalog); the client's skinById safely falls back to classic.
      if (m.diceSkin !== undefined && (typeof m.diceSkin !== 'string' || m.diceSkin.length > 64)) m.diceSkin = undefined;
      if (m.tokenSkin !== undefined && (typeof m.tokenSkin !== 'string' || cosmeticById(m.tokenSkin)?.kind !== 'token')) m.tokenSkin = undefined;
      if (m.entranceFx !== undefined && (typeof m.entranceFx !== 'string' || cosmeticById(m.entranceFx)?.kind !== 'entrance')) m.entranceFx = undefined;
      if (m.victoryFx !== undefined && (typeof m.victoryFx !== 'string' || cosmeticById(m.victoryFx)?.kind !== 'victory')) m.victoryFx = undefined;
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
    case 'season.claim':
      return Number.isInteger(m.tier) && m.tier >= 1 && m.tier <= SEASON.tierCount && (m.lane === 'free' || m.lane === 'premium') ? m : null;
    case 'season.buyPremium':
      return typeof m.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(m.txHash) ? m : null;
    case 'emote':
      return typeof m.id === 'string' && ((EMOTES as readonly string[]).includes(m.id) || isQuickChat(m.id)) ? m : null;
    case 'gift':
      return typeof m.id === 'string' && isGift(m.id) && typeof m.to === 'number' && m.to >= 0 && m.to <= 3 ? m : null;
    case 'profile.get':
      // opaque pid: short hex hash — reject anything else (never a wallet)
      return typeof m.pid === 'string' && /^[0-9a-f]{8,32}$/.test(m.pid) ? m : null;
    case 'friend.add':
    case 'friend.remove':
      // same opaque-pid rule as profile.get
      return typeof m.pid === 'string' && /^[0-9a-f]{8,32}$/.test(m.pid) ? m : null;
    case 'friend.challenge':
      return typeof m.pid === 'string' && /^[0-9a-f]{8,32}$/.test(m.pid) && (ALLOWED_STAKES_CENTS as readonly number[]).includes(m.stake) ? m : null;
    case 'friend.gift':
      // pid rule as above; the gift must be a real ticket-priced catalog item.
      return typeof m.pid === 'string' && /^[0-9a-f]{8,32}$/.test(m.pid) && typeof m.id === 'string' && Object.prototype.hasOwnProperty.call(PREMIUM_SKINS, m.id) ? m : null;
    case 'collection.claim':
      return typeof m.setId === 'string' && cosmeticSetById(m.setId) !== undefined ? m : null;
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
    case 'rematch.decline':
    case 'streak.buyFreeze':
    case 'ping':
      return m;
    default:
      return null;
  }
}
