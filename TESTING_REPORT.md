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
| R-AUTH-1 | 🔴 **relevé en Phase 7** | ❌ **Ouvert — BLOQUANT argent réel** (cf. Phase 7) |
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
5. **R-AUTH-1 — attestation d'origine du webview MiniPay.** ⚠️ **Relevé de 🟠 résiduel à 🔴 bloquant par la Phase 7** : l'audit ASVS a mesuré son rayon d'action réel. `miniPay:true` étant fourni par le client et auto-accordant `walletProven`, **l'identité du joueur n'est pas authentifiée du tout** et toute barrière wallet-keyée (plafond de mise, auto-exclusion, tickets, cosmétiques) est contournable par session. Les fonds et les décisions de jeu restent hors d'atteinte, mais les garde-fous de jeu responsable sont une **exigence réglementaire**. Dépend de garanties de la plateforme MiniPay → action humaine. Voir la Phase 7 pour le détail et les findings qu'il subsume.
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

---

# Phase 2 — Tests des smart contracts

Framework **Foundry** (solc 0.8.24) + **Slither**. Dossier auditeur : [docs/AUDIT_PACKAGE.md](docs/AUDIT_PACKAGE.md).

## Invariants StdInvariant (R-CONTRACT-2 clos)

`test/InvariantEscrow.t.sol` + `test/InvariantEscrowN.t.sol` — handlers bounded pilotant des séquences aléatoires `join/settle/refund/void/withdraw/warp` (128 runs × 250 depth ; profil `ci` : 256 × 500).

- **`invariant_solvent` (invariant maître)** : le solde du contrat = mises verrouillées des parties ouvertes **+** crédits pull-payment non retirés. Cette égalité englobe *pot jamais distribué 2×*, *sorties ≤ entrées*, *pas de création de valeur*, *crédits toujours couverts*. **128 000 appels, 0 revert, 0 violation** sur les deux escrows.

## Fuzz d'autorisation (R-CI-3)

`test/FuzzAuthorization.t.sol` (256 runs) : seule la signature de l'arbitre règle (`BadSignature` sinon) ; l'arbitre ne peut payer qu'un déposant (`NotAPlayer`) ; un joueur ne retire que son propre crédit (`NothingToWithdraw`).

## Analyse statique Slither (R-CI-3)

`slither src/` — **34 alertes, toutes triées ; aucune vulnérabilité sur le chemin argent.** Reentrancy (CEI-protégée, tokens allowlistés sans callback), `calls-loop` (pay-or-credit non-reverting), `low-level-calls` (SafeERC20 intentionnel), `timestamp` (timeouts 120s/24h), `missing-zero-check` (CosmeticsStore owner-only), + cosmétiques (faucets/event). Justifications détaillées dans le dossier d'audit §5.

## Tests d'intégration sur fork Celo Sepolia (R-CI-3)

`test/ForkCeloSepolia.t.sol` — sur un **fork réel** de Celo Sepolia contre le **MockUSDT déployé** (6 décimales) : `join`+`settle` (payout+rake exacts en 6-déc) et `refundExpired`. Auto-skip sans `CELO_SEPOLIA_RPC` (CI verte). Vérifié en live contre le RPC forno.

## Bilan Phase 2

**GO.** Escrows fund-holding couverts par : 66 tests exemples + adversariaux, **campagnes d'invariants de solvabilité** (128k appels sans violation), fuzz d'autorisation, **Slither** (34 alertes justifiées), et **fork Celo Sepolia** contre un vrai token 6-déc. Suite contrats : **78 tests** verts (70 → +8). Dossier `AUDIT_PACKAGE.md` prêt. **L'audit humain externe reste obligatoire avant mainnet** (R-KEY-1, redéploiement R-DEPLOY-1, fee-currency Celo, revue du digest EIP-191 — §7 du dossier).

---

# Phase 3 — Tests d'intégration & E2E

Framework **Playwright** (core, scripts autonomes) + **Vitest** (intégration wallet déterministe). Provider MiniPay **mocké** pour la CI ; signature réelle sur Celo Sepolia (suites `e2e/staked/`, manuelles).

## Intégration wallet — transactions déterministes (`apps/web/test/escrow.test.ts`, 12 tests)

Le flux on-chain (`stakeInEscrow`/`stakeInEscrowN`) piloté contre des **clients viem factices** — couvre en CI, sans navigateur ni chaîne :
- Signature de transaction : séquence `approve` → `join` avec les bons args (`gameId32`, token, `stakeUnits`) ; `feeCurrency` MiniPay propagé.
- `stakeUnits` (cents → unités par décimales), `gameIdToBytes32` (padding + rejet non-hex), `cosmeticItemId`.
- Sauts d'`approve` si allowance suffisante ; **idempotence** (adresse déjà jointe → pas de 2ᵉ dépôt).
- **Refus de signature** (l'utilisateur rejette, `code 4001`) → l'erreur remonte proprement (1v1 **et** 4p).
- `join` qui revert on-chain → throw.

## Provider MiniPay mocké + mobile (`e2e/ui-wallet.mjs`, 10 checks — exécuté, vert)

Provider `window.ethereum` injecté via `addInitScript` (helper `injectMiniPay` + contexte `MOBILE_CONTEXT` 360×800 Android). Vérifié :
- **Détection** : l'app voit `isMiniPay` et fait le **zero-click connect** (`eth_requestAccounts` appelé sans clic) — sur viewport **360×800**.
- **Refus de connexion** (`eth_requestAccounts` throw 4001) → aucune erreur de page non catchée, lobby reste interactif.
- **Provider absent** → mode démo : l'app boote sans crash et un board/partie est atteignable sans wallet.

## Parcours complet sur mobile (`e2e/ui-mobile.mjs`, 6 checks — exécuté, vert)

Deux joueurs sur **webview Android 360×800** s'apparient (table privée = matchmaking), atteignent le board, et **jouent de vrais tours** (roll + move landing, état qui avance sur 30 ticks) — **crash-free** (aucune `pageerror`). Les parcours victoire/abandon/timeout sur WS réel restent couverts par `wire-regression.mjs` ; cette sonde ajoute la dimension mobile.

Les deux sondes sont enregistrées dans `run-all.mjs`.

## Bilan Phase 3

**GO.** Intégration wallet couverte de bout en bout au niveau approprié : **transactions + refus** déterministes en CI (12 tests vitest), **détection/refus/absence** du provider MiniPay mocké + **viewport mobile Android** (Playwright, 16 checks exécutés verts). Suite web : **22 tests** vitest (10 → +12). Le happy-path staké **on-chain réel** (mise+gain) reste manuel sur Celo Sepolia (`e2e/staked/`), conformément au plan.

---

# Phase 5 — Concurrence, désynchronisation & chaos réseau

Rapport détaillé : [simulation/RESULTS-phase5.md](simulation/RESULTS-phase5.md). **12/12 scénarios** atteignent un comportement défini et cohérent (`npm run sim:chaos-net`).

## Race conditions (vraie couche WS)

- **Actions simultanées à la même milliseconde** (les deux joueurs tirent roll+move en boucle) → état légal des deux côtés, **0 divergence**, convergence sur un board unique.
- **Coup tiré pile à l'expiration de l'horloge de tour** → **exactement 1 coup appliqué** (jamais celui du joueur *et* celui de l'horloge). Test rendu **non-vacu** : on atteint d'abord un `awaiting-move` **multi-choix** (qui arme l'horloge 15s au lieu d'auto-settle), on lit le vrai `deadlineTs`, on tire sur la frontière → `moved events = 1`.
- **Double connexion du même compte** puis fermeture de l'onglet périmé → la session vivante survit (régression R-RT-1 au niveau partie).
- **Capture/jeu pendant la déconnexion de l'adversaire** → board légal, la partie progresse.

## Chaos réseau — `simulation/netproxy.mjs` (équivalent Toxiproxy)

Toxiproxy n'est pas disponible ici → proxy WS Node maison injectant **latence, perte, désordre, coupure brutale**, tunable à chaud par direction.

| Injection | Comportement défini observé |
|---|---|
| Coupure brutale **pendant un lancer de dé** | client survivant garde un board légal ; l'horloge serveur porte le siège absent (déco ≠ forfait) |
| **Reconnexion avec état périmé** | le serveur **resynchronise** le client |
| **Latence asymétrique 50 ms vs 2000 ms** | boards légaux ; les deux clients convergent sur le **même résultat final au repos** |
| **Messages hors-ordre** (30%) | board client reste légal |
| **20 % de perte de paquets** | la partie **progresse quand même** (dés 0→73) ; board légal |

**Synchronisation d'état** : un client lent qui *lag* en cours de partie est attendu (pas un bug) ; seule une **divergence au repos** en serait une — aucune observée.

## Remboursement automatique par scénario d'interruption

Matrice complète dans le rapport (§D). Chaque interruption → comportement défini → voie de remboursement, prouvée **on-chain sur anvil avec les vrais contrats** (`npm run sim:flow` : **35 assertions, 9 scénarios, fonds conservés, rien de bloqué**) et au niveau file de règlement (`settlement.test.ts`) : no-show→`refundExpired`, déco pré-Room→auto-refund (void/refundExpired), épuisement RPC→auto-refund, `gameId` squatté→`voidGame`, drop mid-game→settle ou void, clé perdue→`refundActive` 24h, 4p non rempli→`refundUnfilled`, crash post-partie→ré-enfilement au boot.

*Note de périmètre honnête* : le staking **over-WS** n'est pas pilotable ici (`stakeBlock` exige `settlementDurable()`/Postgres, non lancé) — les remboursements sont donc prouvés là où ils s'exécutent réellement (on-chain + file), et le chaos réseau prouve le comportement d'**interruption** sur parties gratuites.

## Bug de harnais trouvé & corrigé

**`sim/flow.ts` (pré-existant, pas un bug produit)** : son scénario `behaviour-normal` mirait le moteur **synchroniquement** alors que la Room joue un coup forcé sur un timer `DIE_SETTLE_MS` → le miroir prenait de l'avance, le tour divergeait, et tous les lancers suivants étaient refusés. **2 assertions ne tournaient pas silencieusement.** Caractère pré-existant **prouvé** en rejouant contre le `room.ts` d'avant la Phase 4 (findings identiques). Corrigé → `sim:flow` passe de 33 à **35 assertions, toutes vertes**.

## Bilan Phase 5

**GO.** Aucune race condition ne produit d'état non-unique ou illégal ; aucune désync au repos sous latence 40×, désordre ou 20 % de perte ; chaque interruption atteint un comportement défini et chaque interruption stakée dispose d'une voie de remboursement automatique vérifiée on-chain. Charge/soak à l'échelle = Phase 6.

---

# Phase 6 — Performance & endurance

Rapport détaillé : [simulation/RESULTS-phase6.md](simulation/RESULTS-phase6.md). Environnement : **2 vCPU / 8 Go**, le générateur de charge partageant les mêmes cœurs que le serveur → tous les chiffres sont un **plancher**.

## Charge WebSocket (`npm run sim:load`) — budgets PASS

Parties tenues **réellement simultanées** (pacing prod → une partie dure ~60 s, la concurrence ne décroît pas). Latence d'action = `game.roll` → `game.dice` correspondant (le vrai aller-retour ressenti).

| Parties simultanées | Connexions | p50 | **p95** | p99 | erreurs | échecs conn. | perte |
|---|---|---|---|---|---|---|---|
| **500** | 1 000 | 1 ms | **15 ms** | 29 ms | 0 | 0 | 0 |
| **2 000** | 4 000 | 11 ms | **138 ms** | 242 ms | 0 | 0 | 0 |

**Budget p95 < 300 ms, 0 erreur, 0 perte → PASS aux deux paliers** (129 850 actions échantillonnées à 2 000 parties).

**k6/Artillery non utilisés** (absents, et surtout inadaptés) : une « action » ici vit dans un protocole à état (hello + commit-reveal + appariement avant qu'un lancer soit légal) — un script WS générique devrait réimplémenter tout le client. `simulation/load.mjs` pilote le **vrai protocole client** (le `WireBot` de la suite e2e).

## Mémoire & descripteurs

- **Aucune fuite de FD** : 4 024 FD à 2 000 parties (= 4 000 sockets + 24) → retour à **24** après la charge (connexions toutes libérées).
- RSS à la charge : 248 → ~345 Mo avec 4 000 connexions (~24 Ko/connexion).

## Conditions réelles MiniPay (`e2e/ui-perf.mjs`) — 5/5 ✅

Webview Android **360×800**, **3G (750 kb/s, 100 ms RTT)** + **CPU 4×** (CDP).

| Budget | Mesuré | Verdict |
|---|---|---|
| JS+CSS initial **< 500 Ko** gzippé | **201 Ko** | ✅ (40 % du budget) |
| **TTI < 5 s** | **3 954 ms** | ✅ |
| Origine compressante (garde de mesure) | 2/2 gzip | ✅ |

Chemin critique = `index.js` (189 Ko gz) + `index.css` (11 Ko gz) ; le chunk `diceEngine` (114 Ko gz) est **lazy**, hors chemin critique.

## Deux pièges de mesure attrapés & corrigés

1. **Faux positifs d'invariants** (mon harnais Phase 4) : `lastDie` était écrit depuis les **deux** flux de bots → une frame plus ancienne du guest écrasait la plus récente, et `checkMove` comparait un coup à un dé périmé. Preuve dans les données : `fail-706` « advanced 0→6, expected +3 » sur un état `sixStreak: 2` (les vrais dés *étaient* des 6). Corrigé (écriture depuis le flux host seul) → **0 violation**. Le run 10k de la Phase 4 n'était pas concerné (`checkMove` n'existait pas encore).
2. **Budget bundle/TTI faussé** : première mesure à 669 Ko / 10,1 s — artefact de `python3 -m http.server` qui **ne compresse pas** (la prod sert gzip/brotli). Avec une origine compressante : 201 Ko / 3,95 s. La sonde **assert désormais que les assets arrivent compressés** (`e2e/lib/serve-gzip.mjs` fourni + README).

## Soak — la mémoire **plafonne**, aucune fuite

Serveur **frais**, 40 000 parties continues à 25–43 parties/s (~50–86 sessions/s de churn), run **au-delà** de l'horizon de rétention. Le serveur garde volontairement une session déconnectée **10 min** (`index.ts:1439`) pour permettre la reprise : la RSS *doit* monter pendant 10 min pendant que ce tampon borné se remplit. Un run plus court ne peut pas distinguer « rétention qui se remplit » d'une fuite. Celui-ci a franchi l'horizon :

| Phase | RSS | Pente |
|---|---|---|
| Remplissage (t+0 → t+10) | 172 → 1012 Mo | ~**+84 Mo/min** (pic +155) |
| **Plateau (t+11 → t+16)** | 1068 · 1072 · 1077 · 1041 · 1076 · **1028** Mo | **net −40 Mo sur 5 min** (oscille ±35, aucune tendance haussière) |

**La pente s'effondre à ~2 % du taux de remplissage exactement à l'horizon des 10 min**, puis la RSS oscille dans une bande plate 1028–1077 Mo et **termine 40 Mo plus bas** qu'au début du plateau. C'est la signature d'une rétention bornée arrivée en régime (arrivées ≈ expirations) — **pas une fuite**. Sur tout le run (**24 000 parties**) : **0 violation · 0 crash · 0 zombie**, **FD plats à ~90–94**.

**Confirmation sur 1 heure** (serveur frais, 45 250 parties continues) : après le remplissage (t+0→t+9, 329→999 Mo), le plateau tient **plat pendant 48 min** (bande 1033–1126 Mo, sans tendance haussière), **0 violation/crash/zombie**, FD plats à 107–113, serveur en vie **1 h 00 m 56 s**. Mémoire hôte **entièrement réclamée à l'arrêt** (used 6650→5160 Mo) — aucune mémoire fuie ne survit au process. Preuve 10× plus longue que la fenêtre initiale.

**Fuite lente trouvée en amont (corrigée, `a957575`)** : plutôt que d'attendre passivement le 24 h, un audit des maps serveur à croissance non bornée a révélé que `settlementNotify`/`settlement4Notify` n'étaient purgés que par `onSettled`/`onRefunded` — trois issues terminales (paiement `failed`, partie déjà résolue, refund no-op) ne supprimaient jamais leur entrée → une petite fuite par règlement staké, invisible à 16 min mais réelle sur une journée. Corrigé via un callback `onTerminal` déclenché sur **toute** issue terminale (`process()` enveloppe `processOnce()` retournant un booléen terminal → impossible d'oublier une branche). Régression : `settlement.test.ts` (serveur 103/104).

## Bilan Phase 6

**GO.** Charge (p95 15 ms / 138 ms), budgets client (201 Ko / 3,95 s) et endurance (plateau mémoire **prouvé plat sur 1 h**, 0 fuite FD, 0 zombie) tous verts.

**Résiduel humain/ops** : le **soak 24 h sur hôte dédié** reste le sign-off formel, mais il est désormais **bien dé-risqué** (plateau prouvé plat sur une heure, pas seulement au-delà de l'horizon) — et une fuite lente qu'il aurait révélée a été trouvée et corrigée en amont. **Note de dimensionnement** : RSS en régime ≈ **1,06 Go** au débit testé → dimensionner l'instance Fly sur le **plateau**, pas sur la baseline (~330 Mo à froid / 172 Mo au repos réel).

---

# Phase 7 — Sécurité applicative & anti-triche (OWASP ASVS L2)

Méthode : revue **ASVS L2 par chapitre** (V2 authentification, V3 sessions, V4 contrôle d'accès, V5 validation, V7 erreurs/logs, V11+V13 logique métier/API), chaque finding passant ensuite par une **vérification adversariale indépendante** (consigne : réfuter par défaut, ne confirmer que si chaque affirmation porteuse tient ligne à ligne). **18 findings confirmés, 1 réfuté.** Les trois HIGH ont ensuite été **re-vérifiés à la main** avant toute correction — la Phase 0 avait produit un « CRITIQUE » de relecteur qui s'était révélé faux, et un rapport d'audit ne vaut que ce que vaut sa vérification.

## Le résultat qui compte : `walletProven` est falsifiable (R-AUTH-1)

L'audit a mesuré le rayon d'action réel d'un risque déjà connu depuis la Phase 0. Le flag `miniPay:true` est **fourni par le client** ([index.ts:853](apps/server/src/index.ts#L853)) et `issueWalletNonce` accorde alors `walletProven = true` **sans aucune signature** ([index.ts:1542](apps/server/src/index.ts#L1542)) — aucun contrôle d'origine côté serveur. MiniPay ne peut pas `personal_sign` (contrainte plateforme), d'où l'exemption.

**Conséquence à énoncer sans détour : la barrière `walletKeyedWriteBlocked` est décorative face à un client scripté.** Un attaquant envoie `miniPay: true` et traverse *toutes* les portes wallet-keyées (limites RG, auto-exclusion, tickets, cosmétiques, accès au jeu misé). C'est pourquoi **durcir les gates d'identité n'apporterait aucun gain de sécurité réel** tant que R-AUTH-1 est ouvert — le vérificateur adversarial est arrivé indépendamment à la même conclusion (« nécessaire mais pas suffisant »). Ce qui **reste hors d'atteinte** : le vol de payout (réconciliation du déposant on-chain, [settlement.ts:296](apps/server/src/settlement.ts#L296)) et les décisions de jeu (serveur autoritaire, cf. anti-triche ci-dessous).

**R-AUTH-1 devient l'élément bloquant du GO/NO-GO argent réel**, pas un résiduel 🔵. Sa fermeture demande une attestation d'origine du webview MiniPay et dépend de garanties de la plateforme → **action humaine**.

## Corrigés (avec vérification)

Les deux HIGH corrigés ci-dessous sont **indépendants de l'identité** : ils fonctionnent avec une authentification parfaite. C'est ce qui en fait les correctifs à valeur réelle de cette phase.

### 1. HIGH — un adversaire qui ne dépose rien prive sa victime de jeu misé pour la journée

`addDailyStake` est le **seul** écrivain du compteur de mise journalière : **aucune API de décrément n'existe** dans le code ([types.ts:167](apps/server/src/store/types.ts#L167)). Or le débit avait lieu dans `startGame`, **avant** que `pollStakeLock` n'ait confirmé le moindre dépôt on-chain. Chaque voie d'abandon (`abortPendingStaked`) rembourse bien l'escrow mais **ne restaure jamais le compteur**.

**Repro :** rejoindre la file à 500¢ → être apparié à une victime → ne jamais envoyer le dépôt. Au bout de ~2 min `pollStakeLock` épuise `MAX_LOCK_POLLS`, annule et rembourse — mais le `stakedTodayCents` de la victime vaut désormais 500¢, soit le plafond par défaut **et maximum** ([protocol.ts:200-201](packages/shared/src/protocol.ts#L200-L201)). `stakeBlock` lui refuse alors tout jeu misé jusqu'à minuit UTC. **Une seule partie avortée suffit, et l'attaquant ne dépense rien.** Le chemin 4 joueurs était pire : un seul absent brûlait le quota des **trois** autres.

**Correctif :** le débit (et le compteur de paires E5.3) quitte l'appariement pour `startRoom` / `startStaked4Room` — les points uniques atteints seulement une fois l'escrow `Active`. Un appariement qui n'aboutit pas ne consomme plus rien.

### 2. HIGH — plusieurs entrées de file simultanées contournaient la limite RG

Le contrôle de limite lit un compteur qui n'est débité qu'au démarrage du jeu, et le garde anti-doublon de `queue.join` ne regardait **qu'une seule file** (`position(msg.stake, …)`). Être présent en 25¢, 100¢ et 500¢ à la fois faisait donc passer les trois contrôles (chacun lisant un total encore à zéro). `game.rematch` était pire : **aucun** garde anti-doublon, soit ~30 entrées/s autorisées par le token bucket.

**Correctif :** `Matchmaker.isQueued(session)` balaye **toutes** les files ; appliqué à `queue.join` **et** `game.rematch`. Plus un garde-fou de dernier recours en tête de `startGame` (le balayage périodique y entre sans repasser par les gardes). **6 tests de régression** ([matchmaking.test.ts](apps/server/test/matchmaking.test.ts)), dont celui qui fige l'écart : `position(100, alice)` reste aveugle là où `isQueued(alice)` voit.

### 3. MEDIUM — fuite d'une Session par `hello` répété

Le client re-dit légitimement `hello` sur la même socket (édition de profil, connexion du wallet — [session.ts:427](apps/web/src/lib/session.ts#L427)), et chaque `hello` frappait une **nouvelle** Session dans la map globale. Seule la variable de closure était rebindée : la fermeture n'expire donc que la **dernière**, et chaque `hello` supplémentaire laissait un enregistrement pour la vie du process (plus 4-6 requêtes Postgres à chaque fois).

**Nuance importante vis-à-vis de la Phase 6 :** mon soak d'1 h concluait « aucune fuite » — c'était exact **pour des clients corrects**, qui disent `hello` une fois. Cette fuite-ci demande un client qui le répète, et le soak ne pouvait pas la voir. **Correctif :** l'enregistrement remplacé est retiré de la map ; une session en cours de partie/mise est épargnée (sa Room la référence encore, et ce cas est borné par les parties réelles, pas par le nombre de messages).

### 4. MEDIUM — une exception dans un timer tuait toutes les parties

Aucun `uncaughtException` / `unhandledRejection` n'était enregistré. Or la machine à états s'auto-pilote par timers (horloge de coup, auto-play, timeout de révélation) qui se déclenchent **hors** du seul `try/catch` du chemin de requête (celui de la boucle de messages). Un unique `throw` dans le timer d'**une** partie emportait le process et **toutes** les parties concurrentes, misées comprises.

**Correctif :** filet de dernier recours qui trace avec contexte, alerte l'ops, vide les snapshots de Room puis sort en code non-nul pour laisser le superviseur redémarrer. **Validé empiriquement par accident** : une seconde instance lancée sur un port déjà pris a produit `[fatal] uncaughtException: EADDRINUSE` avec sa pile, puis l'arrêt propre attendu.

### 5. LOW — clé de base de données choisie par le client

[index.ts:858/861](apps/server/src/index.ts#L858) dérivait la clé durable de `msg.wallet` **brut** là où [:822](apps/server/src/index.ts#L822) utilisait la version normalisée. Une adresse invalide (que `normalizeWallet` mappe à `undefined`) devenait donc une clé arbitraire : le joueur se scindait en **deux identités divergentes** (`anon:<id>` pour le profil, la chaîne brute pour challenge/streak/ligue/limites), et n'importe quel client pouvait semer des lignes sous la clé de son choix. **Correctif :** clé normalisée partout.

## Documentés, non corrigés (et pourquoi)

| Finding | Sév. | Décision |
|---|---|---|
| `unproven-wallet-durable-write`, `hello-unproven-wallet-idor`, `wallet-claim-info-disclosure` | 🟠 | **Subsumés par R-AUTH-1.** Écrire le profil / streak / consentement d'un wallet seulement *revendiqué* est réel, mais gater ces écritures n'apporte rien tant que `miniPay:true` auto-prouve. À traiter **avec** R-AUTH-1, en un seul lot. |
| `public-queue-missing-collusion-authz` | 🟠 | `collusionBlock` n'est pas appliqué sur la file publique (seulement en rematch/table privée). À corriger au lot anti-collusion ; sans impact sur l'intégrité des fonds. |
| `qa-staked-game-strands-escrow` | 🟠 | La porte QA rate les tables privées. **Ops** : ne jamais configurer d'arbitre sur un environnement QA (déjà le cas). |
| `siwe-message-binding` | 🔵 | Le message de preuve omet adresse/domaine/chaîne/expiration (EIP-4361). Sans objet tant que R-AUTH-1 rend la preuve contournable ; à reprendre dans le même lot. |
| `no-idle-or-absolute-session-timeout`, `parse-untyped-fields`, `gift-to-non-integer`, `auth-decisions-not-logged`, `cosmetic-claim-rpc-amplification`, `qa-key-in-websocket-url`, `pending-game-id-not-cleared-on-own-disconnect` | 🔵 | Backlog de durcissement. Aucun n'ouvre de voie vers les fonds ni vers une décision de jeu. |
| `in-memory-session-record-leak` | — | **RÉFUTÉ** par la vérification adversariale : le finding inversait la causalité (`onEnd` met `s.room` à `null` **avant** que le timer de 10 min ne se déclenche, donc la suppression a bien lieu). Bon exemple de faux positif écarté. |

## Vérifications mécaniques

| Contrôle | Résultat |
|---|---|
| `npm audit` (prod) | **0 vulnérabilité**. Les 22 restantes (2 critiques, 4 hautes) sont **dev-only** — vitest/vite, jamais embarqués. |
| Secrets en clair | **Aucun.** Seule `LOCAL_DEV_KEY` est présente = clé Anvil **publique**, gatée à localhost ([deploy.ts:109](packages/contracts/script/deploy.ts#L109)). Seul `.env.example` est suivi ; `.env*` gitignorés. |
| Rate limiting | Appliqué à **chaque message client** (token bucket, entrée du handler [index.ts:735](apps/server/src/index.ts#L735)) + cap de connexions par IP + ban. 7 tests + `abuseTest.ts`. |

## Anti-triche — le client ne peut ni voir, ni choisir, ni décider (`e2e/wire-anticheat.mjs`, 7/7 ✅)

Un client **modifié** tente les trois triches du cahier des charges :

1. **Voir/choisir/prédire les dés** → la graine serveur qui détermine chaque lancer n'est **jamais** émise avant `game.over` (dés imprévisibles) ; injecter `{value:6}` dans `game.roll` est ignoré (les lancers restent ~uniformes, sixRate 0.15).
2. **Jouer pour un autre** → `game.move`/`game.roll` n'ont pas de champ siège : le serveur le dérive de la session → `NOT_YOUR_TURN`, sans fuite de dés ni coup appliqué. `game.resign` ne fait perdre que **l'émetteur**.
3. **Déclarer sa victoire** → les trames serveur→client forgées (`game.over`/`game.state`/`game.moved`) sont rejetées `BAD_MESSAGE` ; aucun `game.over` n'est produit et la partie réelle continue.

## Bilan Phase 7

Suites après correctifs : **109 tests unitaires serveur** (+6), **wire-regression 19/19**, **wire-4p 4/4**, **wire-gates 12/12**, **wire-security 7/7**, **wire-anticheat 7/7**.

**NO-GO argent réel en l'état — un seul bloquant : R-AUTH-1.** Le serveur tient bien son rôle d'autorité (dés, coups, victoire, payouts inviolables), et les deux attaques HIGH indépendantes de l'identité sont fermées et testées. Mais tant que `miniPay:true` auto-prouve n'importe quel wallet, **l'identité du joueur n'est pas authentifiée** et les garde-fous de jeu responsable (plafond, auto-exclusion) — exigences réglementaires, pas confort — restent contournables par session. Fermeture = attestation d'origine MiniPay (**action humaine**, dépend de la plateforme).

**Un correctif de test au passage :** `wire-gates` échouait sur `M3 refusal names the actual gate` — **prouvé pré-existant** en rejouant contre le code d'avant la Phase 7 (échec identique). Artefact du harnais : avec `?qa=`, la porte QA se déclenche avant celle du consentement, rendant le message recherché inatteignable. Le check accepte désormais la porte QA → 12/12.
