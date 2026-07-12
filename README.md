# 🎲 Ludo Arena

**Ludo Mini App for [MiniPay](https://minipay.to)** — 3-6 minute Blitz 1v1 matches, stablecoin micro-stakes on Celo, provably fair dice, winnings paid within seconds.

> See `docs/GAME_DESIGN.md` for the product design summary (retention, anti-churn, business model).

## Architecture

```
ludo-arena/
├── apps/
│   ├── web/            # React + Vite + viem frontend (MiniPay Mini App)
│   └── server/         # Authoritative game server (Node + WebSocket)
├── packages/
│   ├── game-engine/    # Pure, deterministic, tested Ludo rules engine
│   ├── shared/         # Shared types & WebSocket protocol
│   └── contracts/      # Solidity smart contracts (stake escrow, Celo)
├── docs/               # Architecture, protocol, backlog, contracts
└── AGENTS.md           # Guide for AI agents working on this repo
```

**Core principle:** the server is **authoritative** (rules run in `game-engine` server-side, never trusted client-side), financial settlement is **on-chain** (escrow contract), and randomness is **verifiable** (commit-reveal, see `docs/PROTOCOL.md`).

## Quick start

```bash
npm install

# Frontend only (offline bot mode included — playable immediately)
npm run dev:web        # → http://localhost:5173

# Game server (real-time PvP)
npm run dev:server     # → ws://localhost:8787
# Optional persistence (restart survival): docker compose up -d
# then set REDIS_URL + DATABASE_URL (see apps/server/.env.example)

# Checks
npm test               # unit tests (game engine + server store)
npm run typecheck      # strict TypeScript across all workspaces
npm run simulate       # 2,000-game simulation (termination, stats)
```

## Publish to GitHub

```bash
gh repo create ludo-arena --private --source . --push
# or manually:
git remote add origin git@github.com:<you>/ludo-arena.git
git push -u origin main
```

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 18, Vite, strict TypeScript, CSS design tokens (no heavy CSS framework), PWA (offline app shell) | ≤ 300 KB gzip bundle budget (AGENTS.md rule 4) for MiniPay usage (3G, entry-level Android) |
| Wallet | viem + MiniPay injected provider (`window.ethereum.isMiniPay`) | Official MiniPay recommendation; legacy transactions, cUSD feeCurrency |
| Backend | Node 20+, `ws`, shared engine | Lightweight, < 200 bytes/move messages, reconnection + auto-move |
| Contracts | Solidity 0.8.x, Foundry | Stake escrow, arbiter-signed settlement, configurable rake |
| Quality | Strict TypeScript, Vitest, ESLint, Prettier, GitHub Actions CI | Repo defaults |

## Status

Fully functional scaffold: tested engine, PvP server, playable frontend (bot mode), escrow contract. The remaining implementation backlog (persistence, stored ELO, tournaments, full i18n, contract audit…) lives in `docs/BACKLOG.md` — every task is sized to be handed to an agent.

## License

Proprietary — © 2026 Mike / SwapPilot. All rights reserved.
