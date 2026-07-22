# e2e/race — banc de simulation Race Week (argent réel, chaîne locale)

Simule le parcours Race Week COMPLET contre le vrai serveur et les vrais
contrats, sur une chaîne Hardhat locale : SIWE → gas seed → mint RacePass →
claim → matchmaking staké → verrouillage on-chain (approve+join escrow) →
partie complète → settlement on-chain (gagnant payé, rake trésorerie) →
top-up JIT conditionné au solde → rematch → modes d'échec (coupures,
abandons, re-queue).

Chaque bot lie une adresse source loopback distincte (`127.0.0.x`), pour que
le gate anti-collusion same-IP (correct en prod) ne refuse pas l'appairage
du banc mono-hôte. Le comportement prod est inchangé.

## Lancer

```bash
# 1. chaîne locale
cd packages/contracts && npx hardhat node &

# 2. contrats réels (MockUSDT + escrows + RacePass, clé dev hardhat)
NETWORK=localhost npm run deploy -w packages/contracts

# 3. serveur armé (staking + Race Week + JIT + seed), état mémoire
cd apps/server && \
CHAIN=localhost STAKING_ENABLED=true \
ARBITER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
RACE_WEEK_ACTIVE=true RACE_JIT_FUNDING=true \
RACE_FAUCET_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
RACE_QUOTA_CENTS=10 RACE_PER_GAME_CENTS=2 RACE_POOL_CENTS=3000 \
RACE_SEED_CENTS=10 RACE_PRIZE_CENTS=3000 \
SETTLEMENT_RPC=http://127.0.0.1:8545 PORT=8787 npx tsx src/index.ts &

# 4. la campagne (~10-15 min : plusieurs parties complètes + délais de grâce)
node e2e/race/sim-race.mjs
```

Les deux clés privées ci-dessus sont les comptes de dev PUBLICS de hardhat
(mnémonique `test test … junk`) — jamais utilisées ailleurs qu'en local.

## Phases

| Phase | Couvre |
|---|---|
| A | SIWE, seed (+idempotence), mint, claim (+idempotence), prix FIXE sur le wire |
| B | 2 parties stakées complètes : locks on-chain, settlement (gagnant/rake/escrow), JIT conditionné au solde (riche : rien ; drainé : déficit seul) |
| C | Rematch : entropie fraîche, re-pair direct, MÊMES sièges, cycle staké complet |
| D | Coupure mid-staking → replay du contexte (pas d'abort) ; adversaire parti → abort après grâce + re-queue ; re-queue pendant pending → un-wedge |
| E | Déconnexion en pleine partie → resume par token → la partie se termine |

Non simulable ici (spécifique Celo) : la fee abstraction CIP-64 (gas payé en
cUSD) — couverte par la suite unitaire `feePlan`/`escrow` côté client ; sur le
banc, le gas des burners est fourni en ETH hardhat (`hardhat_setBalance`).
