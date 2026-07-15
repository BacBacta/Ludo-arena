# Rapport d'audit QA — modes de jeu Ludo Arena (2026-07-15)

Exécution du mandat `docs/QA-GAME-AUDIT-PROMPT.md`. Environnement : serveur
local (`tsx`, état mémoire, settlement désactivé), web buildé
`VITE_SERVER_URL=ws://localhost:8787` servi statiquement, Playwright headless +
clients protocole `ws`. Harnais livré sous `e2e/` (voir `e2e/README.md`),
rejouable en une commande : `node e2e/run-all.mjs`.

## 1. Verdict synthétique

| Mode | Couverture jouée | Verdict |
|---|---|---|
| M1 CTA gratuit hors-ligne | pratique 4p locale démarrée et jouée réseau coupé | ✅ |
| M2 Blitz 1v1 online gratuit | partie complète (`game.over`) + rematch + resign | ✅ |
| M3 Blitz 1v1 staké | frontières (consentement/wallet/commit) ; happy-path on-chain hors périmètre | ✅ frontières |
| M4 Freeroll | refus sans ticket propre, session réutilisable | ✅ frontières |
| M5 Table privée gratuite | partie complète UI + filaire, rematch, reconnexion mi-partie | ✅ |
| M6 Table privée stakée | refus staké propre, création gratuite intacte ensuite | ✅ frontières |
| M7 Pratique 4 joueurs | table jouée sur plusieurs cycles de bots, jamais coincée | ✅ (partiel : pas jusqu'à la victoire) |
| M8 4 joueurs online gratuit | partie complète (`game.over4`, 6,6 min) + UI (rotation, dés, labels) | ✅ |
| M9 4 joueurs staké | grillé serveur (« coming soon ») — refus propre vérifié | ✅ refus (happy-path inexistant) |

**Sondes de régression R1–R21, R23 : toutes automatisées et vertes.**
R22 (1 machine Fly) : vérifié en prod plus tôt ce jour (lecture seule), non
rejoué par le harnais local.

## 2. Défauts trouvés par l'audit

### F1 — P1 CORRIGÉ : « (tap to close) » ne fermait aucune modale
Les cinq modales (Welcome, Settings, Dice, Table4, Fairness) stoppent la
propagation des clics sur la carte ; le hint « (tap to close) » — seul élément
qui *promet* la fermeture — était donc avalé. Pas d'Escape sur mobile.
Scénario réel observé en audit : un invité rejoignant par lien partagé garde la
modale Welcome par-dessus le plateau, se fait auto-jouer toute la partie
(« away »), et le bouton REMATCH est inatteignable (`<div class="modal">
intercepts pointer events`). Preuve contrôle → fix : modale toujours ouverte
après tap → fermée. Correctif : `CloseHint`, un vrai bouton branché sur le
handler de fermeture de chaque modale (`apps/web/src/components/ui.tsx`).

### F2 — P2 OUVERT : ~45 s avant le fallback hors-ligne des flux connectés
`RemoteSession` retente 12 fois (~45 s) avant `onGone`, y compris quand le
socket n'a **jamais** été connecté. Le repli local promis arrive donc après
45 s d'attente (un Cancel existe). Recommandation : échec rapide quand
`navigator.onLine === false` ou après 2 tentatives si aucune connexion n'a
jamais abouti ; garder les 45 s pour les parties en cours (là, c'est correct).

### F3 — INFO : M9 (4p staké) est grillé côté serveur
`queue.join4` staké répond « Staked 4-player tables are coming soon » (gate
environnement : escrow N-places + settlement durable requis). Le refus est
propre et la session reste utilisable. À surveiller : la vitrine lobby
(`staked4Available`) doit rester alignée sur la disponibilité réelle serveur.

### F4 — INFO : « pratique 1v1 bot » n'est pas un mode d'entrée
Décision produit dans `App.startMatch` : le CTA gratuit lance la **pratique 4p
locale**. `LocalBotSession` (bot 1v1) ne subsiste que comme repli des flux
connectés. L'inventaire du prompt d'audit (M1) a été réaligné.

### F5 — À SURVEILLER : rematch public non re-appairé (2 occurrences, sondes durcies)
Deux runs de suite complète ont vu le rematch M2 ne pas démarrer (15 s) ;
17 tentatives dédiées — y compris sous charge serveur (partie 4p simultanée) —
n'ont pas reproduit. Les attentes de la suite utilisaient encore des filtres
timestamp (la classe de faux négatif corrigée partout ailleurs) : elles sont
passées aux index de log, et un dump de diagnostic (trafic post-fin des deux
côtés) s'imprime désormais automatiquement à la prochaine occurrence. Le run
durci passe 19/19. Si un utilisateur signale « la revanche ne part pas », le
dump donnera la réponse ; côté serveur, le seul chemin d'éjection silencieux
est le `break` sans message quand `session.room` n'est pas encore nettoyé
(`index.ts`, tête du handler `game.rematch`) — un `error` explicite là serait
une amélioration défensive (P3).

## 3. Corrections de sondes (bugs du harnais, pas du produit)
Documentées parce qu'elles ont failli masquer ou inventer des défauts :
filtres temporels remplacés par des index de log (une réponse locale arrive
dans la même milliseconde que l'envoi) ; sélection du « joueur au trait » après
réception de l'état d'ouverture ; échantillons de dé comptés seulement si le
clic a atterri ; oracle de rotation 4p par nom réel (l'ancien cherchait un
« You » disparu) ; oracle M8 = progression sous cap (une partie 4p complète est
légitimement longue).

## 4. Partie 4 joueurs complète (M8)
Une partie complète 2 humains + 2 bots a atteint `game.over4` (vainqueur
siège 1) en **6,6 minutes** — 289 lancers cadencés, aucun coup dans la fenêtre
de tumble (min 899 ms), aucun blocage. Les durées varient fortement d'une
partie à l'autre (les captures renvoient les pions en base) : deux autres runs
dépassaient 5–7 min sans conclure ni se coincer. L'oracle du harnais est donc
« le jeu roule encore au cap » (anti-blocage), la complétion étant vérifiée par
le run long (`M8_CAP_MS=1500000`). Aucun défaut de fin de partie 4p observé.

## 4b. Happy-path staké on-chain (vérifié — ajout post-audit)
Sur autorisation, exécuté sur **celo-sepolia** avec TestUSD, escrow déployé
`0x5b2d…`, arbitre/trésor `0x947F…` (rake 900 bps). Deux wallets de test réels
misent 25¢ chacun ; l'arbitre règle avec le **même schéma de signature EIP-191**
que le serveur (`settlementDigest(chainid, escrow, gameId, winner)`). Sonde
`e2e/staked/contract-settle.mjs`, **9/9**, prouvé on-chain :

| Contrôle | Résultat |
|---|---|
| Les deux mises verrouillées, escrow détient le pot | 0,50 TestUSD |
| `settle()` de l'arbitre miné (EIP-191 accepté par le bytecode déployé) | ✅ |
| Escrow libère tout le pot | → 0 |
| Gagnant net = retour − mise | **+0,205** |
| Perdant net = − mise | **−0,25** |
| Trésor net = rake | **+0,045** |
| Conservation : retour 0,455 + rake 0,045 = pot 0,50 | ✅ |

Notes : (1) le contrôle anti-collusion « même réseau » du serveur est **vérifié
actif** — il a refusé d'apparier deux sockets de même IP (`wire-staked.mjs`) ;
(2) le serveur en mode durable (Redis+Postgres) émet bien `settlement enabled`.

### 4c. Émission serveur de `game.settled` (risque 1 — COUVERT)
`e2e/staked/settle-queue.ts` câble le **vrai** `SettlementQueue` + `createArbiter`
+ `MemoryStore` du serveur (via tsx), exactement comme `index.ts` dans `onResult`,
sur une partie `Active` réelle on-chain — sans appariement, donc l'anti-collusion
n'intervient pas. **5/5** : le vrai arbitre soumet `settle()`, la file émet
`game.settled` (callback `onSettled`) avec un txHash **réellement miné**, et le
gagnant est payé **+0,205** par le chemin serveur.

**Résolution d'un doute soulevé pendant l'audit** : une lecture précédente
donnait le statut on-chain à `1` (semblait `Active=1` vs `GameStatus.Active=2`
du serveur → risque de mauvaise classification → refund au lieu de payer). Le
test attend un statut `Active` **stable** avant d'enfiler : il a lu `status=2`.
C'était donc du **retard de lecture forno** (état après un seul join), **pas**
un décalage d'enum. L'enum déployé correspond à la source ; **pas de bug**.

### 4d. Refund-all du 4p staké (risque 2 — COUVERT au niveau contrat)
`e2e/staked/refund-unfilled.mjs` : deux sièges sur quatre rejoignent une table
`LudoEscrowN`, la fenêtre de join expire (120 s), et `refundUnfilled()`
(permissionless) **rembourse chaque déposant intégralement**. **7/7**, net zéro
des deux côtés, escrowN revenu à sa base. C'est l'invariant de sécurité des
fonds du mode : personne ne reste bloqué si la table ne se remplit pas.
L'orchestration serveur (`SettlementQueue4`) est déjà unit-testée ; le reste
(dégriller M9 en prod) est une **décision de lancement**, pas un trou de test.

## 5. Hors périmètre / risques acceptés
- Happy-path staké on-chain (M3/M6) : **vérifié au niveau contrat** (§4b) **et
  au niveau serveur** — l'émission de `game.settled` par la vraie file passe
  bout-en-bout (§4c). L'anti-collusion même-IP est vérifié actif.
- Refund-all M9 : **vérifié au niveau contrat** (§4d) ; le dégrillage serveur du
  mode reste une décision de lancement.
- Refund-all M9 à l'expiration du fill : inaccessible tant que M9 est grillé.
- Multi-onglets : `sessionToken` vit en `sessionStorage` (par onglet) — deux
  onglets = deux sessions indépendantes ; le vol de session exigerait le token
  32-hex aléatoire. Vérifié par lecture de code.
- Thème sombre / reduced-motion / FR : non parcourus systématiquement (P3).

## 6. Recommandations classées
1. (P1, fait) Déployer F1 — la modale bloquante frappe les invités de liens
   partagés, le cœur de l'acquisition WhatsApp.
2. (P2) F2 : échec rapide du premier connect hors-ligne.
3. (P2) Copie d'attente du rematch privé : l'hôte voit « Finding an opponent
   at your level… » alors qu'il attend son ami — trompeur (constaté en audit).
4. (P3) Instrumenter le re-pair du rematch public (F5).
5. (P3) Étendre `run-all` d'un mode « prod lecture seule » périodique
   (sondes filaires gratuites, espacées).
