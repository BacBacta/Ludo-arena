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
- Daily spend limit (default $2), self-exclusion, no casino mechanics.
- Disconnection ≠ loss (auto-move, 60 s reconnection).

## Business model (3-tier hybrid)

1. 8-10 % rake on staked games ($0.10 – $2), 10-12 % on tournaments — **geo-gated** by legality.
2. Premium season pass: $1.50 USDT once per 28-day season (a conversion loss-leader — see `SEASON_PASS_SPEC.md` §4) + cosmetics.
3. Sponsored freerolls + MiniPay incentive program (CELO grants indexed on real on-chain activity).

## UI tone

Playful premium (revised from the original dark-forest direction): royal-blue board-game background (#4666CF), white cards, gold accent #F5B301, player green #2E9E6B. Fredoka display type over system-ui body. Subtle micro-animations, never casino-style flashing — no artificial-urgency badges before a first game. EN default; FR/PT/ES/SW opt-in via `?lang=`.
