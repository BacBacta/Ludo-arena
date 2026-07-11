# Architecture

## Overview

```
┌─────────────────────────┐         WebSocket          ┌──────────────────────────┐
│  apps/web (Mini App)    │ ◄────────────────────────► │  apps/server             │
│  React + viem           │   intents / states         │  Node + ws (authorit.)   │
│  - Lobby / Board / End  │                            │  - matchmaking (ELO)     │
│  - offline bot mode     │                            │  - rooms + clocks        │
└───────────┬─────────────┘                            │  - commit-reveal dice    │
            │ signTransaction (stake)                  └───────────┬──────────────┘
            ▼                                                      │ settle(gameId, winner, sig)
┌─────────────────────────┐                            ┌───────────▼──────────────┐
│  MiniPay wallet         │                            │  LudoEscrow.sol (Celo)   │
│  window.ethereum        │──── stake (cUSD) ─────────►│  escrow → payout + rake  │
└─────────────────────────┘                            └──────────────────────────┘

        packages/game-engine (pure rules) is imported by BOTH web and server.
        packages/shared (protocol) is imported by BOTH web and server.
```

## Structural decisions

1. **Shared engine, authoritative server.** `game-engine` is a pure library (zero dependency, injected dice). The server runs the reference game; the client runs the same logic locally only for optimistic display and bot mode.
2. **Financial on-chain, gameplay off-chain.** Playing every move on-chain would be too slow/expensive. Only stake locking and settlement are on-chain. The server holds an "arbiter" key that signs the result; the contract verifies the signature. Funds never pass through an app-owned account.
3. **Commit-reveal randomness.** Before the game: the server publishes `commit = keccak256(serverSeed)`. Each client sends random entropy on connection. Die #i = `1 + (uint(keccak256(serverSeed ‖ entropyA ‖ entropyB ‖ i)) % 6)`. At game end the server reveals `serverSeed`: anyone can recompute every roll. The server cannot cheat (commit published before knowing the entropies); neither can clients (they never know the seed).
4. **Network resilience.** Disconnection ≠ forfeit: the player's clock keeps running and a legal move is auto-played on expiry (15 s/move in Blitz). Reconnection via session token → full state resync.
5. **Persistence (E2.1).** Hot state is written through to Redis (sessions with a 24 h TTL, room snapshots on every transition, queue membership) and durable records to Postgres (`players` with wallet-linked ELO, `games` history including the revealed fairness seed). At boot the server restores room snapshots and re-arms the clocks, so a restart does not kill in-progress games — players reattach with their `sessionToken`. Without `REDIS_URL`/`DATABASE_URL` the server falls back to in-memory stores (dev mode, no restart survival). Local infra: `docker compose up -d`. Acceptance test: `npm run restart-test -w apps/server`.
5. **Minimal frontend.** No CSS framework, CSS custom-property design tokens, SVG board generated from the engine constants (single geometric source of truth).

## MiniPay constraints

- Injected provider: `window.ethereum` with `isMiniPay === true`. Always provide a read-only fallback outside MiniPay.
- **Legacy transactions only** (no EIP-1559).
- Supported `feeCurrency`: cUSD.
- Stablecoins: cUSD, USDC, USDT (addresses in `apps/web/src/lib/minipay.ts`).
- Testing: MiniPay app developer mode → "Load test page".
- Network: Celo mainnet (42220) / Alfajores testnet (44787).

## Environments

| Env | Web | Server | Chain |
|---|---|---|---|
| dev | localhost:5173 | ws://localhost:8787 | Alfajores (44787) |
| staging | Vercel/Netlify preview | Fly.io/Railway | Alfajores |
| prod | domain listed in MiniPay | Fly.io/Railway + Redis | Celo mainnet |

## Security

- Anti multi-accounting: device fingerprint + wallet address + repeated-match graph (see BACKLOG E5).
- Rate limiting by IP + wallet on matchmaking.
- The arbiter key lives in a KMS/secret manager, never in the repo.
- Responsible-gaming limits enforced SERVER-SIDE (max daily stake per wallet).
