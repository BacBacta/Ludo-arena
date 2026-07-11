# Implementation backlog

Each task is self-contained and sized for an agent. Check off on delivery. Follow `AGENTS.md`.

## E1 — Foundations (done in the scaffold)

- [x] Pure game engine + tests + simulation
- [x] Typed shared protocol
- [x] ws server: hello/queue/rooms/commit-reveal dice/auto-move
- [x] Frontend: lobby, matchmaking, SVG board, end screen, bot mode
- [x] LudoEscrow contract (create/join/settle/rake) + Foundry tests
- [x] CI (typecheck, tests, simulation, build)

## E2 — Production-ready PvP

- [x] **E2.1 Persistence**: replace in-memory Maps with Redis (sessions, queues, rooms) + Postgres (players, games, ELO). Schema in `apps/server/src/store/persistent.ts`. *AC: a server restart does not kill in-progress games — verified by `npm run restart-test -w apps/server` (needs `docker compose up -d`).*
- [x] **E2.2 Full reconnection**: resume via sessionToken from the client ("reconnecting…" UI), state resync. *AC: cutting the network for 20 s mid-game → the game continues — verified by `npm run reconnect-test -w apps/server` (no infra needed).*
- [x] **E2.3 Persistent ELO + ±100 matchmaking** with progressive widening (+50/5 s). *AC: unit test for the window — `apps/server/test/matchmaking.test.ts` (persistent ELO landed with E2.1: Postgres `players`, wallet-linked).*
- [x] **E2.4 Rate limiting & frame size** (already capped at 1 KB) + temporary bans. *AC: abuse test — unit (`test/rateLimit.test.ts`) + integration (`npm run abuse-test -w apps/server`: flood → 5 min IP ban, other IPs unaffected, oversized frame drops the connection without crashing the server).*

## E3 — Real on-chain integration

- [ ] **E3.1 Alfajores deployment** of LudoEscrow + `forge script` + addresses in `packages/contracts/deployments.json`.
- [ ] **E3.2 Web-side staking flow**: approve cUSD + `join(gameId)` via viem (legacy tx, cUSD feeCurrency), UI states (awaiting confirmation, locked). *AC: full staked game on Alfajores.*
- [ ] **E3.3 Server arbiter**: EIP-712 result signature, `settle()` submission, retry + settlement queue. *AC: payout < 5 s after game.over on testnet.*
- [ ] **E3.4 On-chain timeout**: refund if the opponent never joins within 120 s (`refundExpired`).

## E4 — Retention

- [ ] **E4.1 Daily challenge** (server config, progress, ticket reward) + UI.
- [ ] **E4.2 Login streak** persisted + D3/D7 rewards.
- [ ] **E4.3 Weekly league**: divisions, leaderboard, promotion/relegation cron Monday 00:00 UTC.
- [ ] **E4.4 Private table**: room creation via code/link (`/g/ABC123`), WhatsApp sharing.
- [ ] **E4.5 Anti-tilt cashback**: detect 3 consecutive staked losses → credit 20 % of rake + toast.

## E5 — Trust & compliance

- [ ] **E5.1 Dice verification page**: replay hashes client-side (WebCrypto) from `fairnessReveal`, educational UI.
- [ ] **E5.2 Responsible gaming limits** server-side: max daily stake per wallet (default 200 cents), self-exclusion, settings page.
- [ ] **E5.3 Anti multi-accounting v1**: device fingerprint + refuse repeated staked games against the same wallet (> 3/day).
- [ ] **E5.4 Geo-gating**: country header (CDN) → stakes disabled in unauthorized countries (config list).

## E6 — Polish & i18n

- [ ] **E6.1 Full i18n** FR/EN (files in `apps/web/src/lib/i18n.ts`) then PT/ES/SW.
- [ ] **E6.2 Subtle sounds** (dice, capture, win) — < 30 KB total, opt-out.
- [ ] **E6.3 Token movement animations** (cell-by-cell interpolation, 120 ms/cell).
- [ ] **E6.4 First-session onboarding**: free sponsored welcome game, single tooltip.
- [ ] **E6.5 PWA**: manifest + service worker (asset cache, offline vs bot).

## E7 — MiniPay listing

- [ ] **E7.1 ToS + privacy policy** (static pages, required by the Mini Apps ToS).
- [ ] **E7.2 Testing inside MiniPay** (dev mode, docs.minipay.xyz checklist), container/viewport fixes.
- [ ] **E7.3 Listing submission** + activation analytics (first-session funnel).
