# CI / CD

Two pipelines. The split is deliberate: **every PR pays only for what catches a
regression fast**, and the slow, high-assurance evidence runs nightly.

## Per PR — `.github/workflows/ci.yml`

| Job | What it protects |
|---|---|
| `check` | lint · typecheck · **unit tests** · engine simulate · build. Engine coverage thresholds (statements/functions/lines 90, branches 88) are enforced inside `packages/game-engine/vitest.config.ts`, so a coverage drop fails `npm test` — no separate gate to forget. |
| `audit` | `npm audit --omit=dev --audit-level=high` — gates **what actually ships**. |
| `e2e-smoke` | Boots a real server and runs the wire probes over a **real WebSocket**: `wire-regression`, `wire-gates`, `wire-security`, `wire-anticheat` (45 checks). |
| `contracts` | `forge test` — unit + fuzz + invariants. |

Concurrency-cancelled per ref: a new push makes the previous verdict irrelevant.

### Why the audit gate ignores dev dependencies

The dev tree (vitest/vite and friends) carries advisories that never reach a
user. Failing the build on those trains everyone to ignore a red audit — which is
exactly how a real one gets missed. The gate is on production deps only.

### Why the UI probes are not in the PR path

`e2e/lib/common.mjs` imports playwright **dynamically**, so the wire probes need
no browser download — they are pure `ws`. The UI probes (`ui-*.mjs`) do pay that
cost and are slow; they are nightly-grade.

## Nightly — `.github/workflows/nightly.yml`

03:00 UTC, plus `workflow_dispatch` so a release candidate can be checked on demand.

| Job | What it proves |
|---|---|
| `bot-sim` | **500 full games** through the real protocol with structural invariants checked after every server-applied state, then the **hostile-input catalog** (16 attacks). |
| `e2e-full` | The whole wire harness including `wire-identity` and `wire-4p`. |
| `money-flow` | `npm run sim:flow` — boots its own **anvil**, deploys the **real** escrows, and drives every player behaviour (win, resign, no-show, drop, AFK, stall) through the **real arbiter** to payout/refund, asserting tokens are conserved. 35 assertions. The closest rehearsal of real money there is, and it never touches mainnet. |

### Two pacing traps, encoded on purpose

- **`bot-sim` runs `rational` at `DIE_SETTLE_MS=0`** (it asserts state, not timing)
  but boots a **second server at `DIE_SETTLE_MS=150` for `chaos.mjs`**. Several
  chaos attacks race the die-settle window; at `0` that window does not exist and
  the probes would pass **by construction while testing nothing**.
- **`e2e-full` uses default pacing** because `wire-4p` asserts that no move lands
  inside the die tumble — the very thing `DIE_SETTLE_MS=0` removes. The PR smoke
  excludes `wire-4p` for that reason.

### When nightly goes red

`rational.mjs` writes `simulation/out/fail-<n>.json` with the **seed and the full
dice+move sequence**; the job uploads it as the `sim-failures` artifact and
`simulation/replay.mjs` re-runs it **deterministically**. A nightly failure is
reproducible, not a mystery.

## Not in CI, and why

- **24 h soak** — needs a dedicated host; CI runners are the wrong shape. See
  `simulation/RESULTS-phase6.md` (the plateau is proven flat for an hour).
- **Load at 500/2000 games** — the numbers are only meaningful on hardware where
  the generator is not fighting the server for the same two cores.
- **Slither** — run at audit time (`docs/AUDIT_PACKAGE.md`); the contracts are
  frozen between deploys, so per-PR runs would mostly re-prove the same tree.
- **`ui-perf`** — needs a **compressing** origin to be meaningful (see
  `e2e/lib/serve-gzip.mjs`); a plain static server measures uncompressed bytes and
  reports a false TTI. Run it against a real preview deploy.
