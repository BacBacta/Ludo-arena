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
    tiers: seasonTiers(),
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
  const def = seasonTiers()[tier - 1];
  if (!def) return { ok: false, error: 'locked' };
  const reward = lane === 'free' ? def.free : def.premium;

  const newlyClaimed = await store.claimSeasonTier(playerId, tier, lane);
  if (!newlyClaimed) return { ok: false, error: 'already' };

  let ticketsGranted = 0;
  if (reward.kind === 'tickets' && reward.amount && reward.amount > 0) {
    await store.grantTickets(playerId, reward.amount);
    ticketsGranted = reward.amount;
  } else if (reward.kind === 'crownBoost' && reward.amount && reward.amount > 0) {
    await store.setSeasonCrownBoost(playerId, 1 + reward.amount / 100);
  }
  // cosmetic / streakFreeze / title: recorded as claimed; the functional grant
  // (real cosmetic art, streak-freeze inventory) lands with the content pipeline.
  void today;
  return { ok: true, reward, ticketsGranted };
}
