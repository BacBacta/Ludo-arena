// Season pass — server logic (anti-churn keystone; docs/SEASON_PASS_SPEC.md).
// The store owns persistence (crowns, claims, the season window); this module owns
// the *rules*: how many crowns a finished game is worth, how a claim is validated
// and granted, and how the full SeasonState shown to a client is assembled.
import { SEASON, seasonTiers, tierFromCrowns, type Reward, type SeasonState } from '@ludo/shared';
import type { Store } from './store/types.js';

/**
 * Base crowns for finishing one game, before the premium boost.
 *  • the Nth game of the UTC day earns the full rate up to `softCapGames`, then
 *    decays to `softCapCrown` (anti-grind — preserves the ~28-day pacing);
 *  • the winner gets `winBonus` on top.
 * `gameNoToday` is 1-based (this game is the player's Nth of the day).
 */
export function baseCrowns(gameNoToday: number, isWinner: boolean): number {
  const perGame = gameNoToday <= SEASON.softCapGames ? SEASON.crownPerGame : SEASON.softCapCrown;
  return perGame + (isWinner ? SEASON.winBonus : 0);
}

export interface CrownAward {
  crowns: number; // new season total
  tier: number; // reached tier after this award
  gained: number; // crowns this game granted
  dailyGames: number; // games counted today (post-increment)
}

/** Accrue this game's crowns for a player and return the new totals for a push. */
export async function awardGameCrowns(
  store: Store,
  playerId: string,
  isWinner: boolean,
  today: string,
): Promise<CrownAward> {
  const prog = await store.getSeasonProgress(playerId);
  const priorToday = prog.dailyDate === today ? prog.dailyGames : 0;
  const raw = baseCrowns(priorToday + 1, isWinner);
  const gained = Math.max(0, Math.round(raw * (prog.crownBoost || 1)));
  const { crowns, dailyGames } = await store.addCrowns(playerId, gained, today);
  return { crowns, tier: tierFromCrowns(crowns), gained, dailyGames };
}

/** Assemble the full SeasonState a client needs to render the track. */
export async function buildSeasonState(store: Store, playerId: string, nowIso: string): Promise<SeasonState> {
  const meta = await store.getSeason(nowIso);
  const p = await store.getSeasonProgress(playerId);
  return {
    id: meta.id,
    endsAt: meta.endsAt,
    tierCount: SEASON.tierCount,
    crowns: p.crowns,
    tier: tierFromCrowns(p.crowns),
    premium: p.premium,
    claimedFree: p.claimedFree,
    claimedPrem: p.claimedPrem,
    tiers: seasonTiers(meta.id),
  };
}

export type ClaimError = 'locked' | 'not-premium' | 'already';
export interface ClaimResult {
  ok: boolean;
  error?: ClaimError;
  reward?: Reward;
  /** Freeroll tickets granted by the reward (0 unless kind === 'tickets'). */
  ticketsGranted?: number;
}

/**
 * Validate and grant a season-tier reward. Server-authoritative:
 *  • the tier must be REACHED (crowns ≥ its cost) — else 'locked';
 *  • a 'premium' claim requires the pass — else 'not-premium';
 *  • claiming is idempotent — a repeat is 'already' (never double-grants).
 * Only ticket rewards credit a balance today; cosmetic/streakFreeze/title are
 * recorded as claimed (content lands in a later phase), and a crownBoost reward
 * applies immediately so a premium buyer earns faster for the rest of the season.
 */
export async function claimSeasonTier(
  store: Store,
  playerId: string,
  tier: number,
  lane: 'free' | 'premium',
  today: string,
): Promise<ClaimResult> {
  const p = await store.getSeasonProgress(playerId);
  if (tierFromCrowns(p.crowns) < tier) return { ok: false, error: 'locked' };
  if (lane === 'premium' && !p.premium) return { ok: false, error: 'not-premium' };
  const def = seasonTiers(p.seasonId)[tier - 1];
  if (!def) return { ok: false, error: 'locked' };
  const reward = lane === 'free' ? def.free : def.premium;

  const newlyClaimed = await store.claimSeasonTier(playerId, tier, lane);
  if (!newlyClaimed) return { ok: false, error: 'already' };

  const ticketsGranted = await grantReward(store, playerId, reward);
  void today;
  return { ok: true, reward, ticketsGranted };
}

/** Apply a reward's functional effect. Ticket rewards credit a balance (returned);
 *  a crownBoost applies immediately so a premium buyer earns faster for the rest of
 *  the season; cosmetic/streakFreeze/title are recorded-only until the content
 *  pipeline lands. Idempotency is the caller's job (claim/retro-unlock guards). */
async function grantReward(store: Store, playerId: string, reward: Reward): Promise<number> {
  if (reward.kind === 'tickets' && reward.amount && reward.amount > 0) {
    await store.grantTickets(playerId, reward.amount);
    return reward.amount;
  }
  if (reward.kind === 'crownBoost' && reward.amount && reward.amount > 0) {
    await store.setSeasonCrownBoost(playerId, 1 + reward.amount / 100);
  }
  if (reward.kind === 'streakFreeze' && reward.amount && reward.amount > 0) {
    await store.grantStreakFreeze(playerId, reward.amount);
  }
  if (reward.kind === 'cosmetic' && reward.id) {
    // grant the season-exclusive skin as a real owned cosmetic (equippable)
    await store.ownSkin(playerId, reward.id);
  }
  return 0;
}

export interface BuyPremiumResult {
  ok: boolean;
  error?: 'already' | 'unverified' | 'replay';
  /** Premium-lane tiers auto-granted by the retroactive unlock. */
  unlockedTiers?: number[];
  /** Freeroll tickets credited by those retroactive rewards. */
  ticketsGranted?: number;
}

/**
 * Unlock the premium pass for the current season after verifying the USDT purchase.
 * Server-authoritative + replay-safe:
 *  • the tx must be a real CosmeticsStore Purchase by THIS wallet — else 'unverified';
 *  • each purchase tx is single-use globally — a replay is 'replay' (can't reuse an
 *    old season's tx to unlock a later one, since the on-chain item is season-agnostic);
 *  • already-premium is idempotent → 'already'.
 * On success it flips premium on and RETROACTIVELY grants every premium reward for
 * tiers already reached (§4: reduces buyer's remorse, boosts late conversion).
 */
export async function buySeasonPremium(
  store: Store,
  verify: (txHash: string) => Promise<boolean>,
  playerId: string,
  txHash: string,
): Promise<BuyPremiumResult> {
  const p = await store.getSeasonProgress(playerId);
  if (p.premium) return { ok: false, error: 'already' };
  if (!(await verify(txHash))) return { ok: false, error: 'unverified' };
  // Consume the tx BEFORE granting so a verified-but-replayed tx can never double-unlock.
  if (!(await store.consumePremiumTx(txHash, playerId, p.seasonId))) return { ok: false, error: 'replay' };

  await store.setSeasonPremium(playerId);

  // Retroactive unlock: auto-claim every premium reward for a reached tier.
  const reached = tierFromCrowns(p.crowns);
  const tiers = seasonTiers(p.seasonId);
  const unlockedTiers: number[] = [];
  let ticketsGranted = 0;
  for (let t = 1; t <= reached; t++) {
    if (p.claimedPrem.includes(t)) continue;
    if (!(await store.claimSeasonTier(playerId, t, 'premium'))) continue; // already claimed (race)
    ticketsGranted += await grantReward(store, playerId, tiers[t - 1]!.premium);
    unlockedTiers.push(t);
  }
  return { ok: true, unlockedTiers, ticketsGranted };
}
