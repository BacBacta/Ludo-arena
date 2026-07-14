# Environnement de simulation — lacunes trouvées

Environnement adversarial qui **joue tous les modes** (2p/4p, free/stake) et **sonde les contrats** pour faire remonter les lacunes. Reproductible et exécutable en CI.

```bash
npm run sim            # tout : moteur + contrats
npm run sim:engine     # 30 000 parties 2p+4p, invariants + inputs adversariaux
npm run sim:contracts  # suite Foundry (happy-path + adversarial + fuzz)
```

## Couche 1 — Moteur de jeu (`sim/engine.ts`)
30 000 parties (2p + 4p × 3 stratégies) ; après **chaque** transition : invariants structure/portée/legal-set/tour/six-streak/capture/victoire/conservation, + injections adversariales (coup illégal, hors-phase, dé invalide, hors-tour) qui **doivent** être rejetées. Déterminisme vérifié (200 rejeux).

| # | Sévérité | Lacune | Détail |
|---|---|---|---|
| E1 | **Moyen** (défense en profondeur) | `applyRoll4` ne valide pas le dé | Le moteur 4p accepte `die = 0, 7, -1, 2.5` sans lever, alors que le moteur 2p (`applyRoll`) rejette `die<1 \|\| die>6 \|\| non entier`. Un dé hors [1,6] peut produire des états incohérents (recul, arrivée non-exacte). Le serveur doit valider le dé en amont ; le moteur « pur » devrait aussi être robuste. **Correctif : ajouter la même garde qu'en 2p.** |

> Tout le reste tient : 30 000 parties, tous invariants + tous inputs adversariaux OK. (La « multi-capture » 4p — un pion isolé capturé par siège adverse — est **légale**, ce n'était pas un bug.)

## Couche 2 — Contrats (`test/Adversarial.t.sol`, `test/AdversarialN.t.sol`)
Sonde les frictions prédites par l'audit, avec des **jetons hostiles** + fuzz. Les tests **passent** = ils **confirment** le comportement problématique.

| # | Sévérité | Lacune | Preuve |
|---|---|---|---|
| C1 | **Élevé** | **Incompatible avec le vrai USDT** | `testNoReturnToken_JoinBehaviour` : un jeton style USDT (transfer sans valeur de retour) fait **revert `join`** — l'escrow décode un `bool` absent. cUSD/USDC renvoient un bool (OK), mais **le vrai USDT casserait**. → migrer **SafeERC20**. |
| C2 | **Élevé** | **Fee-on-transfer bloque le paiement** | `testFeeToken_SettleStrandsFunds` : l'escrow encaisse < `stake` mais comptabilise `stake` → `settle` **revert (TransferFailed)** → fonds **échoués en Active** jusqu'au `refundActive` 24 h (DoS de paiement). → **allowlist de stablecoins** on-chain. |
| C3 | **Élevé** | **Un siège = DoS de remboursement (4p)** | `testRefundAll_OneBadSeatLocksEveryone` : `_refundAll` transfère à chaque déposant en boucle et **revert au 1ᵉʳ échec** → un seul siège blacklisté/griefeur (adresse bloquée USDC, contrat qui refuse) **bloque les mises des 4 joueurs**. → **claim par siège** (pull) au lieu d'un push atomique. |
| ✔ | — | **Ré-entrance : SÛRE** | `testReentrantToken_NoDoublePay` : un jeton qui ré-entre `settle` est **neutralisé par le CEI** (statut posé avant transfert) — **pas de double paiement**. Bonne nouvelle : la crainte « ré-entrance non testée » est levée. |

**Couverture comblée** (l'audit les disait absents) : gardes constructeur (zero-addr, rake>max), **payloads d'events** `Joined`/`Settled` (le serveur crédite les gains en écoutant ces logs → assertion money-critical), **fuzz** `payout + rake == pot` (256 tirages, contrat vidé sans poussière), atomicité de batch, sur-remplissage de table 4p.

## Couche 3 — Flux misé bout-en-bout (`sim/flow.ts`) — ✅ construite
```bash
npm run sim:flow   # démarre son propre anvil, déploie les VRAIS contrats
```
Démarre une **vraie chaîne locale (anvil)**, déploie les **vrais contrats** (LudoEscrow, LudoEscrowN, jeton USDT-mock) et pilote le **cycle de vie complet du staking** — approve → mise → issue → règlement/refund/void/timeout → paiement → **retrait** — avec le **vrai code Arbiter du serveur** (celui qui signe les règlements en prod). **35 assertions monétaires**, tout tient, fonds conservés (rien perdu/créé/bloqué).

**Cycle de vie & comportements couverts (chaque comportement → chemin on-chain vérifié) :**

| Scénario / comportement | Chemin | Vérifié |
|---|---|---|
| Victoire normale | `settle` → payout au gagnant + rake au trésor + **retrait** hors escrow | ✅ |
| Abandon / rage-quit | serveur nomme l'adversaire → `settle` → l'adversaire encaisse le pot | ✅ |
| Adversaire absent | `refundExpired` (120 s) → remboursement **intégral, sans rake** | ✅ |
| Drop / litige | arbitre `voidGame` → les deux remboursés | ✅ |
| **Clé arbitre perdue** | `refundActive` (24 h) → **sauvetage sans permission** par un tiers | ✅ |
| Double-settle / mauvais gagnant | rejetés (pas de double paiement, non-joueur refusé) | ✅ |
| Double-join même wallet | refusé (`AlreadyJoined`) | ✅ |
| 4 joueurs winner-take-all | `settle` → gagnant prend pot−rake | ✅ |
| 4 joueurs table non remplie | `refundUnfilled` → tous remboursés | ✅ |
| **Comportement en partie (vrai `Room`)** — hors-tour / mauvaise phase | serveur renvoie `NOT_YOUR_TURN` / erreur | ✅ |
| **Partie complète jouée** (bot pilote le vrai serveur) → gagnant → `settle` on-chain | comportement → serveur → chaîne | ✅ |

**Conservation globale** : la masse de jetons est identique avant/après **tous** les scénarios (aucun fonds perdu ni créé).

> Reste une brique optionnelle : brancher la **`SettlementQueue`** durable (Postgres) + simuler un **redémarrage serveur** pour exercer précisément le bug « **règlement 4p non durable** » (audit §d) — `sim/flow.ts` utilise l'Arbiter directement, pas encore la file avec reprise. À faire si tu veux prouver ce bug-là en conditions de crash.
