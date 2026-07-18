# ARCHITECTURE_TEST.md — Cartographie de test & matrice de risques (Phase 0)

> Livrable de la **Phase 0** du plan de test pré-lancement. Objet : cartographier
> les composants, tracer le flux d'une partie stakée du matchmaking au paiement du
> gagnant, et produire une matrice de risques classée. Chaque affirmation porte une
> ancre `fichier:ligne`. Les cinq risques les plus sévères ont été **re-vérifiés
> dans le code** (colonne « Vérif »).
>
> Méthode : exploration multi-agents (8 lecteurs, un par sous-système) + vérification
> adversariale manuelle des affirmations critiques. Environnement de référence : repo
> à `main` (commit `0e6c991`), déploiement testnet **Celo Sepolia** (chainId 11142220),
> jetons de test `MockUSDT`/`TestUSD` (aucun mainnet). **Règle absolue respectée :
> aucune interaction mainnet, aucune clé à fonds réels.**

---

## 0. Verdict du point critique n°1 — Où sont générés les dés ?

**Les dés sont générés côté serveur, jamais côté client. Pas de bug critique n°1.**

- Le moteur (`packages/game-engine`) est **pur et déterministe** : aucun `Math.random`,
  aucune I/O ; les dés sont **injectés** en paramètre (`applyRoll(state, die)`,
  `applyRoll4(g, die)`) et validés `1..6` entier ([engine.ts](../packages/game-engine/src/engine.ts), [ludo4.ts](../packages/game-engine/src/ludo4.ts)).
- En partie réelle, le client envoie `game.roll` **sans valeur** ([protocol.ts:330](../packages/shared/src/protocol.ts#L330)) ;
  le serveur tire le dé du seed commit-reveal : [room.ts:206](../apps/server/src/room.ts#L206) (`rollDie`) et [room4.ts:185](../apps/server/src/room4.ts#L185) (`rollDie4`).
- Le client ne génère de dés **que** dans les modes hors-ligne sans argent (`LocalBotSession`
  et `Game4Screen` pratique), toujours construits avec `stake 0`.

**Nuance vérifiée (importante) :** un premier rapport a signalé comme CRITIQUE que « les
parties stakées empruntent le chemin legacy grindable `createFairness` ». **C'est faux.**
[index.ts:1566-1573](../apps/server/src/index.ts#L1566-L1573) **refuse** toute partie
stakée dont les deux clients n'ont pas fourni d'`entropyCommit` — le legacy `createFairness`
([index.ts:1622](../apps/server/src/index.ts#L1622)) n'est atteignable qu'en partie
**gratuite** (`stake 0`). Les parties d'argent passent obligatoirement par le flux
anti-grinding `createSeedCommit` → reveal → `finalizeFairness`. Le risque résiduel réel
est ailleurs (voir **R-DICE-1** : le vérificateur client ne contrôle pas que sa propre
entropie figure dans le reveal).

---

## 1. Cartographie des composants

| Sous-système | Emplacement | Rôle | Autorité |
|---|---|---|---|
| Moteur de jeu (pur) | `packages/game-engine/src/{engine,ludo4,constants,types}.ts` | Règles 1v1 (`engine.ts`) et 4 joueurs (`ludo4.ts`) : légalité, capture, sortie sur 6, fin exacte, triple-6, victoire. Dés injectés. | Aucune (bibliothèque) — décide pour qui l'appelle |
| Protocole partagé | `packages/shared/src/protocol.ts` | Union de messages client↔serveur + `parseClientMsg` (cap 1024 o, token borné 0-3) | Contrat |
| Serveur temps réel | `apps/server/src/index.ts` | Handler `ws` : hello/auth, matchmaking, `startGame`, gating fairness, routage `roll/move/resign` | **Autoritaire** |
| Salle 1v1 | `apps/server/src/room.ts` | Machine à états 1v1 : dé serveur, horloge 15 s, auto-move, forfait, `finish()` | **Autoritaire** |
| Salle 4 joueurs | `apps/server/src/room4.ts` | Sit&Go 4 sièges : bots de remplissage/remplacement, même boucle autoritaire | **Autoritaire** |
| Fairness | `apps/server/src/fairness.ts` | Dés commit-reveal : legacy `createFairness` (gratuit) vs anti-grinding `createSeedCommit`/`finalizeFairness` (staké) ; 4p `createFairness4` | **Autoritaire** |
| Matchmaking | `apps/server/src/matchmaking.ts` | Files par palier de mise, appariement ELO ±100 avec élargissement, anti self-pair | **Autoritaire** |
| Rate limit | `apps/server/src/rateLimit.ts` | Token-bucket par connexion (100/30 s) + comptage violations par IP + ban | **Autoritaire** |
| Règlement 1v1 | `apps/server/src/settlement.ts` | Arbitre EIP-191 + file durable ; réconcilie le gagnant contre les déposants on-chain avant `settle()` | **Autoritaire** |
| Règlement 4p | `apps/server/src/settlement4.ts` | Miroir N-sièges : `settle`/`refundUnfilled`/`voidGame` sur `LudoEscrowN` | **Autoritaire** |
| Persistance | `apps/server/src/store/{index,persistent,redisOnly,memory}.ts` | Postgres (durable : players, games, settlements) + Redis (chaud : sessions, rooms, queues) ; repli mémoire | **Autoritaire** |
| Contrat escrow 1v1 | `packages/contracts/src/LudoEscrow.sol` | Dépôt/verrou/`settle`/`refundExpired`/`voidGame`/`refundActive` ; sig arbitre immuable ; **push atomique** | Backstop anti-forge |
| Contrat escrow N | `packages/contracts/src/LudoEscrowN.sol` | Généralisation 2-4 sièges ; **pull-payment** (`_payOrCredit`/`withdraw`, correctif C3) | Backstop anti-forge |
| Contrat cosmétiques | `packages/contracts/src/CosmeticsStore.sol` | `buy(itemId)` → fonds directs au trésor | — |
| Client web | `apps/web/src/{App.tsx,lib/session.ts,lib/minipay.ts,lib/escrow.ts,state/store.tsx}` | Front thin server-autoritaire ; signe `approve`/`join` via viem ; vérif fairness opt-in | Délégué (affichage optimiste + bots) |

**Topologie de déploiement** : serveur Fly.io + web Vercel + Postgres/Redis ; contrats sur
Celo Sepolia (adresses dans [deployments.json](../packages/contracts/deployments.json),
`stablecoinIsTestUSD: true`, arbitre = trésor = `0x947F…951B`, rake 900 bps).

---

## 2. Flux complet d'une partie stakée 1v1 (matchmaking → paiement)

```
CLIENT A/B                         SERVEUR (autoritaire)                    CHAÎNE (Celo Sepolia)
   │ hello{entropyCommit,wallet,     │                                         │
   │       consent,miniPay?} ───────►│ session + sessionToken (128 bits)       │
   │◄────────── hello.ok{nonce}      │  index.ts:714-836                       │
   │ queue.join{stake} ─────────────►│ stakeBlock (consent/wallet/RG/geo)      │
   │                                 │  index.ts:1442-1468, gates 870-936      │
   │                                 │ Matchmaker.join → paire par ELO         │
   │                                 │  index.ts:919-934                       │
   │                                 │ startGame : EXIGE entropyCommit (staké) │
   │                                 │  index.ts:1566-1573  → createSeedCommit  │
   │◄──── match.found{fairnessCommit}│  index.ts:1596-1603                     │
   │ game.entropy{entropy} ─────────►│ vérifie sha256==commit (index.ts:1134)  │
   │ approve + join(gameId,tok,stake)│                          ──────────────►│ dépôt A/B verrouillé
   │  escrow.ts:97-135               │ pollStakeLock : attend status==Active   │  LudoEscrow.join
   │                                 │  index.ts:1716-1759 ◄───────────────────│  (status → Active)
   │                                 │ finalizeGame → startRoom → room.start() │
   │◄──── game.state / game.turn ────│  index.ts:1704-1701                     │
   │ game.roll (sans valeur) ───────►│ doRoll: die=rollDie(fairness,idx++)     │
   │◄──── game.dice{value} ──────────│  room.ts:203-208                        │
   │ game.move{token} ──────────────►│ applyMove re-valide (engine.ts:101-104) │
   │◄──── game.moved{capture,...}    │  room.ts:240-251                        │
   │              …boucle jusqu'à la victoire / résignation / forfait horloge… │
   │◄──── game.over{winner,payout,   │ finish() : gagnant serveur + snapshot   │
   │        rake,eloDelta,           │  room.ts:307-313                        │
   │        fairnessReveal} ─────────│ onResult → enqueue SettlementJob        │
   │                                 │  index.ts:504-511 (durable, Postgres)   │
   │                                 │ queue : réconcilie winner==déposant     │
   │                                 │  settlement.ts:291-306 ─────────────────►│ settle(gameId,winner,sig)
   │◄──── game.settled{txHash} ──────│  settlement.ts:303-306 ◄────────────────│  payout+rake, EIP-191
```

**Points de vérité serveur (non-forgeables depuis le client)** : dé ([room.ts:206](../apps/server/src/room.ts#L206)),
légalité du coup ([room.ts:148](../apps/server/src/room.ts#L148) + [engine.ts:101-104](../packages/game-engine/src/engine.ts#L101-L104)),
déclaration du gagnant ([room.ts:307](../apps/server/src/room.ts#L307)), montant du payout
(`potCents` serveur), et **réconciliation du wallet gagnant contre les déposants on-chain**
avant tout transfert ([settlement.ts:291-306](../apps/server/src/settlement.ts#L291-L306)).
Le contrat n'accepte que la signature de l'arbitre immuable et n'autorise en gagnant qu'un
déposant ([LudoEscrow.sol:165](../packages/contracts/src/LudoEscrow.sol#L165)).

**Idempotence** : `finish()` ne s'exécute qu'une fois (garde `over`), l'enqueue est un no-op
Postgres `ON CONFLICT DO NOTHING`, `settle()` revert si déjà réglé (machine à états stricte).

**4 joueurs (M9 / 4v4)** : même architecture via `room4.ts`/`settlement4.ts`/`LudoEscrowN`.
**Le 4 joueurs staké fait partie du périmètre argent réel** (confirmé 2026-07-16), au même
titre que le 1v1. Il est aujourd'hui grillé serveur (« coming soon »), donc sans exposition
_actuelle_, mais **doit être testé au même niveau d'exigence que le 1v1** avant dégrillage —
ce qui requalifie plusieurs risques 4p ci-dessous (R-DICE-3, R-WEB-1, R-DEPLOY-1) de
« différés » à **bloquants pré-lancement**.

---

## 3. Matrice de risques

Sévérité : **Critique** = perte/vol/double-paiement de fonds ou résultat forgé ·
**Majeur** = corruption d'état, désync, partie zombie, résultat inéquitable sans vol direct ·
**Mineur** = robustesse/UX. Colonne **Vérif** : `✔` re-vérifié dans le code cette phase ·
`~` partiellement · (vide) rapporté non re-vérifié. Colonne **Phase** : où le test est couvert.

### 3.1 — Fonds & règlement (le plus sensible)

| ID | Sév. | Vérif | Risque | Preuve | Phase |
|---|---|---|---|---|---|
| **R-ESCROW-1** | 🔴 Critique | ✔ | `LudoEscrow` (1v1, **mode staké LIVE**) n'a **jamais reçu** le correctif C3. `settle`/`_refundBoth` poussent via `_safeTransfer` qui **revert** ([LudoEscrow.sol:175-176](../packages/contracts/src/LudoEscrow.sol#L175-L176), [:209-215](../packages/contracts/src/LudoEscrow.sol#L209-L215)) ; aucun `withdraw`. Sur USDT/USDC mainnet (blacklist/gel), **un destinataire bloqué verrouille tout le pot** irrécupérablement. Seul `LudoEscrowN` a `_payOrCredit`/`withdraw`. | grep `withdraw`/`_payOrCredit` : présent uniquement dans `LudoEscrowN.sol:143,264` | 2 |
| **R-SETTLE-1** | 🔴 Critique | ✔ | **1v1 staké avorté avant la Room = dépôt échoué sans refund automatique.** Si A dépose et B non, après `MAX_LOCK_POLLS` le serveur avorte ([index.ts:1739-1750](../apps/server/src/index.ts#L1739-L1750)) **sans enfiler de job** ; la branche refund `WaitingOpponent` de la file ([settlement.ts:310-324](../apps/server/src/settlement.ts#L310-L324)) ne tourne que pour des jobs enfilés. Le 4p a `scheduleRefundUnfilled4` ([index.ts:1994](../apps/server/src/index.ts#L1994)), **le 1v1 n'a pas d'équivalent**. Fonds récupérables **uniquement** via `refundExpired` manuel (aucun caller UI câblé). Idem crash/restart (`pendingReveals` en mémoire). | Comparaison sites d'enqueue : `enqueueRefundUnfilled` (4p) présent, aucun pour 1v1 pré-Room | 2, 5 |
| **R-KEY-1** | 🔴 Critique | ✔ | **Clé arbitre unique et chaude** en variable d'env brute (`ARBITER_PRIVATE_KEY`, [settlement.ts:193](../apps/server/src/settlement.ts#L193)), = **arbitre + trésor + owner** sur le déploiement ([deployments.json](../packages/contracts/deployments.json), owner=treasury [LudoEscrow.sol:77](../packages/contracts/src/LudoEscrow.sol#L77)). Compromission → l'attaquant se fait nommer gagnant de toute partie où il siège, `voidGame` arbitraire, redirige le rake. `ARCHITECTURE.md` revendique un KMS ; en pratique c'est un secret Fly. Split signataire/soumetteur non fait. | `ARCHITECTURE.md:26,54` vs `DEPLOY.md:25-28` | 2, 7 |
| **R-SETTLE-2** | 🟠 Majeur | ✔ | Fenêtre crash entre le snapshot terminal et l'INSERT du job perd le payout. `finish()` persiste `over=true` d'abord ([room.ts:307-313](../apps/server/src/room.ts#L307-L313)), puis enqueue async avec `.catch(console.error)` seul ([index.ts:504-511](../apps/server/src/index.ts#L504-L511)). Crash entre les deux → job perdu à jamais ; au boot la room restaurée est `over` et **ne rejoue pas**. | `.catch` sans postOpsAlert ni retry | 5, 6 |
| **R-SETTLE-3** | 🟠 Majeur | ✔ | Le gate de verrou ne vérifie **que** `status==Active`, jamais que les déposants/la mise correspondent aux joueurs appariés ([index.ts:1729-1737](../apps/server/src/index.ts#L1729-L1737) — `playerA/B` retournés mais **ignorés**). `join()` permissionless : un tiers connaissant le `gameId` remplit le 2ᵉ siège depuis un wallet arbitraire, ou fixe une micro-mise. Mismatch détecté seulement au `settle` → fonds honnêtes gelés 24 h. | `settlement.ts:139-152` retourne A/B non consommés | 2, 4 |
| **R-SETTLE-4** | 🟠 Majeur | ~ | La branche erreur du poll s'épuise silencieusement ([index.ts:1753-1758](../apps/server/src/index.ts#L1753-L1758)) : sur panne RPC, ne nettoie pas `pendingReveals`, ne libère pas `pendingGameId`, ne notifie pas, ne planifie pas de refund → **match zombie + dépôts bloqués**. Contraste avec le timeout du chemin succès qui, lui, nettoie. | vs `index.ts:1739-1750` | 5 |
| **R-CONTRACT-1** | 🟠 Majeur | ✔ | `join()` ne lie aucun joueur attendu : quiconque apprend un `gameId` (observation mempool du 1ᵉʳ join) **squatte un siège** ([LudoEscrow.sol:120-143](../packages/contracts/src/LudoEscrow.sol#L120-L143)). Le join du vrai joueur revert, le gate ne voit jamais les deux wallets attendus, le règlement refuse → stakes gelés jusqu'à 24 h. | `settlement.ts:298-301` ALERT « winner not on-chain player » | 2, 4 |

### 3.2 — Équité des dés

| ID | Sév. | Vérif | Risque | Preuve | Phase |
|---|---|---|---|---|---|
| **R-DICE-1** | 🟠 Majeur | ✔ | Le vérificateur client ne contrôle **jamais** que **sa propre entropie** figure dans le reveal. `verifyFairness` vérifie seulement `commit==sha256(seed)` et recalcule les dés depuis seed+entropies fournis ([fairnessVerify.ts:32-44](../apps/web/src/lib/fairnessVerify.ts#L32-L44)) ; `this.entropy` n'est jamais comparé à `fairnessReveal.entropies` ([session.ts:711-713](../apps/web/src/lib/session.ts#L711-L713)). Un serveur malveillant pourrait ignorer l'entropie engagée du joueur, pré-grinder seed+entropies et passer le contrôle. Sape la promesse « provably fair » en argent réel. | `ui.tsx:790` pas d'accès à l'entropie locale | 1, 3, 7 |
| **R-DICE-2** | 🟠 Majeur | ✔ | **Zéro test statistique des dés** (aucun chi-carré/biais à aucune couche ; les tests n'assertent que le range 1-6 et l'égalité inter-implémentations, [fairness.test.ts:20-25](../apps/server/test/fairness.test.ts#L20-L25)). Aucun test ne drive un reveal d'entropie qui **ne correspond pas** au commit `hello`. | `fairness.ts:54` dérivation non testée en distribution | 1 |
| **R-DICE-3** | 🔴 Critique | ~ | Fairness 4p (`createFairness4`) documentée « verifiable, **not fully grinding-resistant** » ([PROTOCOL.md:43](../docs/PROTOCOL.md#L43)) : le serveur voit les seeds de siège avant de committer. **Le 4p étant dans le périmètre argent réel** (confirmé 2026-07-16), c'est un **bloquant pré-lancement** : un opérateur compromis pourrait biaiser les dés 4p stakés. Nécessite le portage du schéma commit-reveal anti-grinding 2p vers le 4p. | contraste avec le commit 2p `PROTOCOL.md:9` | 1, 4 |

### 3.3 — Identité, sessions & anti-triche

| ID | Sév. | Vérif | Risque | Preuve | Phase |
|---|---|---|---|---|---|
| **R-AUTH-1** | 🟠 Majeur | ✔ | Le flag `miniPay:true` du client est **cru verbatim** sans contrôle d'origine ([index.ts:801](../apps/server/src/index.ts#L801) frais, [:725](../apps/server/src/index.ts#L725) resume) ; `issueWalletNonce` accorde alors `walletProven=true` **sans signature** ([index.ts:1433-1436](../apps/server/src/index.ts#L1433-L1436)). Un client scripté revendique la propriété prouvée de n'importe quel wallet. **Payout non détournable** (réconciliation déposant, [settlement.ts:296](../apps/server/src/settlement.ts#L296)), mais **toutes les limites wallet-keyées** (plafond mise/jour, auto-exclusion, cap collusion, anti-tilt) sont contournables par session. | consommateurs du gate `index.ts:1451-1453`, `1114` | 7 |
| **R-AUTH-2** | 🟠 Majeur | ✔ | Le wallet revendiqué sélectionne la **ligne joueur durable sans preuve** (`playerId=wallet.toLowerCase()`, [store/index.ts:192-194](../apps/server/src/store/index.ts#L192-L194)). Opérations non-staking non gatées : `skin.buy` dépense les tickets freeroll du wallet revendiqué ([index.ts:1153-1176](../apps/server/src/index.ts#L1153-L1176)), `limits.set` force l'auto-exclusion, l'écriture ELO ([index.ts:461](../apps/server/src/index.ts#L461)). Vol/brûlage de tickets d'autrui + griefing. | adresses wallet publiques | 4, 7 |
| **R-RT-1** | 🟠 Majeur | ✔ | **Double-connexion** : `resumeSession` réassigne `existing.ws` **sans fermer l'ancien socket** ([index.ts:1486-1488](../apps/server/src/index.ts#L1486-L1488)). Chaque `close` mute la Session **partagée** (`ws=null`, `alive=false`, `room4.drop`, [index.ts:1312-1328](../apps/server/src/index.ts#L1312-L1328)) : quand l'onglet **original** se ferme, il coupe le socket **vivant** et **livre un siège 4p staké à un bot** qui peut forfaire la mise cUSD verrouillée. | `room4.ts:155-170` drop→handOverToBot | 5 |

### 3.4 — Client web & résilience réseau

| ID | Sév. | Vérif | Risque | Preuve | Phase |
|---|---|---|---|---|---|
| **R-WEB-1** | 🔴 Critique | ~ | **4p staké : aucun reconnect/resume.** `Remote4` déclare « no-resume acceptable pour TICKET games » mais `Game4OnlineScreen` y câble de **vraies mises cUSD** ([remote4.ts:6-9](../apps/web/src/lib/remote4.ts#L6-L9), [Game4OnlineScreen.tsx:112-122](../apps/web/src/screens/Game4OnlineScreen.tsx#L112-L122)). Tout `close` (y compris le force-close heartbeat 25 s, écran éteint) est **terminal** → **perte de la mise de siège**. **Le 4p étant argent réel** (confirmé 2026-07-16), l'hypothèse « TICKET games » du code est fausse pour ce mode : bloquant. Sur mobile 3G/Android bas de gamme (cible MiniPay), un blip réseau = mise perdue. | `remote4.ts:98-102,135-140` | 3, 5 |
| **R-WEB-2** | 🟠 Majeur | ~ | Le `sessionToken` vit en **`sessionStorage`** ([session.ts:318,828-831](../apps/web/src/lib/session.ts#L318)) → ne survit pas à la fermeture d'onglet / au kill de la webview MiniPay backgroundée (cycle de vie mobile courant). Au relaunch, pas de `resumed` → le serveur auto-joue puis **forfait** le siège absent, **mise perdue** malgré le dépôt en escrow. Fenêtre de reconnexion in-tab ~45 s seulement. | `session.ts:686-687,762-764` | 3, 5 |
| **R-WEB-3** | 🟠 Majeur | ~ | `stakeForMatch` **retourne silencieusement** si `walletRef.current` est nul (« no wallet: simulated dev path », [App.tsx:146-147](../apps/web/src/App.tsx#L146-L147)) ; la mise n'est verrouillée qu'**après** `match.found` ([App.tsx:173](../apps/web/src/App.tsx#L173)). Sûreté entièrement dépendante du refus serveur de dealer avant dépôt. Si le serveur dealait jamais avant vérif → client modifié joue staké sans risque. | fenêtre `App.tsx:144-173` | 3, 4, 7 |

### 3.5 — Contrats (assurance)

| ID | Sév. | Vérif | Risque | Preuve | Phase |
|---|---|---|---|---|---|
| **R-DEPLOY-1** | 🔴 Critique | ✔ | Le déploiement Celo Sepolia de `escrowN` (`deployedAt 2026-07-13`) est **antérieur** au correctif C3 (commit `09c6c5d`, **2026-07-15**) : le **bytecode testnet live est pré-durcissement**, et aucun déploiement mainnet n'existe. **Le 4p étant argent réel**, même le testnet actuel tourne sur un escrowN vulnérable au DoS de refund par siège bloqué. Contrats durcis **jamais (re)déployés** — **re-déploiement planifié** (confirmé 2026-07-16, cf. §5). | `deployments.json:28` vs `git 09c6c5d` | 2 |
| **R-DEPLOY-2** | 🟠 Majeur | ✔ | Un **seul EOA chaud = arbitre + trésor + owner** sur le live (`deployments.json:25-26`). Voir R-KEY-1 (même racine de confiance). Une compromission attribue tous les pots in-flight et redirige le rake sans pouvoir supplémentaire. | `LudoEscrow.sol:77` owner=treasury | 2, 7 |
| **R-CONTRACT-2** | 🟠 Majeur | ✔ | **Aucun test invariant ni fork** derrière du code qui détient des fonds. `StdInvariant` jamais utilisé, **un seul** test fuzz (`payout+rake==pot`, [Adversarial.t.sol:188](../packages/contracts/test/Adversarial.t.sol#L188)), **aucun** fork Celo (sémantique réelle cUSD/USDC/USDT : blacklists, 6 décimales, no-return, fee-currency). Jeton testnet = `MockUSDT` open-mint. | `foundry.toml` rpc déclarés mais inutilisés | 2 |
| **R-CONTRACT-3** | 🟢 Mineur | ✔ | C1/C2 (sim/FINDINGS.md) **corrigés en source** (`_safeTransfer` tolérant no-return + allowlist de jetons) mais **statuts stales** (« Élevé » ouvert dans le doc) ; âge du bytecode déployé non vérifié pour ces correctifs. | `LudoEscrow.sol:47-49,100-113` | 2, 8 |

### 3.6 — Infrastructure de test & CI

| ID | Sév. | Vérif | Risque | Preuve | Phase |
|---|---|---|---|---|---|
| **R-CI-1** | 🟠 Majeur | ✔ | **Aucun test money-path ni WebSocket ne tourne en CI.** La CI PR ne fait que vitest in-process + sim 2 000 parties 2p + forge unit ([ci.yml:17-36](../.github/workflows/ci.yml#L17-L36)). Le sim money (`sim/flow.ts`), les sondes stakées Sepolia et les 8 suites e2e wire/UI sont **manuels**. Une régression de la file de règlement, du handshake fairness ou des refunds **ne casse aucun gate** avant déploiement. | vs `e2e/run-all.mjs`, scripts `sim:flow` manuels | 8 |
| **R-CI-2** | 🟠 Majeur | ✔ | La sim CI est **2p-only** (`simulate.ts` : `GAMES=2000`, imports 2p seuls) et 10× plus légère que le harnais complet. Le fuzzer invariant lourd (`sim/engine.ts` : 20 000 parties/mode, 2p **et** 4p, invariants par transition, injections adversariales) **ne tourne jamais en CI**. Un bug de règle 4p du type déjà trouvé (E1 : `applyRoll4` acceptait `die=0/7/2.5`) passerait inaperçu. | `simulate.ts:5-8` | 1, 8 |
| **R-CI-3** | 🟠 Majeur | ✔ | **Assurance contrat mince** pour un escrow porteur de fonds : 66 tests exemples + 1 fuzz, **pas d'invariant, pas de Slither, pas de fork**. | voir R-CONTRACT-2 | 2 |
| **R-CI-4** | 🟠 Majeur | ✔ | **Aucun test de charge/soak/chaos.** Rien ne mesure la concurrence (k6/Artillery absents), la durée (pas de soak), les réseaux dégradés (pas d'injection latence/perte ; Toxiproxy absent). Reconnect/restart couverts seulement par 2 scripts manuels en conditions propres. | grep repo : aucun hit k6/artillery/toxiproxy/chaos/soak | 5, 6 |
| **R-COV-1** | 🟢 Mineur | ✔ | **Couverture moteur non mesurée** : aucun `vitest.config` de couverture, `@vitest/coverage-v8` absent partout. La cible « ≥ 90 % moteur » ne peut pas être évaluée aujourd'hui. | package.json workspaces | 1 |

### 3.7 — Conformité & lancement

| ID | Sév. | Vérif | Risque | Preuve | Phase |
|---|---|---|---|---|---|
| **R-COMP-1** | 🟠 Majeur | ✔ | **`BLOCKED_COUNTRIES` vide en prod** alors que le règlement est activé. Le mécanisme geo-gating (E5.4) existe et est testé, mais la liste déployée est vide ([DEPLOY.md:30](../docs/DEPLOY.md#L30)) — le serveur logue un avertissement explicite. Exposition réglementaire dès le mainnet. | `BACKLOG.md:41` mécanisme fait | 7, 8 |
| **R-COMP-2** | 🟠 Majeur | ~ | **Play staké déjà atteignable en prod**, gaté par `if(!arbiter)` et non par un flag de lancement : la prod Fly a déjà `ARBITER_PRIVATE_KEY` + adresses escrow + `CHAIN`. M3/M6 sont **live** — seulement contre TestUSD Sepolia aujourd'hui. Devient exposition argent réel **au moment où des adresses mainnet atterrissent dans les secrets**, sans interrupteur séparé. | `deployments.json:14-30` Sepolia only | 7, 8 |
| **R-COMP-3** | 🟠 Majeur | ✔ | **E7 (listing MiniPay) ouvert** : E7.1 ToS/confidentialité (pages statiques requises), E7.2 test in-MiniPay, E7.3 soumission — seuls items backlog non cochés. Bloquant distribution. | `BACKLOG.md:51-55` | 8 |
| **R-RT-2** | 🟢 Mineur | ~ | QA-F5 (P3, ouvert) : rematch public occasionnellement non ré-apparié (2 occurrences, jamais reproduit en 17 essais ; dump diagnostic armé). Éjection silencieuse suspectée : `break` sans message en tête du handler `game.rematch`. | `QA-AUDIT-REPORT-2026-07-15.md:58-69` | 4 |

---

## 4. Correspondance risques → phases de test (couverture prévue)

| Phase | Cible | Risques adressés | État actuel |
|---|---|---|---|
| **1** Moteur (unit + property + stats) | ≥ 90 % moteur, fast-check invariants, chi-carré dés | R-DICE-1/2/3, R-CI-2, R-COV-1 | sim 30k solide mais pas de couverture mesurée, pas de fast-check, pas de chi-carré |
| **2** Contrats (fuzz + invariant + Slither + fork) | escrows | R-ESCROW-1, R-SETTLE-1/3, R-KEY-1, R-DEPLOY-1/2, R-CONTRACT-1/2/3, R-CI-3 | 66 tests + 1 fuzz ; **manque invariants/Slither/fork ; correctif C3 absent du 1v1** |
| **3** Intégration & E2E (Playwright mobile + wallet mock) | parcours complets | R-DICE-1, R-WEB-1/2/3 | e2e desktop-only, pas de viewport mobile ni provider `window.ethereum` mocké |
| **4** Simulation bots (10k parties vrais WS) | invariants réseau | R-SETTLE-3, R-AUTH-2, R-CONTRACT-1, R-DICE-3, R-WEB-3, R-RT-2 | sim in-process seulement ; poignée de parties sur vrais WS |
| **5** Concurrence & chaos réseau | race, désync, refunds interruption | R-SETTLE-1/2/4, R-RT-1, R-WEB-1/2, R-CI-4 | 2 scripts reconnect/restart propres ; **aucun chaos/latence** |
| **6** Perf & endurance (k6, soak 24 h) | charge, fuites | R-SETTLE-2, R-CI-4 | **absent** |
| **7** Sécu applicative & anti-triche (OWASP ASVS L2) | auth, sessions, triche | R-DICE-1, R-KEY-1, R-AUTH-1/2, R-WEB-3, R-DEPLOY-2, R-COMP-1 | gates testés en frontière ; **bypass miniPay/ungated writes non testés** |
| **8** CI/CD & rapport | pipeline + GO/NO-GO | R-CI-1/2, R-CONTRACT-3, R-COMP-1/2/3 | CI minimale ; money-path/WS/e2e hors CI |

---

## 5. Décisions actées, hypothèses & questions ouvertes

**Décisions du 2026-07-16 (validation Phase 0) :**

1. **Périmètre argent réel = 1v1 (M3/M6) ET 4 joueurs (M9 / 4v4).** Le 4p n'est **pas**
   différé : il doit être testé au même niveau d'exigence que le 1v1. Conséquence directe —
   trois risques 4p sont **requalifiés à la hausse** dans la matrice :
   - **R-DICE-3** (fairness 4p grindable) : Majeur → **Critique** — porter le commit-reveal
     anti-grinding 2p vers le 4p avant argent réel.
   - **R-WEB-1** (aucun reconnect 4p, mise perdue au blip réseau) : Majeur → **Critique** —
     l'hypothèse « TICKET games » du code est fausse pour ce mode.
   - **R-DEPLOY-1** (escrowN déployé pré-C3) : impact requalifié d'« au dégrillage » à
     **exposition dès aujourd'hui sur le testnet 4p**.
2. **Re-déploiement des contrats durcis : PLANIFIÉ (confirmé).** Doit livrer (a) le
   `LudoEscrow` 1v1 **refactoré en pull-payment** (le correctif C3 n'a jamais été porté au
   1v1 — cf. R-ESCROW-1, encore TODO en source) et (b) `LudoEscrowN` post-C3. **Dépendance
   dure de la Phase 2** : les tests fork/mainnet portent sur le bytecode re-déployé, pas
   l'actuel. → Action tracée : *« porter pull-payment au LudoEscrow 1v1 + re-déployer les
   deux escrows durcis »*.

**Hypothèses & notes :**

3. **R-ESCROW-1 / R-DEPLOY-1 sont mainnet-only en impact** (blacklist/gel absents de
   MockUSDT/TestUSD testnet), mais 1v1 **et** 4p sont les modes stakés visés : les correctifs
   pull-payment (1v1) et le re-déploiement post-C3 (4p) sont des pré-requis mainnet non
   négociables — désormais couverts par la décision 2.
4. **R-SETTLE-1 sévérité.** Classé Critique car il n'y a **aucun** refund automatique 1v1
   pré-Room (asymétrie avec le 4p) et aucun caller UI de `refundExpired` ; les fonds sont
   *récupérables* via appel manuel permissionless après 120 s, donc non « perdus » au sens
   strict — mais à l'échelle, chaque match staké au réseau instable fuit un dépôt échoué
   nécessitant une intervention ops.
5. **Cible de couverture ≥ 90 %** (Phase 1) : non mesurable en l'état (R-COV-1) ; première
   action Phase 1 = ajouter `@vitest/coverage-v8` et un rapport.
6. La CRITIQUE initiale « dés stakés grindables » est **écartée** (§0) ; conservée en trace
   pour éviter qu'un futur relecteur la re-signale.

---

*Fin du livrable Phase 0. Prochaine étape (sur validation) : Phase 1 — tests unitaires du
moteur, property-based (fast-check) et test statistique chi-carré des dés, avec mesure de
couverture ≥ 90 %.*
