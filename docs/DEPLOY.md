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
- `VITE_CHAIN = celo` — committed in `vercel.json` (`build.env`). This points the
  frontend at **mainnet** (chainId 42220), so real cUSD cosmetics + the mainnet
  RacePass go live on the next Vercel build. Flip the server (`CHAIN=celo`) FIRST
  so both target the same chain; a dashboard value overrides the committed one.

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

## 4. Race Week event (onboarding faucet)

The server has an optional **Race Week** mode: a player mints a soulbound
`RacePass` (anti-sybil, 1/wallet → 1/phone), the server verifies that mint, then
funds a micro-stake budget to their wallet so they can play the 1¢ event games
and climb a leaderboard. It's fully **dormant** unless `RACE_WEEK_ACTIVE="true"`
+ a funded faucet key + a deployed RacePass on the active chain. See
[`race.ts`](../apps/server/src/race.ts) and PROTOCOL.md (`race.claim`).

### Funding modes

| | **Lump-sum** (default) | **JIT** (`RACE_JIT_FUNDING="true"`) |
|---|---|---|
| At claim | grants the whole quota (`RACE_QUOTA_CENTS`) | grants ONE stake + gas buffer (`RACE_PER_GAME_CENTS`, default 2¢) |
| Per finished game | — | tops up the next stake, up to the quota, pool-capped |
| Claim-and-run loss | the whole quota | bounded to that first `RACE_PER_GAME_CENTS` |

Lump-sum is fine on **testnet** (fake USDT — a runaway claim is free). Use **JIT
on mainnet** so a wallet that mints, claims, and vanishes without playing keeps
only ~1¢ instead of its whole quota. The pool never funds past `RACE_POOL_CENTS`.

### Testnet arming (current live event, Celo Sepolia)

```bash
# The faucet wallet must hold MockUSDT (for grants) + a little CELO (for gas).
flyctl secrets set -a ludo-arena \
  RACE_WEEK_ACTIVE="true" \
  RACE_FAUCET_PRIVATE_KEY="0x<testnet-faucet-key>" \
  RACE_QUOTA_CENTS="10" \
  RACE_POOL_CENTS="3000" \
  RACE_ENDS_AT="2026-07-27T18:00:00Z"
# CHAIN stays celo-sepolia; RacePass + stablecoin resolve from deployments.json.
```

### Pre-mainnet: fee-abstraction dry run (B1, non-MiniPay launch)

The non-MiniPay onboarding (burner wallet, `RACE_SEED_CENTS`, `RACE_FEE_IN_STABLE`
/ `FEE_IN_STABLE`) rests on one Celo-only fact: a wallet with ZERO native CELO can
transact by paying gas in a registered fee currency (cUSD/USDm/USDC/USDT) via a
CIP-64 tx. That's the one bit only a real Celo node can prove. Validate it FIRST:

```bash
# 1. print a fresh burner to fund
npx tsx packages/contracts/script/feeCurrencyDryRun.ts
# 2. fund that address with the fee TOKEN only (no CELO), then:
BURNER_KEY=0x… npx tsx packages/contracts/script/feeCurrencyDryRun.ts
```

It sends a real tx with `feeCurrency` set and asserts native CELO is unchanged
(gas came from the token). Defaults to Celo Sepolia + USDm; override `RPC` /
`CHAIN_ID` / `FEE_CURRENCY` for mainnet cUSD. Green here = B1 is viable.

### Mainnet arming (real cUSD — JIT ON)

Race Week games are STAKED, so this is real-money staking — the escrow settles in
real cUSD. That means the R-COMP-2 launch gates above (`STAKING_ENABLED`, the
legal-reviewed `STAKING_ALLOWED_COUNTRIES` allowlist, geo edge) apply here too,
not just to the normal stake tiers. Do NOT arm this until that sign-off is done.

Prereqs:
- Contracts deployed on Celo mainnet: `NETWORK=celo DEPLOYER_PRIVATE_KEY=0x… npm run deploy -w packages/contracts`, then commit the regenerated `deployments.json` (both copies). By default arbiter = treasury = deployer; override with `ARBITER_ADDRESS=0x… TREASURY_ADDRESS=0x…` to split the roles (recommended — treasury → multisig).
- **If treasury ≠ deployer**, the escrow's `owner` is the treasury (constructor sets `owner = treasury`), so the deploy CANNOT allowlist the stablecoin itself — it skips `setTokenAllowed` / `setTierRakeBps` with a loud warning printing the exact calls. The **treasury** must then call `setTokenAllowed(cUSD, true)` on BOTH LudoEscrow and LudoEscrowN (fund it with CELO for gas). Until it does, every staked `join()` reverts `TokenNotAllowed` — no staked game can start. The RacePass owner stays the deployer, so `setMintOpen(true)` is a deployer call.
- The deploy records `racePass` **and** the real cUSD `stablecoin` in `deployments.json`, so neither `RACE_PASS_ADDRESS` nor `RACE_STABLECOIN_ADDRESS` is needed as a secret — the server resolves both from the baked file.
- A DEDICATED faucet wallet (NOT the deployer) holding the $30 race pool in cUSD **+ CELO for gas** (it pays its own transfer gas). Arm the Pass mint AFTER the server secrets are live (the server watches `Minted` to unlock the quota) — the RacePass owner (deployer) runs:
  ```bash
  NETWORK=celo OPEN=true DEPLOYER_PRIVATE_KEY=0x<deployer> npm run set-mint-open -w packages/contracts
  ```
  The script refuses to run unless the caller is the on-chain owner, is idempotent (no-op if already open), and reads the RacePass address from `deployments.json`. Close the window at event end with `OPEN=false`.
- The deployer/arbiter wallet also needs ongoing CELO (it signs every settlement).

```bash
flyctl secrets set -a ludo-arena \
  CHAIN="celo" \
  STAKING_ENABLED="true" \                       # only after R-COMP-2 sign-off
  ARBITER_PRIVATE_KEY="0x<deployer/arbiter key>" \
  RACE_WEEK_ACTIVE="true" \
  RACE_JIT_FUNDING="true" \
  RACE_FAUCET_PRIVATE_KEY="0x<dedicated faucet key>" \
  RACE_QUOTA_CENTS="10" \
  RACE_PER_GAME_CENTS="2" \
  RACE_POOL_CENTS="3000" \
  RACE_SEED_CENTS="1" \                          # B1: gas seed before the burner's first mint
  RACE_FEE_IN_STABLE="true" \                    # B1: faucet pays its own gas in cUSD
  RACE_ENDS_AT="<ISO end time>"
# Escrow addresses resolve from the baked deployments.json — make sure no stale
# ESCROW_ADDRESS / ESCROW_N_ADDRESS override secret shadows the mainnet ones.
```

`CHAIN="celo"` is also committed to `fly.toml`, so a plain `flyctl deploy` (or a
push to `main`) already targets mainnet; the secret above just makes it explicit
and wins over the file. The `STAKING_ENABLED`, `ARBITER_PRIVATE_KEY` and
`RACE_FAUCET_PRIVATE_KEY` values are real key material / the real-money switch —
set them here, never in the repo.

> One Fly app = one `CHAIN`. Switching to `celo` ENDS the testnet event and starts
> the mainnet one on the same server — they can't run simultaneously.

#### No terminal? Arm from the Actions tab (`fly-ops` → `arm-mainnet`)

For a web/no-CLI operator, the `arm-mainnet` op in `.github/workflows/fly-ops.yml`
does the whole `flyctl secrets import` above in one click (single atomic restart):

1. **Add two repo secrets** (Settings → Secrets and variables → Actions): `ARBITER_PRIVATE_KEY`, `RACE_FAUCET_PRIVATE_KEY`. The workflow reads them from `secrets.*`, so the keys never appear in inputs or logs (GitHub masks the values). `FLY_API_TOKEN` must already exist (the deploy workflow uses it).
2. **Run the workflow**: Actions → `fly-ops` → Run workflow → operation `arm-mainnet`, type `ARM-MAINNET` in `confirm`. Leave `enable_staking` **off** for a free-play-only mainnet launch; set it **true** only after R-COMP-2 sign-off (it sets `STAKING_ENABLED=true`). Optionally fill `race_ends_at` (ISO) and `staking_allowed_countries` (R-COMP-1 CSV).
3. It sets `CHAIN=celo` + the Race Week faucet/JIT secrets and restarts the machine. Run it **in lockstep with merging the frontend switch** (`vercel.json` `VITE_CHAIN=celo`) so client + server target the same chain.

This does NOT bypass R-COMP-2: staked play arms only when you explicitly choose `enable_staking=true`, which is your sign-off decision to make.

- `RACE_QUOTA_CENTS` = max a single wallet can ever draw (10 = ten 1¢ games).
- `RACE_POOL_CENTS` = total budget ($30 = 3000). Grants stop when the pool is dry.
- `RACE_PER_GAME_CENTS` = drip size (1¢ stake + 1¢ gas buffer). Never exceeds the
  quota remainder or the pool remainder.
- The **prize pool** (the separate $30 paid out to the leaderboard top 10) is
  manual/off-chain — it is NOT this faucet. Keep it in its own wallet.

### Disarming

```bash
flyctl secrets unset RACE_WEEK_ACTIVE -a ludo-arena   # restarts; race.claim goes dormant
```

The KV counters (`race:pool:spent`, `race:funded:<wallet>`, `race:grant:<wallet>`,
the board) persist in Redis — re-arming resumes from where it left off. To run a
FRESH event, clear those keys first (or use a new pool cap).

## Stablecoin migration (cUSD → USD₮)

The stake token is **not** hard-coded — the server + client resolve it from
`deployments.json` (and env overrides). Migrating from cUSD (18 dec) to native
USD₮ (6 dec) is a config + owner-call cutover, no contract redeploy.

**The key subtlety — staking token ≠ gas token.** Celo prices gas in 18 decimals,
so a 6-dec token like USD₮ cannot be a `feeCurrency` directly; you use its 18-dec
**fee-currency adapter**. cUSD is 18-dec, so it is its own fee currency (why the
two were the same address until now). The code now separates them:

- **stake token** = `RACE_STABLECOIN_ADDRESS` ?? `deployments.stablecoin` (raw ERC-20; approve/join/balances)
- **gas feeCurrency** = `FEE_CURRENCY` ?? `deployments.feeCurrencyAdapter` ?? stake token (adapter for USD₮)

Verified Celo **mainnet** addresses (via `FeeCurrencyDirectory.getCurrencies()`,
fly-ops `probe-feecurrencies`):

| role | address | dec |
| --- | --- | --- |
| USD₮ stake token | `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` | 6 |
| USD₮ gas adapter (`feeCurrency`) | `0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72` | 18 |

Directory rate for the adapter == cUSD's (0.06914), so the CIP-64 fee-cap logic
(`baseFloorInFeeCurrency`) needs no change.

### Cutover order (do NOT reorder — each step guards the next)

0. **Confirm Race Week is finished** (leaderboard sanitized + cUSD prize paid).
   Migrating mid-event strands the cUSD pool/faucet and changes decimals under a
   live board.
1. **Whitelist the token** on both escrows (additive; cUSD still works):
   `fly-ops → allow-token`, `token_address = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`.
2. **Fund the wallets in USD₮** (operator — no key on the server side): send USD₮
   to the **faucet** and the **house-bot** wallet. They pay gas via the adapter,
   so they hold only USD₮ — no CELO needed. Size the faucet for the pool; the bot
   for ~a few $ of 1¢ stakes + gas.
3. **Flip `deployments.json[celo]`** (both `packages/contracts/` and the vendored
   `apps/web/src/` copy): `stablecoin → 0x48065fbB…`, `stablecoinDecimals → 6`,
   add `"feeCurrencyAdapter": "0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72"`.
   Commit → merge → server (Fly) + client (Vercel) redeploy together.
4. **Seed the 1¢ tier rake** for the new (token, stake) key (else it falls back to
   900 bps): `fly-ops → set-tier-rake` (reads the now-USD₮ token from deployments).
5. **Cosmetics** (only if you also sell cosmetics in USD₮): the CosmeticsStore
   holds its own `token` + prices; run the store re-point + 6-dec re-seed
   (`switchStablecoin` mainnet path) or cUSD cosmetic buys will fail "could not
   verify". Staking works without this step.
6. **Verify**: `wallet-status` (faucet + bot hold USD₮), `probe-lock` (bot joins
   mine on the USD₮ token), a real 1¢ Race match locks + settles.

Env alternative to editing `deployments.json`: set the Fly secrets
`RACE_STABLECOIN_ADDRESS=0x48065fbB…` + `FEE_CURRENCY=0x0E2A3e05…` (client still
needs the `deployments.json` flip to show/stake USD₮).
