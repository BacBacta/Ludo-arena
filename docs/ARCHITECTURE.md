# Architecture

## Vue d'ensemble

```
┌─────────────────────────┐         WebSocket          ┌──────────────────────────┐
│  apps/web (Mini App)    │ ◄────────────────────────► │  apps/server             │
│  React + viem           │   intentions / états       │  Node + ws (autoritaire) │
│  - Lobby / Board / End  │                            │  - matchmaking (ELO)     │
│  - mode bot hors-ligne  │                            │  - rooms + timers        │
└───────────┬─────────────┘                            │  - dés commit-reveal     │
            │ signTransaction (mise)                   └───────────┬──────────────┘
            ▼                                                      │ settle(gameId, winner, sig)
┌─────────────────────────┐                            ┌───────────▼──────────────┐
│  MiniPay wallet         │                            │  LudoEscrow.sol (Celo)   │
│  window.ethereum        │──── stake (cUSD) ─────────►│  escrow → payout + rake  │
└─────────────────────────┘                            └──────────────────────────┘

        packages/game-engine (règles pures) est importé par web ET server.
        packages/shared (protocole) est importé par web ET server.
```

## Décisions structurantes

1. **Moteur partagé, serveur autoritaire.** `game-engine` est une bibliothèque pure (zéro dépendance, dé injecté). Le serveur exécute la partie de référence ; le client exécute la même logique en local uniquement pour l'affichage optimiste et le mode bot.
2. **Financier on-chain, gameplay off-chain.** Jouer chaque coup on-chain serait trop lent/cher. Seuls le verrouillage des mises et le règlement sont on-chain. Le serveur détient une clé "arbitre" qui signe le résultat ; le contrat vérifie la signature. Les fonds ne transitent jamais par un compte de l'application.
3. **Aléatoire commit-reveal.** Avant la partie : le serveur publie `commit = keccak256(seedServer)`. Chaque client envoie une entropie aléatoire à la connexion. Dé n°i = `1 + (uint(keccak256(seedServer ‖ entropyA ‖ entropyB ‖ i)) % 6)`. En fin de partie le serveur révèle `seedServer` : chacun peut recalculer tous les dés. Le serveur ne peut pas tricher (commit publié avant de connaître les entropies) ; les clients non plus (ils ne connaissent pas le seed).
4. **Résilience réseau.** Déconnexion ≠ forfait : l'horloge du joueur continue, un coup légal est auto-joué à expiration (15 s/coup en Blitz). Reconnexion par token de session → resynchronisation d'état complet.
5. **Frontend minimal.** Pas de framework CSS, design tokens CSS custom properties, plateau en SVG généré depuis les constantes du moteur (une seule source de vérité géométrique).

## Contraintes MiniPay

- Provider injecté : `window.ethereum` avec `isMiniPay === true`. Toujours proposer un fallback lecture seule hors MiniPay.
- **Transactions legacy uniquement** (pas d'EIP-1559).
- `feeCurrency` supporté : cUSD.
- Stablecoins : cUSD, USDC, USDT (adresses dans `apps/web/src/lib/minipay.ts`).
- Test : mode développeur de l'app MiniPay → "Load test page".
- Réseau : Celo mainnet (42220) / Alfajores testnet (44787).

## Environnements

| Env | Web | Server | Chain |
|---|---|---|---|
| dev | localhost:5173 | ws://localhost:8787 | Alfajores (44787) |
| staging | Vercel/Netlify preview | Fly.io/Railway | Alfajores |
| prod | domaine listé dans MiniPay | Fly.io/Railway + Redis | Celo mainnet |

## Sécurité

- Anti multi-comptes : empreinte device + adresse wallet + graphe de parties répétées (voir BACKLOG E5).
- Rate limiting par IP + wallet sur le matchmaking.
- La clé arbitre vit dans un KMS/secret manager, jamais dans le repo.
- Limites de jeu responsable appliquées CÔTÉ SERVEUR (mise max/jour par wallet).
