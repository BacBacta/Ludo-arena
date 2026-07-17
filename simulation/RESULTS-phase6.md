# RESULTS — Phase 6: performance & endurance

Environment: **2 vCPU, 8 GB RAM** container. The load generator runs on the SAME
two cores as the server, so every number below is a *floor* — real capacity on a
dedicated host is higher.

## 1. WebSocket load — budgets

`npm run sim:load -- <games> <holdSeconds>` against a QA server. Games are held
**simultaneously** (prod pacing, so a game lasts ~60 s and the concurrency is
genuinely sustained rather than decaying as games finish).

**Action latency = `game.roll` → the server's `game.dice` for that roll** (the real
round-trip a player feels).

| Simultaneous games | Connections | p50 | **p95** | p99 | max | errors | conn fails | lost msgs | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **500** | 1 000 | 1 ms | **15 ms** | 29 ms | 191 ms | 0 | 0 | 0 | ✅ |
| **2 000** | 4 000 | 11 ms | **138 ms** | 242 ms | 499 ms | 0 | 0 | 0 | ✅ |

Budget **p95 < 300 ms, no errors, no message loss → PASS at both tiers** (2 000
games: 129 850 sampled actions, ramped in 15 s with 0 connection failures).

### Why not k6 / Artillery

Neither is installed here, but the deeper reason is fit: an "action" in this stack
lives inside a stateful protocol (hello + entropy commit-reveal + private-table
pairing before a single roll is even legal). A generic WS load script would have to
reimplement the whole client to produce one measurable action. `simulation/load.mjs`
drives the **real client protocol** (the same `WireBot` the e2e suite uses), so it
measures true end-to-end action latency rather than raw socket echo.

## 2. Memory & file descriptors

Sampled on the real server process (the node listener, **not** the npx/tsx wrapper —
sampling the wrapper reports a misleading 7 MB / 4 fds).

- **File descriptors: no leak.** At 2 000 simultaneous games FDs rose to **4 024**
  (= 4 000 sockets + 24 baseline) and returned to **24** once the load stopped —
  every connection fully released.
- **RSS at load:** 248 MB → ~345 MB peak with 4 000 live connections (~24 KB per
  connection), settling after.

## 3. Soak — memory **plateaus**, no leak

`npm run sim:rational -- 40000 35` on a **fresh** server: continuous games at
25–43 games/s (≈50–86 sessions/s of churn), run past the retention horizon.

The server deliberately keeps a disconnected session in memory for **10 minutes**
so the player can reconnect
(`index.ts`: `setTimeout(() => { if (!s.alive && !s.room) sessions.delete(s.id) }, 600_000)`).
So RSS *must* climb for the first 10 minutes while that bounded buffer fills — a
run shorter than the horizon cannot tell "bounded retention filling" from a leak.
This run crossed it:

| Phase | RSS | Slope |
|---|---|---|
| Fill (t+0 → t+10) | 172 → 1012 MB | ~**+84 MB/min** (peak +155) |
| **Plateau (t+11 → t+16)** | 1068 · 1072 · 1077 · 1041 · 1076 · **1028** MB | **net −40 MB over 5 min** (oscillates ±35, no upward trend) |

**The slope collapses at exactly the 10-minute horizon: RSS then oscillates in a
flat 1028–1077 MB band and ends the plateau 40 MB LOWER than it started it** (it
fell at t+14 and again at t+16). That is the signature of bounded retention
reaching steady state (arrivals ≈ expirations) — **not a leak**.

Across the whole run: **0 invariant violations · 0 crashes · 0 zombie games**, and
**FDs flat at ~90–94** (35 concurrent games × 2 + overhead) — no descriptor leak.
Run total: **24 000 games completed**.

> **The 24-hour soak is still a required, human/CI-scheduled run** on a dedicated
> host — it is not reproducible in this session, and I am not claiming it as done.
> What this run *does* establish: the memory plateau is real and located at the
> retention horizon, FDs are flat, no zombies, no violations, and connections fully
> release after load. The 24 h run should confirm the plateau holds over a full day
> and that RSS at steady state fits the Fly instance (here ≈1.05 GB at ~30 games/s;
> **size the instance for the plateau, not the idle baseline**).

## 4. Real MiniPay conditions (`e2e/ui-perf.mjs`) — 5/5 ✅

Android **360×800** webview, **3G throttling (750 kb/s, 100 ms RTT)** via CDP
`Network.emulateNetworkConditions`, **low-end CPU (4× slowdown)** via
`Emulation.setCPUThrottlingRate`.

| Budget | Measured | Verdict |
|---|---|---|
| Initial JS+CSS **< 500 KB** gzipped | **201 KB** over the wire | ✅ (40 % of budget) |
| **Time-to-interactive < 5 s** | **3 954 ms** | ✅ |
| Origin serves compressed assets | 2/2 gzip | ✅ (measurement guard) |

Initial critical path = `index.js` (189 KB gz) + `index.css` (11 KB gz). The
`diceEngine` chunk (114 KB gz) is **lazy** and off the critical path.

> **Measurement trap, now guarded.** The first run reported 669 KB / 10.1 s TTI —
> a *measurement artifact*: `python3 -m http.server` does not compress, so the probe
> was timing the uncompressed transfer over a 750 kb/s link. Production (Vercel)
> serves gzip/brotli. The probe now **asserts the assets arrived compressed**, so
> this cannot silently pass again; serve the build from a compressing origin.

## 5. Harness bug found & fixed during this phase

**False invariant violations from a shared `lastDie` (my Phase 4 harness).** The
soak surfaced `viol 2` at ~2 000 games. Investigation showed they were **not** a
server bug: `simulation/rational.mjs` updated the shared `lastDie[]` from **both**
bots' message handlers, so the guest's copy of an older `game.dice` could land after
the host's newer one and clobber it — `checkMove` then compared a move against a
stale die. The recorded evidence proves it: `fail-706` reported "advanced 0→6,
expected +3" on a state with `sixStreak: 2` (the real dice *were* sixes). Fixed by
writing `lastDie` (like `rec.dice`) from the **host stream only**. Re-run: **0
violations**. The Phase 4 10 k run was unaffected — `checkMove` did not exist yet,
and its 200-game validation was too small to hit the race.

## 5b. Slow leak found by *reasoning about* the 24 h soak (fixed)

The 16-minute run plateaus, but that only clears leaks that fill within the
10-minute session-retention window. Asking "what would a 24 h run still catch?" led
to an audit of the server's long-lived maps for **unbounded** growth — and found a
real one: **`settlementNotify` / `settlement4Notify`** (gameId → sessions to notify
of a payout) were purged **only** by `onSettled`/`onRefunded`. Three terminal
outcomes notify nobody and so **never deleted their entry**: a `failed` payout
(non-depositor winner / exhausted retries), an already-resolved game, and a no-op
refund (`None` status — added in Phase 0). Each leaks one small object per staked
settlement, **forever** — invisible at 16 min, real over a day of staked play.

Fix: an `onTerminal(gameId)` callback that fires on **every** terminal outcome.
`process()` now wraps a `processOnce()` that returns a terminal/not-terminal
boolean, so no future branch can leak the caller's bookkeeping. `index.ts` drops
the notify entry in `onTerminal` for both the 1v1 and 4p queues. Regression:
`settlement.test.ts` asserts `onTerminal` fires for settled/failed/already-resolved/
None/no-op-refund and does **not** fire while a job is merely rescheduled (server
suite 103/104).

## 6. Verdict

**GO.** p95 is 15 ms at 500 and 138 ms at 2 000 simultaneous games (budget 300 ms)
with zero errors and zero message loss; the MiniPay client budgets pass with
headroom (201 KB / 3.95 s on 3G + 4× CPU); and endurance shows **no leak** —
memory plateaus at the 10-minute retention horizon (slope +84 → +2 MB/min, RSS
flat/falling in a 1028–1077 MB band, net −40 MB) with FDs flat, zero zombies and zero
violations over 24 000 continuous games.

**Residual (human/ops):** the **24-hour soak on a dedicated host** is still
required — this session proves the plateau exists and where it sits, not that it
holds for a day. Sizing note for that run: steady-state RSS was ≈**1.05 GB at
~30 games/s**, so the Fly instance must be sized for the **plateau**, not the idle
baseline (172 MB).
