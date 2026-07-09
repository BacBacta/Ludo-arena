# Protocole WebSocket

Source de vérité des types : `packages/shared/src/protocol.ts`. Tous les messages sont du JSON `{ t: string, ... }`.

## Client → Serveur

| t | Payload | Description |
|---|---|---|
| `hello` | `{ wallet?, sessionToken?, entropy }` | Première trame. `entropy` = 32 octets hex aléatoires (part client du commit-reveal). `sessionToken` pour reprendre une partie en cours. |
| `queue.join` | `{ stake }` | Rejoint la file (stake en centimes de dollar : 0, 10, 25, 50, 100, 200). |
| `queue.leave` | `{}` | Quitte la file. |
| `game.roll` | `{}` | Demande le lancer (si c'est son tour et phase `awaiting-roll`). |
| `game.move` | `{ token }` | Joue le pion `token` (0 ou 1). |
| `game.rematch` | `{}` | Propose une revanche même mise. |
| `ping` | `{}` | Keepalive (toutes les 20 s). |

## Serveur → Client

| t | Payload | Description |
|---|---|---|
| `hello.ok` | `{ sessionToken, elo, resumed? }` | Session établie. `resumed` contient l'état si une partie était en cours. |
| `queue.ok` | `{ position }` | En file. |
| `match.found` | `{ gameId, seat, opponent: { name, elo, flag }, stakeCents, potCents, fairnessCommit }` | Partie trouvée. `fairnessCommit` = hash du seed serveur, à afficher. |
| `game.state` | `{ state }` | État complet (resync, début de partie). `state` = `GameState` du moteur. |
| `game.dice` | `{ value, index, seat }` | Résultat d'un lancer (index = n° du lancer, vérifiable). |
| `game.moved` | `{ seat, token, capture, finished, extraTurn, state }` | Coup appliqué. |
| `game.turn` | `{ seat, deadlineTs }` | À qui de jouer + échéance de l'horloge (auto-move après). |
| `game.over` | `{ winner, reason, payoutCents, rakeCents, eloDelta, fairnessReveal, txHash? }` | Fin. `fairnessReveal` = seed serveur + entropies (vérification). `reason` ∈ `finish` \| `timeout-forfeit` \| `resign`. |
| `error` | `{ code, message }` | Codes : `BAD_STATE`, `NOT_YOUR_TURN`, `ILLEGAL_MOVE`, `LIMIT_REACHED`, `INSUFFICIENT_ESCROW`… |
| `pong` | `{}` | Réponse keepalive. |

## Séquence type (partie misée)

```
C→S hello{entropy}                    S→C hello.ok{sessionToken}
C→S queue.join{stake:25}              S→C queue.ok
                                      S→C match.found{fairnessCommit,...}
   [on-chain] les 2 clients appellent LudoEscrow.join(gameId) avec la mise
                                      S→C game.state / game.turn
C→S game.roll                         S→C game.dice{value:6,index:1}
C→S game.move{token:0}                S→C game.moved{...} / game.turn
   ...                                ...
                                      S→C game.over{winner, fairnessReveal, txHash}
   [on-chain] settle() déjà soumis par l'arbitre → payout instantané
```

## Règles de validation serveur

- Toute intention hors tour / hors phase → `error NOT_YOUR_TURN` / `BAD_STATE`, état renvoyé.
- `game.move` avec un pion non listé dans `legalMoves` → `ILLEGAL_MOVE`.
- Horloge : 15 000 ms par décision en Blitz. À expiration : auto-move (premier coup légal) ; 3 auto-moves consécutifs = forfait (`timeout-forfeit`).
- Taille max d'une trame entrante : 1 Ko. Au-delà : fermeture.
