# Agent guide — Ludo Arena

This file is the source of truth for any agent (Claude Code, Copilot, Cursor…) working on this repo.

## Commands

```bash
npm install                 # root, installs all workspaces
npm run typecheck           # MANDATORY before any commit
npm test                    # engine tests (vitest)
npm run simulate            # sanity check: 2,000 games must terminate
npm run dev:web             # frontend http://localhost:5173
npm run dev:server          # server ws://localhost:8787
```

## Golden rules (non-negotiable)

1. **The engine (`packages/game-engine`) is pure and deterministic.** No `Math.random`, no I/O, no runtime dependency. Dice are always injected. Any rule change MUST go through this package and be covered by a test + the simulation.
2. **The server is authoritative.** The client only sends intents (`roll`, `move`). Never trust state sent by a client.
3. **No money logic client-side.** Displayed balances come from the wallet (viem) or the server. Real settlement goes through `packages/contracts`.
4. **Frontend bundle budget: 300 KB gzipped max.** No new UI dependency without written justification in the PR. No CSS framework. Images are inline SVG.
5. **MiniPay constraints** (docs/ARCHITECTURE.md §MiniPay): legacy transactions only (no EIP-1559), `feeCurrency` cUSD, stablecoins cUSD/USDC/USDT only, detection via `window.ethereum?.isMiniPay`.
6. **Strict TypeScript everywhere.** `any` is forbidden except with a `// justified-any:` comment.
7. **WebSocket messages**: any protocol evolution happens in `packages/shared/src/protocol.ts` FIRST, then server, then client — never the other way around.
8. **Responsible gaming**: never implement a feature that bypasses stake limits, the protection cashback, or self-exclusion.

## Style

- Prettier + ESLint (root configs). File names `camelCase.ts`, React components `PascalCase.tsx`.
- Commits: Conventional Commits (`feat(web): …`, `fix(engine): …`, `chore(ci): …`).
- One PR = one backlog task (`docs/BACKLOG.md`), with acceptance criteria checked off.

## Definition of Done

- `npm run lint`, `npm run typecheck`, and `npm test` pass (all enforced in CI).
- If the engine is touched: `npm run simulate` passes (0 unfinished games).
- If the protocol is touched: `docs/PROTOCOL.md` updated.
- No secret or private key committed (`.env` only, `.env.example` up to date).

## Code map

| Where | What |
|---|---|
| `packages/game-engine/src/engine.ts` | All game rules (legal moves, captures, win) |
| `packages/game-engine/src/constants.ts` | Board geometry (52-cell track, safe cells, home columns) |
| `packages/shared/src/protocol.ts` | Client ↔ server message contract |
| `apps/server/src/room.ts` | Match lifecycle (clocks, auto-move, disconnections) |
| `apps/server/src/store/` | Persistence: Redis (sessions, rooms, queues) + Postgres (players, games), in-memory fallback |
| `apps/server/src/fairness.ts` | Commit-reveal dice (server seed + player entropies) |
| `apps/web/src/state/store.tsx` | Frontend global state (single reducer) |
| `apps/web/src/lib/session.ts` (`LocalBotSession`) + `packages/game-engine/src/ludo4.ts` (`pickAutoMove4`) | Local AI (offline 2P / 4P practice) |
| `apps/server/src/room4.ts` + `packages/game-engine/src/ludo4.ts` | 4-player online Sit&Go (ticket entry, bot-fill, server-authoritative) |
| `apps/web/src/lib/minipay.ts` | MiniPay wallet integration via viem |
| `packages/contracts/src/LudoEscrow.sol` | Stake escrow + signed settlement |

## Backlog

Implementation tasks live in `docs/BACKLOG.md`, ordered by priority, with acceptance criteria. Pick the first unchecked task of the current epic unless instructed otherwise.
