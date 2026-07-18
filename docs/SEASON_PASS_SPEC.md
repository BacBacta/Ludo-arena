# Season Pass — build spec

The keystone of the anti-churn economy. Off-chain (crowns/tiers/rewards live in the
store, not on a contract); the only on-chain touchpoint is the USDT premium purchase,
which reuses the existing cosmetics/USDT payment path. It does **double duty**:
the wealth-proportional **ticket sink** that stops ticket hyperinflation, AND the
biggest **retention** driver (sim: D30 10%→17%, active base ~2×, profit ~3-4×).

> Numbers below are the calibrated starting values from the economy model. Every
> one marked *(calibrate in beta)* must be re-tuned against real faucet/sink and
> retention data — the **structure** is fixed, the **magnitudes** are hypotheses.

---

## 1. Currencies (recap + the new one)

| Currency | Role | Earned | Spent | Cashable |
|---|---|---|---|---|
| **Tickets** (soft) | engagement | challenge/streak/league/freeroll | freeroll, cosmetics, streak-freeze, pass tiers | **never → USDT** |
| **USDT** (hard) | monetization | player wallet | stakes, cosmetics, **premium pass ($1.50)** | ← may buy tickets/cosmetics |
| **Crowns** (progression) | prestige, **never spent** | every game (free or staked) + dailies | — (fills the season track) | no |

**One-way permeability** (legal wall): tickets and crowns NEVER convert to USDT.

---

## 2. Crown earning (calibrated for a ~28-day season)

| Source | Crowns |
|---|---|
| Per game played | **+10** |
| Win bonus | **+5** |
| First win of the day | **+15** |
| Daily challenge complete | **+20** |
| **Soft cap** | after **10 games/day**, per-game crowns decay to +3 (anti-grind, preserves pacing, blocks abuse) |

Pacing (validated): engaged (6 games/day) completes 50 tiers in ~24 days; regular
(4/day) ~92% by day 28; casual (2/day) ~65%. Season total = **2 600 crowns**.

Crowns are granted server-side on game finish (both free and staked) — hook into
`onResult` (1v1) and the Room4 result path. Dailies granted on the day's first
qualifying event. All idempotent per (player, day).

---

## 3. Tier structure

- **50 tiers**, flat **~52 crowns/tier** (2 600 total). *(Escalating cost is an
  option; flat is simpler to communicate — calibrate in beta.)*
- Each tier has a **free-lane reward** and a **premium-lane reward** (claimed
  separately). The player claims a tier's reward(s) once it's reached.
- **Reward mix** per lane (design the exact table as content):
  - Free lane: mostly **tickets** (paces the economy), a few common cosmetics, the
    occasional streak-freeze.
  - Premium lane: **more tickets**, **exclusive cosmetics** (dice/boards/frames/
    **titles visible to others**), a **crown boost** early (e.g. +25% for the rest
    of the season), and **season-exclusive** items unavailable anywhere else.
- **Premium NEVER affects gameplay** (no dice odds, no win edge) — cosmetics /
  tickets / progression speed / status only. Hard rule (fair + legally required in
  a wagering game).

---

## 4. Premium pass — $1.50 USDT

- Positioned as a **conversion loss-leader** (cheap first purchase → crosses the
  free→paid line → more likely to stake later). Pass revenue is secondary.
- **Payment**: USDT, via the existing on-chain cosmetics/USDT path (a small
  transfer to treasury) — reuse `CosmeticsStore` / the cUSD purchase flow; no new
  contract. Verify the payment tx like `cosmetic.claim` does.
- **Retroactive unlock**: buying mid-season instantly grants all premium-lane
  rewards for tiers already reached (reduces buyer's remorse, boosts late
  conversion).
- Premium ownership is **per-season** (resets each season).

---

## 5. Season lifecycle

- **Duration ~28 days**, aligned to a fixed UTC boundary (like the weekly league
  rollover already in the server — reuse that scheduler pattern).
- **Reset**: at season end, a **new season** starts with a fresh track + new
  cosmetics. Progress resets to tier 0; **earned cosmetics/titles are kept
  forever** (they're permanent unlocks); **unclaimed rewards** are auto-granted or
  forfeited (decide — recommend auto-grant reached-tier rewards at rollover so
  nobody loses what they earned).
- **Crowns** reset each season (they're the season's progress bar, not a bank).
- Boot-safe: season state persisted (survives restart), rollover checked at boot +
  on the scheduler tick (mirror the league rollover's "checked at boot and hourly").

---

## 6. Data model (store)

New Postgres tables (auto-created via `SCHEMA_SQL` — the store builds its schema on
boot, no manual migration):

```sql
-- current + past seasons (id, window, definition version)
CREATE TABLE IF NOT EXISTS seasons (
  id           INTEGER PRIMARY KEY,      -- season number
  starts_at    TIMESTAMPTZ NOT NULL,
  ends_at      TIMESTAMPTZ NOT NULL,
  tier_count   INTEGER NOT NULL DEFAULT 50,
  crowns_per_tier INTEGER NOT NULL DEFAULT 52
);

-- per-player progress in the CURRENT season
CREATE TABLE IF NOT EXISTS season_progress (
  player_id    TEXT NOT NULL,
  season_id    INTEGER NOT NULL,
  crowns       INTEGER NOT NULL DEFAULT 0,
  tier         INTEGER NOT NULL DEFAULT 0,      -- derived = crowns / crowns_per_tier
  premium      BOOLEAN NOT NULL DEFAULT FALSE,
  claimed_free BIGINT  NOT NULL DEFAULT 0,      -- bitset of claimed free tiers
  claimed_prem BIGINT  NOT NULL DEFAULT 0,      -- bitset of claimed premium tiers
  crown_boost  REAL    NOT NULL DEFAULT 1.0,    -- from a premium boost reward
  daily_date   DATE,                            -- for first-win/challenge idempotency
  daily_games  INTEGER NOT NULL DEFAULT 0,      -- soft-cap counter
  PRIMARY KEY (player_id, season_id)
);
```

Store interface additions (mirror the existing `getChallenge`/`getLimits` shape):
`getSeason()`, `getSeasonProgress(playerId)`, `addCrowns(playerId, n)`,
`claimTier(playerId, tier, lane)`, `setPremium(playerId)`, `rolloverSeason()`.
Memory + RedisOnly + Persistent impls (memory for dev, Redis hot, Postgres durable
— same three-store pattern as the rest).

---

## 7. Protocol (packages/shared)

Server → client:
```ts
| { t: 'season.state'; season: SeasonState }            // sent in hello.ok + on change
| { t: 'season.crowns'; granted: number; total: number; tier: number; reason: string }
| { t: 'season.reward'; tier: number; lane: 'free'|'premium'; reward: Reward }
```
Client → server:
```ts
| { t: 'season.claim'; tier: number; lane: 'free'|'premium' }
| { t: 'season.buyPremium'; txHash: string }   // USDT purchase, verified server-side
```
`SeasonState` = { id, endsAt, tier, crowns, crownsPerTier, tierCount, premium,
claimedFree[], claimedPrem[], tiers: TierDef[] }. `TierDef` = { tier, freeReward,
premiumReward }.

---

## 8. Server logic

- **Crown grants**: on game finish (`onResult` / Room4 result), grant `+10 +5(win)`
  × `crown_boost`, respecting the daily soft cap; grant dailies (first-win +15,
  challenge-complete +20) idempotently per (player, UTC day). Emit `season.crowns`.
- **Claim**: `season.claim` → verify tier ≤ current tier, lane not already claimed,
  premium lane requires `premium=true`; grant the reward (tickets via existing
  `grantTickets`, cosmetics via the ownership store), set the claimed bit, emit
  `season.reward`.
- **Buy premium**: `season.buyPremium` → verify the USDT tx (amount ≥ $1.50 to
  treasury, correct token/chain) like `cosmetic.claim`; set `premium=true`; grant
  all premium rewards for already-reached tiers (retroactive); apply crown boost.
- **Rollover**: scheduler (reuse the league weekly-rollover machinery) — at
  `ends_at`, auto-grant reached-but-unclaimed rewards, archive, start season N+1,
  reset progress. Idempotent, boot-checked.

---

## 9. Client (screens + hooks)

- **Season card / screen**: the tier ladder with a progress bar, "**next reward:
  N games away**" (goal-gradient — the anti-churn core), claim buttons on reached
  tiers, a **Premium CTA** ($1.50) showing the premium-lane rewards you're missing.
- **Crown gain feedback**: a small "+15 👑" on game end + the bar filling.
- **Retroactive unlock**: buying premium mid-season visibly floods the already-passed
  premium rewards ("claim all").
- **Reset moment**: a "New season!" screen with the new cosmetics — a strong return
  hook.
- Wire into the existing session events (`onSeason`, `onCrowns`, `onReward`).
- **Fold the ticket/freeroll clarity fix in here**: the season card is where tickets
  now visibly GO (spend on tiers/cosmetics), which resolves the "tickets feel
  pointless" issue structurally.

---

## 10. Economy integration (the other locked params)

- **Freeroll → net-neutral**: change entry to **2 tickets**, prize **3** (per
  2-player game: 4 in / 3 out = a slight sink, not a faucet). Kills the runaway
  ticket inflation the sim found.
- **Cosmetic prices** *(calibrate in beta)*:
  - Tickets: Common **15** · Rare **50** · Epic **120** · Legendary **250**.
  - USDT: Common **$0.49** · Rare **$0.99** · Epic **$1.99** · Legendary **$3.99**.
  - Season-exclusives: pass-only (not purchasable) → scarcity/status.
- **Streak-freeze**: purchasable with tickets (a sink + loss-aversion retention) —
  protects a login streak for one missed day.

---

## 11. Win-back loop (comeback)

Triggered by absence (no session for N days), **never** for self-excluded /
limit-hit players (RG). No free *withdrawable* USDT (laundering/abuse) — tickets +
a stake-only credit.

| Absent | Offer | Real cost |
|---|---|---|
| 3 days | +2 tickets + "your season is waiting" | ~0 |
| 7 days | +5 tickets + 1 free freeroll entry | ~0 |
| 14-30 days | stake-only credit ~$0.25 (non-withdrawable, one 25¢ game) + "new season" | minimal |

Delivered via a re-engagement notification/deeplink (MiniPay push if available) +
surfaced on next open.

---

## 12. RG guardrails (woven in, not bolted on)

- Tickets & crowns **non-cashable**.
- Premium pass gives **zero gameplay advantage** (cosmetics/progression/status only).
- Comeback offers **excluded** for self-excluded / limit-hit users.
- Progression = skill + engagement, never spend-gated in a predatory way.
- The existing daily-stake limit / self-exclusion / anti-tilt remain the backbone.

---

## 13. Instrumentation (validate the model in beta)

Log per player/day so the economy model can be recalibrated on real data:
- **Retention**: D1/D7/D30 (cohort by join day).
- **Ticket economy**: faucet vs sink volumes, inflation index (outstanding/active),
  freeroll participation.
- **Season**: crowns/day distribution, tier reached, season completion rate,
  claim rate.
- **Monetization**: premium adoption %, free→first-stake conversion, ARPDAU,
  non-gambling revenue share.
- **Win-back**: reactivation rate per tier, cost.

These are the inputs that turn the simulator's hypotheses into calibrated truth.

---

## 14. Build phases (ship incrementally)

1. **MVP — free track only**: crowns on game end + the tier ladder + free rewards +
   claim + season rollover + telemetry. Ships the retention core + the ticket sink.
   (Also flip freeroll to net-neutral here.)
2. **Premium**: the $1.50 USDT purchase + premium lane + retroactive unlock +
   crown boost.
3. **Win-back + streak-freeze**: the comeback loop + the streak-freeze sink.
4. **Content cadence**: a pipeline for each season's exclusive cosmetics (design/art
   task, recurring).

Phase 1 alone captures most of the modelled retention lift and fixes the ticket
inflation — build it first, measure, then layer 2-3.

---

## 15. Resolved decisions

1. **Tier cost — gentle escalation, front-loaded.** First 5 tiers cheap (~30 crowns)
   so a new player claims 3-4 rewards on day 1-2 (D1 is the top churn moment); the
   rest ~55; total ~2 600. Fast early tiers are the strongest early hook.
2. **Reward rhythm — no empty tier + milestone "wow".** Every tier grants something
   (keeps the goal-gradient alive). Free lane: mostly tickets + a common cosmetic
   every ~10 tiers + a streak-freeze at 15 & 35. Premium: crown boost early
   (tier 3-5), exclusive cosmetics at milestones (10/25/40), legendary + season
   title at tier 50. Milestones 10/25/50 = big rewards. (Exact art = later content
   task; the rhythm is fixed.)
3. **Rollover — auto-grant.** Reached-but-unclaimed rewards are granted
   automatically at season end. Nobody loses what they earned (forfeit breeds
   resentment → worse churn than the FOMO is worth).
4. **Comeback delivery — don't depend on push.** Build the offer to surface on the
   next app open (works regardless); add MiniPay push/deeplink as an amplifier IF
   available (verify with MiniPay at phase 3). Not a blocker.
5. **Crowns in staked games — same rate as free.** Progression is earned by
   PLAYING, not by spending: paying more must NOT advance the pass faster
   (pay-to-progress ≈ pay-to-win on progression). Same crown rate free/staked; the
   10-games/day soft cap spans all games combined (no farming).

---

## 16. Content pipeline (Phase 4 — the recurring task)

The plumbing is live: a season's exclusive cosmetics are **real, grantable,
equippable** dice skins, drawn per season from a shared pool.

**How it works (code):**
- `SEASON_SKINS` (packages/shared) is the pool of pass-only skin ids. `seasonSkinsFor(seasonId, n)`
  draws a **distinct set per season** (rotates; disjoint until the pool wraps).
- `seasonTiers(seasonId)` places that season's skins at the cosmetic tiers
  (free 25/50, premium 20/40). The server threads the current season id everywhere
  (buildSeasonState / claim / retro-unlock), so each season's table is its own.
- Claiming a cosmetic reward calls `store.ownSkin` → the skin is really owned; the
  server pushes `skin.owned` so the client can equip it immediately.
- The visuals are **procedural** (colour + optional 3D material in
  `apps/web/src/lib/diceSkins.ts`) — no image assets, so a new skin is pure data.
- Pass-only skins are `unlocked: () => false` + `season: true`; the picker labels
  them "👑 Season reward" and never offers a buy.

**The recurring per-season task (design/ops, ~30 min):**
1. Add N new skin ids to `SEASON_SKINS` and matching entries in `DICE_SKINS`
   (pick a palette + material; that's the whole "art" step for procedural skins).
2. Optionally theme the season title (`season-<id>-legend`).
3. Deploy web + server. `seasonTiers(seasonId)` picks the new set automatically at
   the next rollover — no per-season code change.

**Deferred (real art):** bespoke illustrated/animated skins + board themes remain a
true art task; the pool + grant rails above already support them (add the asset,
give it an id). Titles are cosmetic-only text today (no title-display UI yet).
