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
  ESCROW_ADDRESS="0x3fad6b9ecbc3f0c9064603dc762f8ebd6c7864d6" \
  ESCROW_N_ADDRESS="0x…" \
  STAKING_ENABLED="false" \
  BLOCKED_COUNTRIES="" \
  TRUSTED_EDGE_SECRET="" \
  MINIPAY_ALLOWED_ORIGINS=""

flyctl deploy
```

### New security env (set before real money)

- **`TRUSTED_EDGE_SECRET`** (G-6) — the geo header (`cf-ipcountry`/`x-vercel-ip-country`)
  is client-forgeable because the Fly server is directly reachable over WS. Put a
  trusted edge (Cloudflare/Vercel/Fly proxy) in front that sets both the country
  header **and** `x-edge-secret: <this>`; the server only believes the country when
  the secret matches. **Geo now fails CLOSED**: once `BLOCKED_COUNTRIES` is set, an
  unverifiable region (no/forged secret) is refused staked play — so wire the edge
  BEFORE the deny list, or all staked play is refused (the server warns at boot).
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

- **`BLOCKED_COUNTRIES`** (R-COMP-1) holds the legal-reviewed deny list — it is
  intentionally empty above and the server warns while it is. Real-money rake in
  a prohibited jurisdiction is a compliance exposure.
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
