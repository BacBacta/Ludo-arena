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
  ARBITER_PRIVATE_KEY="0x…" \
  CHAIN="celo-sepolia" \
  ESCROW_ADDRESS="0x3fad6b9ecbc3f0c9064603dc762f8ebd6c7864d6" \
  BLOCKED_COUNTRIES=""

flyctl deploy
```

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
