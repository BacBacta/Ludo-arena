# Deployment

Two targets: the **frontend** on Vercel and the **game server** on Fly.io.
Both configs are in the repo and verified locally (server image builds + passes
E2E, web build bakes the server URL). The steps below need your authenticated
Vercel / Fly accounts.

## 1. Server → Fly.io (`apps/server`)

Config: [`fly.toml`](../fly.toml) + [`apps/server/Dockerfile`](../apps/server/Dockerfile).
The server runs the TS entrypoint via `tsx`; the image ships only the
`game-engine`, `shared` and `server` workspaces (see `.dockerignore`).

```bash
# one-time
flyctl auth login
flyctl launch --no-deploy --copy-config --name ludo-arena-server   # reuses fly.toml

# managed infra (persistence, E2.1) — or use Upstash Redis + any Postgres
flyctl postgres create --name ludo-arena-db
flyctl postgres attach ludo-arena-db          # sets DATABASE_URL secret
flyctl redis create                           # Upstash; note the REDIS_URL

# secrets
flyctl secrets set \
  REDIS_URL="redis://…" \
  DATABASE_URL="postgres://…" \
  ARBITER_PRIVATE_KEY="0x…" \
  CHAIN="celo-sepolia" \
  STAKING_ENABLED="false" \
  STAKING_ALLOWED_COUNTRIES="" \
  TRUSTED_EDGE_SECRET="" \
  MINIPAY_ALLOWED_ORIGINS=""

flyctl deploy
```

### New security env (set before real money)

- **`TRUSTED_EDGE_SECRET`** (G-6) — the geo header (`cf-ipcountry`/`x-vercel-ip-country`)
  is client-forgeable because the Fly server is directly reachable over WS. Put a
  trusted edge (Cloudflare/Vercel/Fly proxy) in front that sets both the country
  header **and** `x-edge-secret: <this>`; the server only believes the country when
  the secret matches. **Geo fails CLOSED**: once `STAKING_ALLOWED_COUNTRIES` is set,
  an unverifiable region (no/forged secret) is refused staked play — so wire the
  edge BEFORE populating the allowlist, or all staked play is refused.
- **`MINIPAY_ALLOWED_ORIGINS`** (R-AUTH-1 defence-in-depth) — comma-separated WS
  origins allowed to auto-prove a MiniPay wallet (e.g. the MiniPay webview origin).
  Browsers forbid JS from setting Origin, so this closes the malicious-website
  vector. Empty = dev/testnet (any origin). A non-browser script can still forge
  Origin; that residual needs the MiniPay attestation below.
- **`DATABASE_URL`** — Postgres for durable settlement (`settlementDurable()` gates
  real stakes on it). Without it the server runs Redis-only (in-memory durable) and
  refuses wallet-backed staked play.

### Real-money launch gate (R-COMP-2)

`STAKING_ENABLED` is the **explicit** switch for staked play. Settlement arms
ONLY when `STAKING_ENABLED="true"`; with it unset/false the server refuses to
create arbiters even when `ARBITER_PRIVATE_KEY` + escrow addresses are present
(it logs a warning at boot). This exists so mainnet addresses landing in secrets
can never *silently* take real money — enabling staking is a deliberate,
auditable step, not a side effect of a key being configured. Flip it to `"true"`
per network only after launch sign-off.

Before setting it `"true"` for real money, also confirm:

- **`STAKING_ALLOWED_COUNTRIES`** (R-COMP-1) holds the legal-reviewed ALLOWLIST —
  staked play is legal-by-exception, so only listed countries may stake; set but
  empty (as above) blocks staking everywhere, and leaving the variable UNSET
  (dev/testnet open mode) makes the server warn at boot. Real-money rake in an
  unreviewed jurisdiction is a compliance exposure.
- **Arbiter key custody (R-KEY-1, ops task — NOT closed in code).** The single
  hot `ARBITER_PRIVATE_KEY` here signs every payout AND is the treasury+owner on
  the current deployment. A compromise lets the holder name themselves winner of
  any game they seat in and redirect the rake. Before mainnet: move the key to a
  KMS/secret manager (not a plaintext Fly secret), and split the signer from the
  gas submitter so the signing key is not exposed on the always-on box. The
  `refundActive` 24 h valve + the gas-balance monitor are mitigations, not a fix.
- **Contracts redeployed** with the R-ESCROW-1 pull-payment `LudoEscrow` and the
  post-C3 `LudoEscrowN` (R-DEPLOY-1), and `ESCROW_ADDRESS`/`ESCROW_N_ADDRESS`
  updated to the new addresses.

The app listens on `internal_port` 8080 (WS upgrades over the same port), health
check `/health`. Result URL: `wss://ludo-arena-server.fly.dev` — this is the URL
baked into the frontend build (keep the app name in sync with `vercel.json`).

## 2. Frontend → Vercel (`apps/web`)

Config: [`vercel.json`](../vercel.json) (monorepo build → `apps/web/dist`, SPA
rewrite, PWA files served from `/`).

```bash
vercel login
vercel link            # pick/create the project at the repo root
vercel --prod
```

Or connect the GitHub repo in the Vercel dashboard (root directory = repo root;
it picks up `vercel.json`). Set/confirm project env vars (they are baked at
build time):

- `VITE_SERVER_URL = wss://ludo-arena-server.fly.dev`
- `VITE_CHAIN = celo-sepolia`

## Order

Deploy the server first, confirm `https://ludo-arena-server.fly.dev/health`
returns `{ "ok": true }`, then deploy the frontend (its build points at that
URL). For MiniPay, submit the Vercel production URL (BACKLOG E7).

## 3. Redeploying the hardened contracts (R-DEPLOY-1 + G-2 coordination)

The R-ESCROW-1 pull-payment `LudoEscrow` and the post-C3 `LudoEscrowN` are in the
source but the LIVE Celo Sepolia deployment still runs the older bytecode. This is
the procedure to redeploy them. **Testnet only — never mainnet; use a Celo Sepolia
deployer key funded from a faucet, never a real-funds key.**

> Rehearsed on a local anvil: `NETWORK=localhost npm run deploy` deployed the
> hardened contracts (the deployed `LudoEscrow` answers `withdraw()` with the
> `NothingToWithdraw` custom error `0xd0d04f60` — proof the pull-payment is
> present) and wrote BOTH `packages/contracts/deployments.json` and the vendored
> `apps/web/src/deployments.json` to the same new addresses.

### The G-2 trap this order avoids

`deploy.ts` auto-syncs the **client** bundle copy (`apps/web/src/deployments.json`),
and since the Dockerfile bakes `packages/contracts/deployments.json` into the
server image, the **server** resolves the same file by `CHAIN` — client and server
converge on the committed addresses at their next respective deploys. The
`ESCROW_ADDRESS` / `ESCROW_N_ADDRESS` **Fly secrets** still WIN when set (override
hook), which is exactly how a stale address outlives a redeploy: if they are set,
either update them or `flyctl secrets unset` them. The G-2 guard makes a mismatch
fail SAFE (the client refuses to deposit into an escrow the server won't settle),
but you must land both deploys to actually take stakes.

### Steps (in this order)

```bash
# 1. Deploy the hardened contracts to Celo Sepolia (writes both deployments.json).
cd packages/contracts
NETWORK=celo-sepolia DEPLOYER_PRIVATE_KEY="0x<faucet-funded-testnet-key>" npm run deploy
#   → note the printed LudoEscrow + LudoEscrowN addresses.

# 2. Verify on Celoscan that each is verified + the hardened one (has withdraw()).

# 3. Commit the regenerated deployments.json (both files): Vercel rebuilds the web
#    with the new bundled addresses, and the next server image bakes the same file.
git add packages/contracts/deployments.json apps/web/src/deployments.json
git commit -m "chore: redeploy escrows on Celo Sepolia"

# 4. Redeploy the SERVER so its image picks up the committed addresses — and make
#    sure no stale override secret shadows them (unset is the steady state):
flyctl secrets unset ESCROW_ADDRESS ESCROW_N_ADDRESS
flyctl deploy

# 5. Confirm concordance: a hello.ok from the server now advertises the new escrow,
#    and the client bundle matches → deposits are accepted. If step 3 or 4 is
#    missed, staking is refused (G-2) rather than sending funds to a dead escrow.
```

Only after this, and the other launch-gate items above, flip `STAKING_ENABLED="true"`.
