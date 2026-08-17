# Game design — operational summary

(Full version: "Ludo Arena — Design" Word document, outside the repo.)

## Core format: Blitz 1v1

- 2 tokens per player. Token 1 starts on the start cell, token 2 leaves base with a 6.
- Standard 52-cell track, 8 safe cells (stars), 5-cell home column.
- Overshoot allowed to finish (no exact roll required) → 3-6 minute games (~68 rolls on average, validated by simulation).
- 6 or capture = roll again. Capture = opponent token sent back to base (except on safe cells).
- 15 s/decision clock, auto-move on expiry, 3 consecutive auto-moves = forfeit.
- Win: both tokens reach the center.

## Retention loops

| Loop | Mechanic | KPI |
|---|---|---|
| Session | 1-tap rematch, matchmaking < 10 s | ≥ 3 games/session |
| Daily | daily challenge, login streak, daily freeroll (2-ticket entry) | D1 ≥ 40 % |
| Seasonal | season pass: crowns per game → 50-tier reward track over 28 days (replaced the weekly divisional league) | D7 ≥ 20 % |
| Social | private table via WhatsApp link, $0.25 referral | K ≥ 0.3 |

## Anti-churn

- ELO matchmaking ± 100.
- 3 consecutive staked losses → freeroll ticket(s) (anti-tilt; the earlier cash-cashback design was dropped — it created an unbacked liability).
- Daily stake limit (default and max $15/day, self-lowerable in Settings), self-exclusion, no casino mechanics.
- Disconnection ≠ loss (auto-move, 60 s reconnection).

## Business model (3-tier hybrid)

1. Degressive rake on staked games — 10 % (25¢) · 8 % ($1) · 6 % ($5): the acquisition tier carries the fixed settlement-gas overhead, the retention tier is priced to keep high-stake players — **geo-gated** by a legal allowlist (`STAKING_ALLOWED_COUNTRIES`).
2. Premium season pass: $1.50 USDT once per 28-day season (a conversion loss-leader — see `SEASON_PASS_SPEC.md` §4) + cosmetics.
3. Sponsored freerolls + MiniPay incentive program (CELO grants indexed on real on-chain activity).

## UI tone

**"The premium table"** (Organic pass, 2026 — replaces the royal-blue candy direction, which read as a mobile casino). The app should look like a beautiful board game sitting on a table: cream ground `#F5EAD8` lit from the top, sand surfaces, raised paper panels `#FFFDF8`, and **one** accent — terracotta `#C67139`. Ceramic pieces, Caprasimo on headings and every number treated as a figure, Figtree for body. Real money gets its own dark surface (`#201E1D`), never gold-on-blue.

Four seat colours extend the system, which only ships two accents: red-clay `#C8371B`, green `#3F7D2F`, yellow `#F2B307`, blue `#1F5FA8` — pulled apart in both hue and value so four pieces stay legible at 12 px. Board cosmetics never re-skin them.

No emoji anywhere in the product surface: the icon set is vendored inline SVG (`components/icons.tsx`). Subtle micro-animations, never casino-style flashing — no artificial-urgency badges before a first game. EN default; FR/PT/ES/SW opt-in via `?lang=`.
