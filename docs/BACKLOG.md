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
- [x] **E4.5 Anti-tilt cashback**: `applyAntiTilt` per staked game — a win resets the streak, a loss accumulates the game's rake; after `ANTI_TILT.losses` (3) in a row it credits `ANTI_TILT.rakeShareBps` (20 %) of the accumulated rake and resets. Persisted in Postgres (`loss_streak`/`lost_rake_cents`/`cashback_cents`); pushed via a `cashback` message (toast) + `hello.ok.cashbackCents` (lobby display). *AC: accumulation, 3-loss grant (rounding), post-grant reset, win-reset unit-tested on memory + Postgres (`test/store.test.ts`).*

## E5 — Trust & compliance

- [x] **E5.1 Dice verification page**: `apps/web/src/lib/fairnessVerify.ts` replays commit + every roll with WebCrypto from `fairnessReveal`; the fairness modal shows a per-roll played-vs-recomputed table with a verdict. *AC: verifier tested against the server algorithm incl. tampered commit/roll (`apps/web/test/fairnessVerify.test.ts`).*
- [x] **E5.2 Responsible gaming limits** server-side: daily stake cap per player (default/max 200 c), self-exclusion, settings modal; enforced on every staked intent. *AC: daily total + reset + exclusion expiry tested on memory + Postgres.*
- [x] **E5.3 Anti multi-accounting v1**: device fingerprint in hello + refuse same-device self-play and > `MAX_DAILY_GAMES_VS_SAME` (3) staked games vs the same wallet/day (private tables). *AC: pair-count store test.*
- [x] **E5.4 Geo-gating**: CDN country header → staked play disabled in `BLOCKED_COUNTRIES`; `hello.ok.stakingBlocked` drives a lobby banner. *AC: `npm run geo-test -w apps/server`.*

## E6 — Polish & i18n

- [x] **E6.1 Full i18n** FR/EN + PT/ES/SW (`apps/web/src/lib/i18n.ts`); English is the reference key set, every locale typed `Record<TKey,string>` so a gap fails typecheck; auto-detected with an EN fallback.
- [x] **E6.2 Subtle sounds** (dice, capture, win) — Web Audio synthesis (0 asset bytes, ≪ 30 KB), opt-out toggle persisted.
- [x] **E6.3 Token movement animations** — `useAnimatedPositions` steps one cell every 120 ms toward the real position (forward walks, resets snap; honours reduced-motion).
- [x] **E6.4 First-session onboarding**: welcome message + a free sponsored practice game on the first session (localStorage-gated).
- [x] **E6.5 PWA**: `manifest.webmanifest` + SVG icon + `sw.js` (network-first navigations, cache-first assets) registered in prod; offline → app shell loads → bot mode.

## E-social 2 — Friends & challenges

- [x] **ES2.1 Friend graph + one-tap challenge**: mutual-consent friendships (pid-keyed, proven-wallet-gated, silent removal), lobby Friends card with presence snapshot + requests, add-friend on the end screen, one-tap FREE challenge (server creates the private table, pushes a live in-app offer when the friend is connected, WhatsApp deep link covers offline — WhatsApp is the notification layer). *AC: store contract (request→mutual→lists→removal) on memory + Postgres (`test/store.test.ts`); full wire journey incl. unproven/non-friend refusals — `npm run friends-test -w apps/server`.*
- [ ] **ES2.2 Staked friend challenges UI** (server already accepts any allowed stake) + friends weekly mini-leaderboard.
- [ ] **ES2.3 Private tournaments between friends** (bracket over private tables).
- [x] **BUG (pre-existing, surfaced by ES2.1 verification) — diagnosed & resolved**: the E4.4 acceptance script failed on unmodified main because it predated TWO deliberate pre-launch guards, not because of a server defect: (1) the ToS consent gate refused its staked `table.create` (script now sends `consent` in hello); (2) the E5.3 anticheat refuses STAKED pairings between two sockets on the same IP (`collusionBlock`, "Same-network play…") — both test clients are localhost, and the script swallowed the `LIMIT_REACHED` reply and timed out on `both matched`. The script now asserts the same-IP refusal POSITIVELY and runs the create/join/play-to-`game.over` coverage on a FREE table (unaffected by the guard).

## E7 — MiniPay listing

- [ ] **E7.1 ToS + privacy policy** (static pages, required by the Mini Apps ToS).
- [ ] **E7.2 Testing inside MiniPay** (dev mode, docs.minipay.xyz checklist), container/viewport fixes.
- [ ] **E7.3 Listing submission** + activation analytics (first-session funnel).
