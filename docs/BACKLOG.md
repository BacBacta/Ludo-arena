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

- [x] **E3.1 Testnet deployment** of LudoEscrow — deployed on **Celo Sepolia** (chainId 11142220, successor of Alfajores) via `npm run deploy -w packages/contracts` (solc+viem; Foundry optional), addresses in `packages/contracts/deployments.json`. TestUSD deployed as stake token (no canonical cUSD on Celo Sepolia yet); arbiter/treasury point at the deployer until E3.3.
- [x] **E3.2 Web-side staking flow**: `approve` + `join(gameId)` via viem (`apps/web/src/lib/escrow.ts`), MiniPay legacy tx + cUSD feeCurrency, staking overlay (approving → joining → locked), wallet-backed balance (simulated fallback with no wallet). *AC: verified against the live Celo Sepolia escrow — `npm run stake-verify -w apps/web` (mint → approve → join → game status WaitingOpponent). Full 2-player settle awaits the arbiter (E3.3).*
- [x] **E3.3 Server arbiter**: result signature (EIP-191, matching the deployed `settlementDigest`), `settle()` submission, durable retry queue that resumes at boot (`apps/server/src/settlement.ts`). `game.settled` message carries the payout txHash to the client (EndScreen link). *AC: verified on live Celo Sepolia — arbiter settled a real staked game in ~5.5 s (`npm run settle-verify -w apps/server`, needs a funded arbiter key); queue retry/backoff unit-tested (`test/settlement.test.ts`).*
- [x] **E3.4 On-chain timeout**: the settlement queue detects a game stuck in `WaitingOpponent` (only one player staked) and calls `refundExpired` once the 120 s escrow timeout elapses, refunding the lone staker; `game.refunded` message + EndScreen note. Fixed a latent status-enum bug (Active is 2, not 1). *AC: refund branch (wait-then-refund, idempotency, timeout) unit-tested in `test/settlement.test.ts`; `refundExpired` itself covered on-chain by the contract smoke test.*

## E4 — Retention

- [x] **E4.1 Daily challenge** (server config `DAILY_CHALLENGE`, progress, ticket reward) + UI. Server-authoritative: captures tracked per player in Postgres (`challenge_*` + `freeroll_tickets`), UTC daily reset, `+1` freeroll ticket on completion; state pushed via `hello.ok.challenge` + `challenge.update`, cached client-side for the lobby. *AC: store logic (progress/completion/ticket/day-reset) unit-tested on memory + Postgres (`test/store.test.ts`).*
- [x] **E4.2 Login streak** persisted + D3/D7 rewards. Server-authoritative: `recordLogin` at hello (+1 if yesterday, reset to 1 on a gap, no-op same day) persisted in Postgres (`last_login`/`streak_days`); `STREAK_REWARDS` grants freeroll tickets at D3 (+1) and D7 (+2); pushed via `hello.ok.streak`, cached client-side. Wallet-scoped (anon rows are ephemeral). *AC: streak progression + D3/D7 rewards + gap-reset unit-tested on memory + Postgres (`test/store.test.ts`).*
- [x] **E4.3 Weekly league**: divisions (Bronze→Diamond), per-division leaderboard, weekly points on wins (`leaguePointsForWin`), promotion/relegation on the ISO-week boundary (checked at boot + hourly, so a restart never misses Mon 00:00 UTC). Server-authoritative (`division`/`weekly_points` in Postgres + a `meta` week marker); pushed via `hello.ok.league` + `league.update`, shown as a lobby card with the top-5 board. *AC: points/rank/leaderboard + rollover promote/relegate (with promotion precedence) unit-tested on memory + Postgres (`test/store.test.ts`); `isoWeek`/points config in `test/league.test.ts`.*
- [x] **E4.4 Private table**: `table.create` returns a 6-char code (unambiguous charset); a friend joins with `table.join` (or a `#/g/CODE` deep link) and both are paired via the normal `startGame` flow. Lobby "Private table" card creates a room; the matchmaking screen shows the code with a WhatsApp share + copy-link. Tables expire (15 min / host disconnect). *AC: create → share → join → play, plus bad-code TABLE_NOT_FOUND — `npm run private-table-test -w apps/server`.*
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
