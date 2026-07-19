import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memory.js';
import { awardGameCrowns, baseCrowns, buildSeasonState, buySeasonPremium, claimSeasonTier } from '../src/season.js';
import { COSMETIC_SETS, FEATURED_SET_MULTIPLIER, FREEROLL, SEASON, SEASON_SKINS, crownsForTier, featuredSetIdFor, seasonSkinsFor, seasonTiers, tierFromCrowns, winbackFor } from '@ludo/shared';

const NOW = '2026-07-18T00:00:00.000Z';
const DAY = '2026-07-18';

async function freshStore(id = 'anon:s1'): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.init();
  await store.getOrCreatePlayer(id, { name: 'P', flag: '🌍' });
  await store.getSeason(NOW);
  return store;
}

describe('freeroll ticket economy (net sink, not a faucet)', () => {
  it('removes at least as many tickets as it pays out per 2-player game', () => {
    // 2 entries in, 1 prize out. A faucet here drove runaway ticket inflation in
    // the economy sim — guard that the freeroll never becomes one again.
    const ticketsIn = 2 * FREEROLL.entryTickets;
    const ticketsOut = FREEROLL.winnerTickets;
    expect(ticketsIn).toBeGreaterThanOrEqual(ticketsOut);
  });
});

describe('baseCrowns (soft cap + win bonus)', () => {
  it('pays the full rate up to the soft cap, then decays', () => {
    expect(baseCrowns(1, false)).toBe(SEASON.crownPerGame);
    expect(baseCrowns(SEASON.softCapGames, false)).toBe(SEASON.crownPerGame);
    // one past the cap decays to the floor
    expect(baseCrowns(SEASON.softCapGames + 1, false)).toBe(SEASON.softCapCrown);
  });
  it('adds the win bonus for the winner only', () => {
    expect(baseCrowns(1, true)).toBe(SEASON.crownPerGame + SEASON.winBonus);
    expect(baseCrowns(SEASON.softCapGames + 1, true)).toBe(SEASON.softCapCrown + SEASON.winBonus);
  });
});

describe('awardGameCrowns', () => {
  it('accrues per-game crowns and derives the reached tier', async () => {
    const store = await freshStore();
    const a = await awardGameCrowns(store, 'anon:s1', true, DAY);
    expect(a.gained).toBe(SEASON.crownPerGame + SEASON.winBonus);
    expect(a.crowns).toBe(a.gained);
    expect(a.dailyGames).toBe(1);
    expect(a.tier).toBe(tierFromCrowns(a.crowns));
  });

  it('applies the daily soft cap after softCapGames games', async () => {
    const store = await freshStore();
    let last = { crowns: 0, gained: 0 };
    for (let i = 0; i < SEASON.softCapGames; i++) last = await awardGameCrowns(store, 'anon:s1', false, DAY);
    expect(last.gained).toBe(SEASON.crownPerGame); // the softCapGames-th game still full
    const over = await awardGameCrowns(store, 'anon:s1', false, DAY); // one past the cap
    expect(over.gained).toBe(SEASON.softCapCrown);
  });

  it('multiplies by the premium crown boost', async () => {
    const store = await freshStore();
    await store.setSeasonCrownBoost('anon:s1', 1.25);
    const a = await awardGameCrowns(store, 'anon:s1', false, DAY);
    expect(a.gained).toBe(Math.round(SEASON.crownPerGame * 1.25));
  });
});

describe('claimSeasonTier', () => {
  it('rejects a tier that is not yet reached', async () => {
    const store = await freshStore();
    const r = await claimSeasonTier(store, 'anon:s1', 1, 'free', DAY);
    expect(r).toMatchObject({ ok: false, error: 'locked' });
  });

  it('grants a reached free-tier reward once, then reports already-claimed', async () => {
    const store = await freshStore();
    await store.addCrowns('anon:s1', crownsForTier(1), DAY); // reach tier 1
    const tier1Free = seasonTiers()[0]!.free;

    const first = await claimSeasonTier(store, 'anon:s1', 1, 'free', DAY);
    expect(first.ok).toBe(true);
    expect(first.reward).toEqual(tier1Free);
    if (tier1Free.kind === 'tickets') {
      expect(first.ticketsGranted).toBe(tier1Free.amount);
      expect((await store.getChallenge('anon:s1', DAY)).tickets).toBe(tier1Free.amount);
    }

    const again = await claimSeasonTier(store, 'anon:s1', 1, 'free', DAY);
    expect(again).toMatchObject({ ok: false, error: 'already' });
  });

  it('blocks the premium lane without the pass, allows it with', async () => {
    const store = await freshStore();
    await store.addCrowns('anon:s1', crownsForTier(3), DAY); // reach the crownBoost tier (3)
    expect(await claimSeasonTier(store, 'anon:s1', 3, 'premium', DAY)).toMatchObject({ ok: false, error: 'not-premium' });

    await store.setSeasonPremium('anon:s1');
    const r = await claimSeasonTier(store, 'anon:s1', 3, 'premium', DAY);
    expect(r.ok).toBe(true);
    // tier 3 premium is a crown boost → it takes effect immediately
    expect(r.reward).toMatchObject({ kind: 'crownBoost' });
    expect((await store.getSeasonProgress('anon:s1')).crownBoost).toBeGreaterThan(1);
  });
});

describe('buySeasonPremium', () => {
  const TX = '0x' + 'a'.repeat(64);
  const ok = async () => true;
  const fail = async () => false;

  it('rejects an unverifiable purchase and never flips premium', async () => {
    const store = await freshStore();
    const r = await buySeasonPremium(store, fail, 'anon:s1', TX);
    expect(r).toMatchObject({ ok: false, error: 'unverified' });
    expect((await store.getSeasonProgress('anon:s1')).premium).toBe(false);
  });

  it('unlocks premium and cannot be replayed with the same tx', async () => {
    const store = await freshStore();
    const first = await buySeasonPremium(store, ok, 'anon:s1', TX);
    expect(first.ok).toBe(true);
    expect((await store.getSeasonProgress('anon:s1')).premium).toBe(true);
    // already premium → idempotent 'already' (before the tx is even re-checked)
    expect(await buySeasonPremium(store, ok, 'anon:s1', TX)).toMatchObject({ ok: false, error: 'already' });
  });

  it('cannot reuse one purchase tx to unlock a different player', async () => {
    const store = await freshStore();
    await store.getOrCreatePlayer('anon:s2', { name: 'Q', flag: '🌍' });
    expect((await buySeasonPremium(store, ok, 'anon:s1', TX)).ok).toBe(true);
    // same tx, different player → the global single-use guard rejects as replay
    expect(await buySeasonPremium(store, ok, 'anon:s2', TX)).toMatchObject({ ok: false, error: 'replay' });
  });

  it('retroactively grants every reached premium tier on purchase', async () => {
    const store = await freshStore();
    await store.addCrowns('anon:s1', crownsForTier(3), DAY); // reach tier 3 (incl. the crownBoost tier)
    const r = await buySeasonPremium(store, ok, 'anon:s1', TX);
    expect(r.ok).toBe(true);
    expect(r.unlockedTiers).toEqual([1, 2, 3]);
    const p = await store.getSeasonProgress('anon:s1');
    expect([...p.claimedPrem].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    // tier 3 premium is a crown boost → applied immediately
    expect(p.crownBoost).toBeGreaterThan(1);
  });

  it('grants nothing retroactively when no tier is reached yet', async () => {
    const store = await freshStore();
    const r = await buySeasonPremium(store, ok, 'anon:s1', TX);
    expect(r).toMatchObject({ ok: true, unlockedTiers: [], ticketsGranted: 0 });
    expect((await store.getSeasonProgress('anon:s1')).premium).toBe(true);
  });
});

describe('winbackFor (comeback tiers)', () => {
  it('offers nothing below 3 days away', () => {
    expect(winbackFor(0)).toBeNull();
    expect(winbackFor(2)).toBeNull();
  });
  it('offers the highest tier the player qualifies for', () => {
    expect(winbackFor(3)).toMatchObject({ tickets: 2 });
    expect(winbackFor(6)).toMatchObject({ tickets: 2 });
    expect(winbackFor(7)).toMatchObject({ tickets: 5 });
    expect(winbackFor(30)).toMatchObject({ tickets: 5 });
  });
});

describe('claiming a streak-freeze tier grants a freeze', () => {
  it('adds to the freeze inventory when a streakFreeze reward is claimed', async () => {
    const store = await freshStore();
    // tier 15 free lane is a streakFreeze reward
    const t15 = seasonTiers()[14]!;
    expect(t15.free.kind).toBe('streakFreeze');
    await store.addCrowns('anon:s1', crownsForTier(15), DAY); // reach tier 15
    expect(await store.getStreakFreezes('anon:s1')).toBe(0);
    const r = await claimSeasonTier(store, 'anon:s1', 15, 'free', DAY);
    expect(r.ok).toBe(true);
    expect(await store.getStreakFreezes('anon:s1')).toBe(1);
  });
});

describe('season-exclusive cosmetics (Phase 4)', () => {
  it('rotates a distinct skin set for consecutive seasons', () => {
    const s1 = seasonSkinsFor(1, 4);
    const s2 = seasonSkinsFor(2, 4);
    expect(s1).toHaveLength(4);
    expect(new Set(s1).size).toBe(4); // no dupes within a season
    // seasons 1 and 2 draw disjoint sets (pool is 8, 4 each)
    expect(s1.some((id) => s2.includes(id))).toBe(false);
    // all ids come from the pool, and the rotation wraps deterministically
    expect(s1.every((id) => SEASON_SKINS.includes(id))).toBe(true);
    expect(seasonSkinsFor(1, 4)).toEqual(s1); // deterministic
  });

  it("uses the season's own exclusive skins in its reward table", () => {
    const [freeA] = seasonSkinsFor(2, 4);
    const tiers = seasonTiers(2);
    expect(tiers[24]!.free).toEqual({ kind: 'cosmetic', id: freeA }); // tier 25 free
    // season 1 and season 2 tier-25 cosmetics differ (content cadence)
    expect(seasonTiers(1)[24]!.free).not.toEqual(tiers[24]!.free);
  });

  it('claiming a cosmetic tier grants a real owned skin', async () => {
    const store = await freshStore();
    const tiers = seasonTiers(1);
    const skinId = (tiers[24]!.free as { id: string }).id; // tier 25 free cosmetic
    await store.addCrowns('anon:s1', crownsForTier(25), DAY);
    expect(await store.getOwnedSkins('anon:s1')).not.toContain(skinId);
    const r = await claimSeasonTier(store, 'anon:s1', 25, 'free', DAY);
    expect(r.ok).toBe(true);
    expect(r.reward).toMatchObject({ kind: 'cosmetic', id: skinId });
    expect(await store.getOwnedSkins('anon:s1')).toContain(skinId);
  });
});

describe('buildSeasonState', () => {
  it('assembles crowns, reached tier, claims and the static reward table', async () => {
    const store = await freshStore();
    await store.addCrowns('anon:s1', crownsForTier(2), DAY);
    await store.claimSeasonTier('anon:s1', 1, 'free');
    const st = await buildSeasonState(store, 'anon:s1', NOW);
    expect(st).toMatchObject({ tierCount: SEASON.tierCount, crowns: crownsForTier(2), tier: 2, premium: false });
    expect(st.claimedFree).toEqual([1]);
    expect(st.tiers).toHaveLength(SEASON.tierCount);
    expect(st.tiers[0]).toMatchObject({ tier: 1 });
  });
});

describe('featured cosmetic set (seasonal rotation, phase 3b)', () => {
  it('rotates deterministically through every set and wraps', () => {
    const n = COSMETIC_SETS.length;
    // Each season features exactly one set; consecutive seasons differ; wraps at n.
    const first = Array.from({ length: n }, (_, i) => featuredSetIdFor(i + 1));
    expect(new Set(first).size).toBe(n); // full coverage before any repeat
    expect(featuredSetIdFor(1)).toBe(COSMETIC_SETS[0]!.id);
    expect(featuredSetIdFor(n + 1)).toBe(featuredSetIdFor(1)); // wrap
    expect(featuredSetIdFor(0)).toBe(featuredSetIdFor(1)); // clamped, never crashes
  });

  it('doubles the bonus only for the featured set', () => {
    for (const set of COSMETIC_SETS) {
      const featuredSeason = COSMETIC_SETS.indexOf(set) + 1;
      const featured = featuredSetIdFor(featuredSeason) === set.id;
      expect(featured).toBe(true);
      expect(set.rewardTickets * FEATURED_SET_MULTIPLIER).toBe(set.rewardTickets * 2);
      // a different season → this set is NOT featured
      expect(featuredSetIdFor(featuredSeason + 1) === set.id).toBe(false);
    }
  });
});
