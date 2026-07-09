# 🎲 Ludo Arena

**Mini App Ludo pour [MiniPay](https://minipay.to)** — parties Blitz 1v1 de 3-6 minutes, micro-mises en stablecoins sur Celo, dés provably fair, gains payés à la seconde.

> Voir `docs/GAME_DESIGN.md` pour le résumé de la conception produit (rétention, anti-churn, modèle économique).

## Architecture

```
ludo-arena/
├── apps/
│   ├── web/            # Frontend React + Vite + viem (Mini App MiniPay)
│   └── server/         # Serveur de jeu autoritaire (Node + WebSocket)
├── packages/
│   ├── game-engine/    # Moteur de règles Ludo pur, déterministe, testé
│   ├── shared/         # Types & protocole WebSocket partagés
│   └── contracts/      # Smart contracts Solidity (escrow des mises, Celo)
├── docs/               # Architecture, protocole, backlog, contrats
└── AGENTS.md           # Guide pour les agents IA qui travaillent sur ce repo
```

**Principe central :** le serveur est **autoritaire** (les règles s'exécutent dans `game-engine` côté serveur, jamais côté client), le règlement financier est **on-chain** (contrat escrow), et l'aléatoire est **vérifiable** (commit-reveal, voir `docs/PROTOCOL.md`).

## Démarrage rapide

```bash
npm install

# Frontend seul (mode bot hors-ligne inclus — jouable immédiatement)
npm run dev:web        # → http://localhost:5173

# Serveur de jeu (PvP temps réel)
npm run dev:server     # → ws://localhost:8787

# Tests & vérifications
npm test               # tests unitaires (moteur de jeu)
npm run typecheck      # TypeScript strict sur tous les workspaces
npm run simulate       # simulation de 2 000 parties (terminaison, stats)
```

## Publier sur GitHub

```bash
gh repo create ludo-arena --private --source . --push
# ou manuellement :
git remote add origin git@github.com:<toi>/ludo-arena.git
git push -u origin main
```

## Stack

| Couche | Choix | Pourquoi |
|---|---|---|
| Frontend | React 18, Vite, TypeScript strict, CSS design-tokens (pas de framework CSS lourd) | Bundle < 1 Mo exigé par les usages MiniPay (3G, Android entrée de gamme) |
| Wallet | viem + provider injecté MiniPay (`window.ethereum.isMiniPay`) | Recommandation officielle MiniPay ; transactions legacy, feeCurrency cUSD |
| Backend | Node 20+, `ws`, moteur partagé | Léger, messages < 200 octets/coup, reconnexion + auto-move |
| Contrats | Solidity 0.8.x, Foundry | Escrow des mises, règlement signé par l'arbitre, rake configurable |
| Qualité | TypeScript strict, Vitest, ESLint, Prettier, CI GitHub Actions | Standards par défaut du repo |

## Statut

Scaffold complet fonctionnel : moteur testé, serveur PvP, frontend jouable (mode bot), contrat escrow. Le backlog d'implémentation restant (persistance, ELO stocké, tournois, i18n complet, audit contrat…) est dans `docs/BACKLOG.md` — chaque tâche est calibrée pour être confiée à un agent.

## Licence

Propriétaire — © 2026 Mike / SwapPilot. Tous droits réservés.
