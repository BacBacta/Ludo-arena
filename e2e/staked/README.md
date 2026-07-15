# e2e/staked — real-money (on-chain) audit probes

Not part of `run-all.mjs`: these need a testnet (celo-sepolia), funded wallets,
and the server in durable staked mode. They verify the money path the free-play
suites can't touch.

## Probes

- **`contract-settle.mjs`** — the staked happy path at the CONTRACT level
  (Option A of the audit). Two wallets lock 25¢ each in the escrow; the arbiter
  settles with the same EIP-191 scheme the server uses; asserts winner +payout,
  loser −stake, treasury +rake, pot conservation, and escrow pot locked→released.
  Proven 9/9 on celo-sepolia.
- **`wire-staked.mjs`** — the server frontier: two SIWE-proven consenting wallet
  sessions on one host (one IP) must be REFUSED for staked play (anti
  chip-dumping). This is why the money path is proven at the contract level —
  a single-host bench can't pair two staked players through matchmaking.
- **`setup-wallets.mjs`** — funds two throwaway test wallets (gas from the
  deployer key + open-faucet TestUSD mint). Writes keys to the scratchpad ONLY.

## Setup

```bash
# durable server (settlement enabled): needs the arbiter key + escrow + Redis + Postgres
docker run -d -p 6379:6379 redis:7-alpine
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=audit -e POSTGRES_DB=ludo postgres:16-alpine
cd apps/server
set -a; source ../../packages/contracts/.env; set +a
REDIS_URL=redis://localhost:6379 DATABASE_URL=postgres://postgres:audit@localhost:5432/ludo \
ARBITER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" CHAIN=celo-sepolia \
ESCROW_ADDRESS=0x5b2d7309a155abf7cd7fbdae7f75b93f6fc641d4 SETTLEMENT_RPC="$CELO_SEPOLIA_RPC" \
npx tsx src/index.ts &

# fund test wallets (deployer must hold a little CELO for gas + the mint)
node e2e/staked/setup-wallets.mjs
node e2e/staked/contract-settle.mjs
node e2e/staked/wire-staked.mjs
```

## Secrets

- `packages/contracts/.env` (gitignored) holds `DEPLOYER_PRIVATE_KEY` — the
  arbiter/owner/treasury key. Never printed, never committed.
- Test wallet keys are written to the session scratchpad, never the repo.
- Gas is scarce on testnet: use `type: 'legacy'` and a 1× `gasPrice` — viem's
  local max-cost pre-check is `gas_cap × gasPrice`, so an inflated cap or a
  multiplier can exceed a small balance even when real usage is far lower.
