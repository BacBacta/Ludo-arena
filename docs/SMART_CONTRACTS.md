# Smart contracts

## LudoEscrow.sol

Escrow minimaliste pour parties 1v1 misées en stablecoin (cUSD/USDC/USDT sur Celo).

### Cycle de vie

1. Le serveur crée la partie off-chain et fournit un `gameId` (bytes32 unique) + le token + la mise.
2. Chaque joueur appelle `join(gameId, token, stake)` (après `approve`). Le contrat verrouille les deux mises.
3. Fin de partie : l'arbitre (clé serveur) signe `(gameId, winner)` en EIP-712 et n'importe qui peut soumettre `settle(gameId, winner, signature)`. Le contrat paie `pot - rake` au gagnant et le rake au trésor.
4. Si l'adversaire ne rejoint jamais : `refundExpired(gameId)` rembourse après `JOIN_TIMEOUT`.

### Invariants

- Le contrat ne peut JAMAIS payer plus que le pot verrouillé.
- Le rake est plafonné à 10 % (constante, non modifiable sans redéploiement).
- L'arbitre ne peut pas voler les fonds : il ne peut que désigner l'un des deux joueurs comme gagnant.
- Un `gameId` ne peut être réglé qu'une fois.

### Limites connues (v1, acceptées)

- L'arbitre est un point de confiance central (il pourrait désigner le mauvais gagnant). Mitigation : fairness commit-reveal publique + logs signés + réputation. v2 possible : réseau d'arbitres ou preuve de partie.
- Pas de partie 4 joueurs on-chain en v1.

### Déploiement

Foundry. `forge build`, `forge test`, puis `forge script script/Deploy.s.sol --rpc-url $ALFAJORES_RPC --broadcast`.
Adresses par réseau dans `deployments.json` (E3.1).
