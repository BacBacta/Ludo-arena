# Guide agents — Ludo Arena

Ce fichier est la source de vérité pour tout agent (Claude Code, Copilot, Cursor…) travaillant sur ce repo.

## Commandes

```bash
npm install                 # racine, installe tous les workspaces
npm run typecheck           # OBLIGATOIRE avant tout commit
npm test                    # tests moteur (vitest)
npm run simulate            # sanity-check : 2 000 parties doivent terminer
npm run dev:web             # frontend http://localhost:5173
npm run dev:server          # serveur ws://localhost:8787
```

## Règles d'or (non négociables)

1. **Le moteur (`packages/game-engine`) est pur et déterministe.** Aucun `Math.random`, aucun I/O, aucune dépendance runtime. Le dé est toujours injecté. Toute modification des règles DOIT passer par ce package et être couverte par un test + la simulation.
2. **Le serveur est autoritaire.** Le client n'envoie que des intentions (`roll`, `move`). Ne jamais faire confiance à un état envoyé par le client.
3. **Aucune logique d'argent côté client.** Les soldes affichés viennent du wallet (viem) ou du serveur. Le règlement réel passe par `packages/contracts`.
4. **Budget bundle frontend : 300 Ko gzippé max.** Pas de nouvelle dépendance UI sans justification écrite dans la PR. Pas de framework CSS. Les images sont des SVG inline.
5. **Contraintes MiniPay** (docs/ARCHITECTURE.md §MiniPay) : transactions legacy uniquement (pas d'EIP-1559), `feeCurrency` cUSD, stablecoins cUSD/USDC/USDT uniquement, détection via `window.ethereum?.isMiniPay`.
6. **TypeScript strict partout.** `any` interdit sauf commentaire `// justified-any:`.
7. **Messages WebSocket** : toute évolution du protocole se fait dans `packages/shared/src/protocol.ts` d'abord, puis serveur, puis client — jamais l'inverse.
8. **Jeu responsable** : ne jamais implémenter de fonctionnalité qui contourne les limites de mise, le cashback de protection ou l'auto-exclusion.

## Style

- Prettier + ESLint (configs racine). Noms de fichiers `camelCase.ts`, composants React `PascalCase.tsx`.
- Commits : Conventional Commits (`feat(web): …`, `fix(engine): …`, `chore(ci): …`).
- Une PR = une tâche du backlog (`docs/BACKLOG.md`), avec critères d'acceptation cochés.

## Definition of Done

- `npm run typecheck` et `npm test` passent.
- Si le moteur est touché : `npm run simulate` passe (0 partie non terminée).
- Si le protocole est touché : `docs/PROTOCOL.md` mis à jour.
- Pas de secret ni de clé privée committé (`.env` seulement, `.env.example` à jour).

## Carte du code

| Où | Quoi |
|---|---|
| `packages/game-engine/src/engine.ts` | Toutes les règles du jeu (coups légaux, captures, victoire) |
| `packages/game-engine/src/constants.ts` | Géométrie du plateau (piste 52 cases, cases sûres, colonnes maison) |
| `packages/shared/src/protocol.ts` | Contrat de messages client ↔ serveur |
| `apps/server/src/room.ts` | Cycle de vie d'une partie (timers, auto-move, déconnexions) |
| `apps/server/src/fairness.ts` | Dés commit-reveal (seed serveur + entropies joueurs) |
| `apps/web/src/state/store.tsx` | État global frontend (reducer unique) |
| `apps/web/src/lib/bot.ts` | IA locale (mode hors-ligne / entraînement) |
| `apps/web/src/lib/minipay.ts` | Intégration wallet MiniPay via viem |
| `packages/contracts/src/LudoEscrow.sol` | Escrow des mises + règlement signé |

## Backlog

Les tâches à implémenter sont dans `docs/BACKLOG.md`, ordonnées par priorité, avec critères d'acceptation. Prends la première tâche non cochée de l'épic en cours, sauf instruction contraire.
