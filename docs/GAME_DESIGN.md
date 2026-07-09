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
| Daily | daily challenge, login streak, 1 freeroll/day | D1 ≥ 40 % |
| Weekly | divisional leagues (promotion/relegation on Mondays) | D7 ≥ 20 % |
| Social | private table via WhatsApp link, $0.25 referral | K ≥ 0.3 |

## Anti-churn

- ELO matchmaking ± 100.
- 3 consecutive staked losses → 20 % rake cashback + freeroll ticket.
- Daily spend limit (default $2), self-exclusion, no casino mechanics.
- Disconnection ≠ loss (auto-move, 60 s reconnection).

## Business model (3-tier hybrid)

1. 8-10 % rake on staked games ($0.10 – $2), 10-12 % on tournaments — **geo-gated** by legality.
2. $0.99/month season pass + cosmetics.
3. Sponsored freerolls + MiniPay incentive program (CELO grants indexed on real on-chain activity).

## UI tone

Understated premium: deep forest background (#0E1512), #16211C cards, gold accent #F5B301, player #2E9E6B, opponent #E8833A. Subtle micro-animations, never casino-style flashing. system-ui typography. FR/EN at launch (then PT/ES/SW).
