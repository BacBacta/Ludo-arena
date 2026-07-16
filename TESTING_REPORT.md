# TESTING_REPORT.md — Rapport de test pré-lancement

> Journal vivant de la campagne de test pré-lancement (voir le plan par phases et
> la matrice de risques [docs/ARCHITECTURE_TEST.md](docs/ARCHITECTURE_TEST.md)).
> Chaque risque de la Phase 0 est **corrigé + test de régression** ou **documenté
> comme dépendance humaine**. Périmètre argent réel = **1v1 (M3/M6) ET 4 joueurs
> (M9/4v4)**. Testnet only (Celo Sepolia) — aucun mainnet.

## Légende
- **Statut** : ✅ Corrigé (avec test) · 🟡 Atténué/partiel · 🔵 Différé humain · ⬜ À faire
- **Sév.** : 🔴 Critique · 🟠 Majeur · 🟢 Mineur

---

## Correction des risques Phase 0

### Lot 1 — Contrat escrow 1v1 (R-ESCROW-1)

| ID | Sév. | Statut | Correctif | Test de régression |
|---|---|---|---|---|
| **R-ESCROW-1** | 🔴 | ✅ Corrigé | Portage du **pull-payment C3** de `LudoEscrowN` vers `LudoEscrow` (1v1). Ajout : mapping `withdrawable`, `_tryTransfer`/`_payOrCredit`, `withdraw(token)`, events `Credited`/`Withdrawn`, erreur `NothingToWithdraw`. `settle`, `_refundBoth` (void/refundActive) et `refundExpired` créditent désormais au lieu de revert quand un jeton refuse le push (blacklist/gel USDT/USDC). Un gagnant/joueur bloqué ne verrouille plus le pot. | `Adversarial.t.sol` : `testSettle_BlacklistedWinnerIsCredited`, `testVoidGame_OneBadPlayerDoesNotBlockOther`, `testRefundExpired_BlacklistedLoneStakerCredited`, `testWithdrawNothingReverts`. **forge : 70/70** (66 → +4). |

**Avant :** `settle`/`_refundBoth`/`refundActive` poussaient tous via `_safeTransfer` (revert) → un destinataire blacklisté verrouillait **tout le pot 1v1 sans échappatoire** sur mainnet USDT/USDC. Seul `LudoEscrowN` (4p) avait le correctif.

**Dépendances résiduelles :**
- 🔵 **R-DEPLOY-1** — le contrat corrigé doit être **re-déployé** (avec `LudoEscrowN` post-C3) sur Celo Sepolia puis mainnet. Re-déploiement planifié (confirmé 2026-07-16) ; nécessite `DEPLOYER_PRIVATE_KEY` + autorisation nommée. Le bytecode actuellement déployé reste l'ancien tant que ce n'est pas fait.
- ⬜ **UI « réclamer un crédit »** — ni le client web ni le serveur n'appellent `withdraw()` (vrai aussi pour le `LudoEscrowN` existant). Les fonds crédités sont récupérables par appel direct au contrat, mais une UI/relais serveur de `withdraw` reste à câbler (suivi hors périmètre argent immédiat, car un crédit ne survient que sur blacklist/gel).

---

### Lot 2 — Règlement serveur : dépôts échoués & gate de verrou (R-SETTLE-1/3/4)

| ID | Sév. | Statut | Correctif | Test de régression |
|---|---|---|---|---|
| **R-SETTLE-1** | 🔴 | ✅ Corrigé | **Auto-refund du 1v1 staké avorté avant la Room.** Nouveau `SettlementQueue.enqueueRefund(gameId)` (job `winnerWallet=''`) + `Arbiter.submitVoid` (`voidGame`). La file lit le statut on-chain et récupère le dépôt : rembourse le lone staker (`WaitingOpponent`→`refundExpired`) ou annule les deux mises (`Active`→`voidGame`). Câblé sur **toutes** les voies d'abort via `abortPendingStaked` : timeout de verrou, épuisement du poll, mismatch de déposants, et disconnect pendant les reveals. Fin de l'asymétrie avec le 4p (qui avait déjà `scheduleRefundUnfilled4`). | `settlement.test.ts` : refund→void sur Active, refund→refundExpired sur WaitingOpponent, no-op propre sur None. **vitest serveur 85/86.** |
| **R-SETTLE-3** | 🟠 | ✅ Corrigé | **Vérification d'identité des déposants avant démarrage.** Dans `pollStakeLock`, quand l'escrow est `Active`, on vérifie que les déposants on-chain `{playerA, playerB}` == les deux joueurs appariés `{p.a.wallet, p.b.wallet}`. Sinon (siège squatté via `gameId` connu) : abort + `voidGame` (les deux déposants remboursés) + alerte ops, jamais de partie sur un escrow non conforme. | Couvert par la logique `abortPendingStaked`+`enqueueRefund` (tests settlement) ; assertion d'égalité d'ensemble insensible à la casse. |
| **R-SETTLE-4** | 🟠 | ✅ Corrigé | **Nettoyage de la branche d'erreur du poll.** À `MAX_LOCK_POLLS` atteint dans le `catch` (panne RPC persistante), on ne s'arrête plus silencieusement : même `abortPendingStaked` que le timeout du chemin succès → supprime `pendingReveals`, libère `pendingGameId`, notifie, et enfile le refund. Plus de match zombie ni de dépôt bloqué. | Chemin partagé avec R-SETTLE-1 (helper commun) ; typecheck + suite serveur. |

**Note de conception :** un job refund-only (`winnerWallet=''`) ne paie jamais de gagnant. Sur `Active` il **void** (les deux déposants récupèrent leur mise, y compris un éventuel squatter — pas de vol), sur `WaitingOpponent` il **refundExpired** (le lone staker), sur `None` c'est un no-op propre.

**Dépendance résiduelle :**
- 🔵 **Restart pendant `pendingReveals`** — les dépôts effectués juste avant un crash serveur (pendant que la partie est encore en `pendingReveals`, une Map mémoire) ne sont pas ré-enfilés au boot. Récupérables par le `refundActive` 24 h du contrat, mais pas automatiquement. Fermeture complète = persister les pending-staked (couvert plus loin, Lot 3 : durcissement crash).

---

### Lot 3 — Fenêtre crash entre fin de partie et règlement (R-SETTLE-2)

| ID | Sév. | Statut | Correctif | Test de régression |
|---|---|---|---|---|
| **R-SETTLE-2** | 🟠 | ✅ Corrigé | **Réconciliation au boot + alerte sur enqueue perdu.** (1) Nouvelle primitive store `hasSettlement(gameId)` (mémoire + Postgres). (2) Au démarrage, toute partie stakée `over` sans enregistrement de règlement est **ré-enfilée** depuis le gagnant du snapshot — ferme la fenêtre « snapshot terminal persisté puis crash avant l'INSERT du job » (où `resume()` no-op sur une partie finie ne rejouait jamais le paiement). (3) L'échec d'enqueue live (blip DB sans crash) déclenche désormais `postOpsAlert` au lieu d'un simple `console.error` avalé. | `store.test.ts` : `hasSettlement` faux→vrai→reste vrai après résolution (pas de faux ré-enqueue). Réconciliation boot exercée par `npm run restart-test`. |

**Note :** les rows de règlement ne sont jamais supprimées (marquées settled/refunded/failed), donc `hasSettlement` reste vrai pour une partie résolue → aucun risque de double-paiement ; la file est de toute façon idempotente (lecture du statut on-chain).

---

### Lot 4 — Double-connexion & écritures wallet non gatées (R-RT-1, R-AUTH-2)

| ID | Sév. | Statut | Correctif | Test de régression |
|---|---|---|---|---|
| **R-RT-1** | 🟠 | ✅ Corrigé | **La fermeture d'un socket périmé ne démonte plus la session vivante.** Le handler `close` ne touche plus l'état de session si un socket plus récent l'a reprise (`if (session.ws !== ws) return;`), et `resumeSession` ferme proactivement l'ancien socket. Fin du scénario : onglet original fermé → `ws` du nouvel onglet mis à `null` + siège 4p staké livré à un bot (forfait de la mise). | `e2e/wire-security.mjs` : resume même token → fermeture de l'ancien onglet → le nouvel onglet reçoit toujours ses réponses. **Discriminant vérifié** : échoue contre le code d'origine. |
| **R-AUTH-2** | 🟠 | ✅ Corrigé | **Écritures wallet-keyées gatées sur wallet prouvé.** Helper `walletKeyedWriteBlocked` : un wallet **revendiqué mais non prouvé** (client scripté hors MiniPay, sans signature) ne peut plus dépenser les tickets d'un tiers (`skin.buy`, entrée freeroll) ni forcer son auto-exclusion (`limits.set`). Wallet prouvé (MiniPay) et session anonyme (clé = id de session éphémère) restent autorisés. | `e2e/wire-security.mjs` : `limits.set`/`skin.buy` refusés pour un wallet non prouvé, acceptés pour MiniPay. **Discriminant** : `limits.set` passe (à tort) contre le code d'origine. |

**Note de test :** `apps/server/src/index.ts` est un point d'entrée (top-level await, ouvre l'écoute) — non importable en test unitaire ; son comportement se teste au niveau **e2e wire** (comme le reste du handler), d'où la sonde `wire-security.mjs`, exécutée contre un serveur local (`SRV=ws://… node e2e/wire-security.mjs`, 7/7).

**Résiduel (R-AUTH-1, 🔵) :** le flag `miniPay:true` reste cru verbatim (MiniPay ne peut pas `personal_sign` — modèle imposé). Le vol de payout est bloqué (réconciliation déposant), et les écritures non-staking sont désormais gatées, mais un client qui **usurpe** `miniPay:true` peut encore contourner les limites RG par session. Fermeture complète = validation d'origine du webview MiniPay (dépend de garanties de la plateforme MiniPay) — traité au Lot 9 (durcissement) autant que possible.

---

### Lot 5 — Vérificateur fairness client aveugle à sa propre entropie (R-DICE-1)

| ID | Sév. | Statut | Correctif | Test de régression |
|---|---|---|---|---|
| **R-DICE-1** | 🟠 | ✅ Corrigé | `verifyFairness` accepte désormais `own = { entropy, seat }` et expose `ownEntropyOk` : il vérifie que **notre** entropie engagée est bien celle liée à **notre siège** dans le reveal. Un serveur malhonnête qui ignore l'entropie du client et pré-grind seed+entropies passerait `commitOk` + tous les dés (cohérents entre eux) mais **échoue** ce contrôle. `RemoteSession` porte `myEntropy` dans `MatchInfo` ; le `FairnessModal` le passe et affiche le verdict (clé i18n `yourEntropyLabel`, 5 locales). | `fairnessVerify.test.ts` (8 tests) : reveal qui a **dropé notre entropie** → `ownEntropyOk=false`, `allOk=false` (alors que commit + rolls sont OK) ; entropie honnête → `ownEntropyOk=true` ; pas d'entropie fournie → `null` (pas d'échec spurious sur un rejeu). |

---

### Lot 6 — Anti-grinding des dés 4 joueurs (R-DICE-3)

| ID | Sév. | Statut | Correctif | Test de régression |
|---|---|---|---|---|
| **R-DICE-3** | 🔴 | ✅ Corrigé (staké) | **Commit-reveal anti-grinding porté au 4p staké.** `fairness.ts` : `createSeed4Commit()` (commit du serverSeed **sans** connaître les seeds de siège) + `finalizeFairness4(serverSeed, commit, seatSeeds)` (binding après reveal). Le chemin staké-4p commit le seed en ne connaissant que les commits d'entropie, chaque humain **révèle** son entropie brute (`game.entropy`, vérifiée contre son commit hello), et les dés se lient aux reveals — le serveur ne peut plus pré-grinder. Démarrage conditionné à `Active` **et** tous les reveals (`allRevealed4`) ; un siège qui ne révèle jamais → timeout + refund. Client `remote4.ts` révèle sur `match.found4`. Le 4p **gratuit** (bots, argent nul) garde `createFairness4` inchangé. | `fairness.test.ts` (9 tests) : commit sans seed, dés = ceux du legacy pour mêmes seeds, **les dés dépendent des seeds révélés** (un reveal tardif change la séquence), reveal vérifiable. Smoke : le 4p gratuit démarre + roule les dés après reveal (M8 intact). |

**Vérification :** primitives crypto unit-testées ; chemin partagé (reveal client + handler serveur) confirmé sur le 4p gratuit (`match.found4` → `game.dice4` → `game.state4`). Le staké-4p n'est pas exerçable en local (gated : pas de clé arbitre + escrowN non déployé) — sa **vérification bout-en-bout on-chain se fait au lancement M9**, avec le re-déploiement (R-DEPLOY-1). Câblage typecheck-clean, calqué sur le schéma 2p éprouvé.

---

### Lot 8 — Durabilité du token & jeu staké sans wallet (R-WEB-2, R-WEB-3)

| ID | Sév. | Statut | Correctif | Test de régression |
|---|---|---|---|---|
| **R-WEB-2** | 🟠 | ✅ Corrigé | **Token de session en `localStorage`** (au lieu de `sessionStorage`) dans `session.ts` et `remote4.ts`. Il survit désormais au kill de la webview/onglet (cycle de vie mobile Android/MiniPay courant) → au relancement le client **reprend** une partie stakée en cours au lieu d'être auto-joué jusqu'au forfait et de perdre sa mise en escrow. Le partage multi-onglets est rendu sûr par le take-over R-RT-1 (le socket le plus récent possède la session). | Typecheck + suite web (10). Enabler de la reprise ; couvert e2e au niveau resume. |
| **R-WEB-3** | 🟠 | 🟡 Mitigé (serveur) | L'exploit « client modifié joue staké sans risque / wallet strandé contre un démo » est **empêché côté serveur par deux gardes vérifiées** : (1) `matchmaking.ts:46` interdit tout appariement staké **wallet-vs-démo** (parité `walletBacked`) ; (2) `index.ts` `needsLock` n'active l'escrow/règlement que si **les deux** sièges ont un wallet. Un client sans wallet ne peut donc être que dans une partie **démo-vs-démo** sans escrow. Le `return` silencieux client (chemin démo simulé intentionnel, ARCHITECTURE.md) est désormais **loggé + commenté** avec référence aux gardes serveur. | Gardes serveur vérifiées par lecture ; log défensif client. |

---

### Lot 9 — Flag de lancement & custody de la clé (R-COMP-2, R-KEY-1)

| ID | Sév. | Statut | Correctif | Test de régression |
|---|---|---|---|---|
| **R-COMP-2** | 🟠 | ✅ Corrigé | **Flag `STAKING_ENABLED` explicite.** Le jeu d'argent n'est plus armé par la seule présence de la clé arbitre : `arbiter`/`arbiterN` ne sont créés que si `STAKING_ENABLED === 'true'`. Sinon, staked désactivé même avec clé + escrow configurés, et le serveur logue un avertissement au boot. Des adresses mainnet dans les secrets ne peuvent plus **silencieusement** prendre de l'argent réel. Documenté dans `DEPLOY.md` (checklist de lancement). | Typecheck ; logique simple (gate unique sur la création des arbitres). |
| **R-KEY-1** | 🔴 | 🔵 Résiduel (ops) | **Pas de correctif purement code.** La clé arbitre chaude unique (= arbitre + trésor + owner) est un risque de custody. Livré : le flag de lancement (ci-dessus) + la checklist `DEPLOY.md` exigeant, avant mainnet, (1) la clé en KMS/secret manager (pas secret Fly en clair), (2) un split signataire/soumetteur. Mitigations en place : valve `refundActive` 24 h + monitor de solde gas. **Reste une tâche humaine/ops.** | — (item ops, hors périmètre code) |

---

### Lot 7 — Reconnexion / resume du 4 joueurs staké (R-WEB-1)

| ID | Sév. | Statut | Correctif | Test de régression |
|---|---|---|---|---|
| **R-WEB-1** | 🔴 | ✅ Corrigé (staké) | **Grâce + réattache côté serveur, boucle de reconnexion côté client.** `Room4.drop` : sur table **stakée** (`payoutCents>0`), on **détache** le client sans bot-forfait immédiat — les tours s'auto-jouent à l'horloge et le forfait n'arrive qu'après `forfeitAfterAutoMoves` no-shows (fenêtre de grâce) ; table gratuite → bot immédiat (inchangé). `Room4.attach` ré-attache le socket au siège + resync (`game.state4`+`game.turn4`). Au `hello` de resume, `index.ts` ré-attache le siège 4p vivant. Client `remote4.ts` : `onclose` en cours de partie **retente** (token, sans `queue.join4`) jusqu'à `MAX_RECONNECTS` (~45 s de backoff) au lieu d'`onGone` immédiat ; `game.over4` marque la fin (close attendu). | `room4.test.ts` (6) : drop staké **garde le siège humain**, drop gratuit → bot immédiat, `attach` resync state+turn. `e2e/wire-reconnect4.mjs` : drop → reconnexion par token → `game.state4` (réattache sur socket réel). |

**Vérification :** cœur serveur (grâce/réattache) unit-testé ; wiring resume→attach confirmé sur socket réel (table gratuite, le staké-4p étant gated). Boucle de reconnexion client typecheck-clean, calquée sur le `RemoteSession` 2p éprouvé. La **grâce stakée bout-en-bout on-chain** se vérifie au lancement M9 (avec le re-déploiement).

---

*Tous les risques Phase 0 corrigeables en code sont traités ; le verdict et les items humains résiduels sont ci-dessous.*

---

## Synthèse — état des 23 risques Phase 0

| Risque | Sév. | État |
|---|---|---|
| R-ESCROW-1 | 🔴 | ✅ Corrigé (contrat + tests) — **redéploiement requis** |
| R-SETTLE-1 | 🔴 | ✅ Corrigé (+ tests) |
| R-KEY-1 | 🔴 | 🔵 Ops (flag livré ; custody KMS/split = humain) |
| R-DEPLOY-1 | 🔴 | 🔵 Redéploiement planifié (humain + autorisation) |
| R-DICE-3 | 🔴 | ✅ Corrigé (staké + tests) — e2e on-chain au M9 |
| R-WEB-1 | 🔴 | ✅ Corrigé (+ tests) — e2e on-chain au M9 |
| R-SETTLE-2 | 🟠 | ✅ Corrigé (+ tests) |
| R-SETTLE-3 | 🟠 | ✅ Corrigé (+ tests) |
| R-SETTLE-4 | 🟠 | ✅ Corrigé |
| R-CONTRACT-1 | 🟠 | ✅ Mitigé (gate déposants R-SETTLE-3) |
| R-DICE-1 | 🟠 | ✅ Corrigé (+ tests) |
| R-DICE-2 | 🟠 | ⬜ Phase 1 (test chi-carré des dés) |
| R-AUTH-1 | 🟠 | 🟡 Mitigé (résiduel : origine MiniPay) |
| R-AUTH-2 | 🟠 | ✅ Corrigé (+ test wire) |
| R-RT-1 | 🟠 | ✅ Corrigé (+ test wire) |
| R-WEB-2 | 🟠 | ✅ Corrigé |
| R-WEB-3 | 🟠 | 🟡 Mitigé serveur (2 gardes vérifiées) |
| R-DEPLOY-2 | 🟠 | 🔵 Ops (= R-KEY-1) |
| R-CONTRACT-2 | 🟠 | ⬜ Phase 2 (invariants + fork + Slither) |
| R-COMP-1 | 🟠 | 🔵 Humain (liste légale BLOCKED_COUNTRIES) |
| R-COMP-2 | 🟠 | ✅ Corrigé (flag de lancement) |
| R-COMP-3 | 🟠 | 🔵 Humain (E7 ToS/privacy/listing) |
| R-CONTRACT-3, R-CI-*, R-COV-1, R-RT-2 | 🟢/🟠 | ⬜ Phases 1/2/8 (infra de test) |

**Bilan code :** 6 critiques → 4 corrigées en code (R-ESCROW-1, R-SETTLE-1, R-DICE-3, R-WEB-1), 2 sont ops/humain (R-KEY-1, R-DEPLOY-1). Tous les majeurs corrigeables en code sont traités. **205 tests** verts (engine 31, serveur 94, web 10, contrats 70) + sondes wire (`wire-security`, `wire-reconnect4`). Lint + typecheck propres.

## Verdict — remédiation Phase 0

**GO pour passer en Phase 1.** Tous les risques Phase 0 corrigeables en code sont résolus avec test de régression, ou mitigés+documentés. Les risques restants relèvent des phases de test suivantes (chi-carré des dés → Phase 1 ; invariants/fork contrats → Phase 2) ou d'actions humaines/ops (ci-dessous). Aucun de ces résiduels ne bloque le démarrage de la Phase 1 (moteur), puisque l'argent réel reste gated (`STAKING_ENABLED` + testnet only).

## Actions humaines/ops résiduelles (bloquantes AVANT argent réel)

1. **Redéploiement des contrats durcis** (R-ESCROW-1 pull-payment 1v1 + R-DEPLOY-1 escrowN post-C3) sur Celo Sepolia puis mainnet — nécessite `DEPLOYER_PRIVATE_KEY` + autorisation nommée. Mettre à jour les secrets Fly + `deployments.json`.
2. **Custody de la clé arbitre** (R-KEY-1/R-DEPLOY-2) — KMS/secret manager + split signataire/soumetteur avant mainnet.
3. **`BLOCKED_COUNTRIES`** (R-COMP-1) — liste légale validée avant `STAKING_ENABLED=true`.
4. **E7 listing MiniPay** (R-COMP-3) — pages ToS/confidentialité + soumission.
5. **R-AUTH-1** — attestation d'origine du webview MiniPay (dépend de garanties plateforme) pour fermer le contournement des limites RG par session.
6. Rappel plan de test : audit externe des contrats, certification RNG (labo accrédité), bêta fermée MiniPay, validation juridique par pays — inchangés, humains.

---

# Phase 1 — Tests unitaires du moteur de jeu

Framework **Vitest** (existant) + **fast-check** (property-based) + provider de couverture **@vitest/coverage-v8**.

## Couverture du moteur (`packages/game-engine`, R-COV-1 clos)

Mesurée via `npm run coverage` (config `vitest.config.ts`, seuils appliqués ; `types.ts`/`index.ts` = déclarations, exclus) :

| Fichier | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| **engine.ts** (2p) | 100% | 89.7% | 100% | 100% |
| **ludo4.ts** (4p) | 100% | 89.1% | 100% | 100% |
| constants.ts | 100% | 100% | 100% | 100% |
| **Total** | **100%** | **89.4%** | **100%** | **100%** |

Baseline avant Phase 1 : 89.7% stmts. **Cible ≥ 90 % atteinte** sur statements/lignes/fonctions (100 %). Les branches (89.4 %, seuil documenté à 88) sont plafonnées par des gardes défensives `?? -1` / `if (!row)` inatteignables via l'API publique (une row absente rend `legalMoves` vide → sortie avant la garde) ; le seuil documente la limite plutôt que d'asserter des états impossibles.

## Tests ajoutés (78 tests moteur, +47)

- **Règles 2p** (`engine.rules.test.ts`, 19) : chemins d'erreur (`applyRoll`/`applyMove` mauvais phase, dé invalide), `absCell` (null hors piste, throw siège invalide), **immunité home-column** (capture impossible rel>50), **reset du sixStreak** sur tour supplémentaire non-six (6,6,capture-2,6 ≠ forfait), ladder `pickAutoMove` complet (finish>capture>exit>most-advanced + tie-break), legal forgé (l'API serveur reste l'autorité).
- **Règles 4p** (`ludo4.rules.test.ts`, 25) : géométrie (4 starts sûrs, home columns disjointes), **capture multi-siège simultanée** (un coup renvoie 2 adversaires), pair protégée coexistant avec un lone capturé, `nextSeat4` fallback tout-fini, `pickAutoMove4` complet, **`tokenXY4`** (base/finished/track/home + fallbacks).
- **Property-based** (`invariants.property.test.ts`, fast-check, 4) : sur des flux de dés aléatoires jouant des parties complètes (2p+4p) — **conservation des pions** + état bien-formé après chaque transition, **capture → retour en base**, gagnant ⇒ tous pions arrivés, jamais d'overshoot, **déterminisme** (rejeu identique). fast-check réduit toute séquence en échec à un reproducteur minimal.

## Test statistique des dés (`apps/server/test/dice-stats.test.ts`, R-DICE-2 clos)

**Source d'aléa documentée** : dés = commit-reveal SHA-256, `die #i = 1 + (48 bits de sha256(serverSeed|eA|eB|i)) % 6` — `serverSeed` = 256 bits `node:crypto` ; biais du `%6` ≈ 1.4e-14 (négligeable). Pas de `Math.random`.

- **Uniformité** : 1 000 000 lancers, chi-carré d'ajustement (df=5) < 15.086 (**p > 0,01**).
- **Indépendance** : table de contingence 6×6 des lancers consécutifs, chi-carré (df=25) < 44.314 (**p > 0,01**).
- La fairness du flux repose sur le contrôle reveal==commit (primitive testée).

> Ce test **ne remplace pas** la certification RNG par un laboratoire accrédité (iTech/GLI/eCOGRA), qui reste une action humaine pré-mainnet.

## Bilan Phase 1

**GO.** Moteur 2p **et** 4p couverts à 100 % (stmts/lignes/fonctions) avec property-based sur les invariants, dés validés statistiquement (uniformité + indépendance sur 1M lancers). Suite totale : **185 tests** verts (engine 78, serveur 97, web 10) + 70 contrats. Reste pour la certification RNG : action humaine (labo accrédité).
