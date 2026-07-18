# simulation/RESULTS.md — Multiplayer bot simulation (Phase 4)

Bots play each other through the **real WebSocket layer** (the actual server
protocol, not direct engine calls). Three modes: rational (10k full games +
invariants), chaotic (fuzzing catalog), and deterministic replay.

## 1. Rational bots — 10,000 complete games

`npm run sim:rational -- 10000 60` against `SRV='ws://localhost:8787/?qa=simkey'`
(server in fast/QA mode, see §4). Two bots pair on a FREE private table and play
a full game via `game.roll` / `game.move`, with **6 rotating strategy pairings**
(first, last, advanced, laggard, random, exiter). After **every** server-applied
state the structural + server-correctness invariants (§5) are checked.

| Metric | Result |
|---|---|
| Games played | **10,000** |
| Completed (reached game.over) | **10,000** (100%) |
| **Invariant violations** | **0** |
| **Crashes** | **0** |
| **Zombie games** (never finished) | **0** |
| Wall-clock | 290 s (~34 games/s, concurrency 60) |
| Strategy pairings | 6, ~1,667 games each |

Every game's dice + move sequence is recorded; a violation/crash/zombie would be
persisted to `simulation/out/fail-<idx>.json` for deterministic replay. **None
occurred** in the clean run, so no failure needed converting to a regression test
(the standing engine-invariant guard is Phase 1's `fast-check` property suite).

## 2. Chaotic bots (fuzzing) — 16 attacks, all handled cleanly

`npm run sim:chaos` against a server with a real settle-window (`DIE_SETTLE_MS=150`).
Attacks are drawn from `simulation/attack-catalog.json` — a **33-attack, 14-
invariant catalog** produced by an adversarial multi-agent workflow (4 independent
attacker lenses + an invariant proposer). For every attack the server must: not
crash (still `pong`s after), not corrupt the honest game (invariants still hold),
and reject the action (error or clean silent drop).

**16/16 handled cleanly.** Highlights (server-bug hypotheses tested and refuted):

- **Malformed / bad-type** (`{invalid json`, token `7/-1/1.5/"0"/null/NaN`, gift to
  seat `1.5/99`) → `BAD_MESSAGE`, connection survives.
- **Oversized frame** (>1 KB) → closed cleanly by the 1024-byte `maxPayload` cap;
  the server is unaffected (a fresh connection still works).
- **Out-of-turn roll/move** → `NOT_YOUR_TURN`, no dice leaked.
- **Nonexistent token** (token 3, only 2 tokens/player) → **`ILLEGAL_MOVE`, NOT the
  engine's `invalid token` throw** — `Room.move`'s legal check catches it first (the
  workflow flagged this as a potential `INTERNAL`/crash path; refuted).
- **Settle-window double-move race** → the server **SURVIVES**; the single-legal
  auto-play timer is cancelled by the manual move, no duplicate apply, no crash
  (the workflow's top crash hypothesis; refuted).
- **Double-booking** (`queue.join` while already in a game) → `BAD_STATE`, no second
  match.
- **Post-game actions** (roll/move after `game.over`) → inert.
- **Entropy reveal mismatching the hello commit** → rejected.
- **Pre-match actions** (roll/move before any game) → silently dropped.

## 3. Deterministic replay

`npm run sim:replay` records one fresh game over the wire, then re-drives the PURE
engine with the recorded dice + move sequence (single-legal moves auto-played,
multi-choice moves taken from the record in order) and asserts it reproduces the
server's exact winner + final board.

Result: **engine replay REPRODUCED the game deterministically** (server winner ==
engine-replay winner, identical final positions). `npm run sim:replay out/fail-N.json`
replays a recorded failure: if a violation reproduces offline it is an engine bug
(convert to an engine unit test with the exact dice sequence); if not, the live
anomaly was protocol/timing, not the engine.

## 4. Harness enablement (server changes)

The prod-facing protections throttle a single-host load run, so two changes were
added, gated so **prod behaviour is unchanged**:

- **QA connections bypass the per-IP connection cap + rate limiter** (`index.ts`).
  QA connections carry the secret `QA_KEY` (`?qa=…`); real users never do. Also
  serves Phase 6 load testing.
- **Pacing is env-tunable**: `DIE_SETTLE_MS` (1v1 forced-move animation beat) and
  `BOT_ROLL_MS`/`BOT_MOVE_MS` (4p) default to the prod values (900/700/900 ms) and
  drop to 0 for an accelerated sim. A full 2p game runs in ~200 ms at `DIE_SETTLE_MS=0`.

Run the sim server: `QA_KEY=simkey DIE_SETTLE_MS=0 BOT_ROLL_MS=0 BOT_MOVE_MS=0 PORT=8787 npx tsx apps/server/src/index.ts`.

## 5. Invariants checked (after every action)

Structural (`simulation/invariants.mjs`): each seat keeps exactly its token count;
every position in {-1, 0..56} (no overshoot past FINISHED); turn is a valid in-play
seat; phase ∈ {awaiting-roll, awaiting-move, over}; `legal[]` only valid non-finished
tokens; dice ∈ 1..6; a declared winner truly has all tokens home; total token count
conserved. Server-correctness: the moved token was in the prior legal set
(`INV-MOVED-TOKEN-WAS-LEGAL`); it advanced by exactly the die / exited base to 0
(`INV-MOVE-DELTA-EXACT`); a capture returned an opponent token to base
(`INV-CAPTURE-RETURNS-TO-BASE`).

## 6. Verdict

**GO.** 10,000 full games over the real network with zero invariant violations,
crashes, or zombie games, plus a 16-attack fuzzing catalog all rejected cleanly and
confirmed deterministic replay. Scope note: this run is **2-player** (the primary
staked mode); 4-player rules are covered over real WS by `e2e/wire-4p.mjs` and by
Phase 1's 4p `fast-check` property suite. Concurrency/soak at larger scale is Phase 6.
