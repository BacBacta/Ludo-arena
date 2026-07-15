# PROMPT — Audit QA de bout en bout des modes de jeu (Ludo Arena)

> **Usage** : coller ce prompt tel quel dans une session Claude Code ouverte à la racine
> du repo `Ludo-arena`. Il constitue le mandat, le périmètre, la méthode et les
> critères de sortie de l'audit. Le document est auto-porteur : l'auditeur n'a besoin
> d'aucun autre contexte que le repo lui-même.

---

## 1. Mission

Tu es mandaté comme **auditeur QA senior spécialisé jeux temps réel multijoueur**
(profil : ISTQB Advanced Test Analyst + expérience gambling/real-money gaming).
Ta mission : **prouver par des parties réellement jouées** qu'aucun défaut ne peut
bloquer, corrompre ou rendre illisible une partie dans **chacun** des modes de jeu,
et **découvrir les défauts encore inconnus** par une chasse méthodique.

L'application est en production avec de l'argent réel (USDT sur Celo, cible MiniPay).
Le niveau d'exigence est celui d'un produit financier : un joueur qui perd une partie
à cause d'un bug perd de l'argent.

**Livrable final** : un rapport d'audit (§8) + un harnais de régression e2e commité
dans le repo, rejouable en une commande.

## 2. Périmètre — inventaire exhaustif des modes

Vérifie cet inventaire contre le code (`apps/web/src/screens/Lobby.tsx`,
`apps/web/src/App.tsx`) avant de commencer ; si un mode manque ici, ajoute-le au plan.

| # | Mode | Entrée | Adversaires | Argent | Chemins critiques |
|---|------|--------|-------------|--------|-------------------|
| M1 | Pratique 1v1 (bot local) | fallback hors-ligne + lobby | bot client (`LocalBotSession`) | non | roll/move/abandon, mode avion (SW offline) |
| M2 | Blitz 1v1 online gratuit | `onPlay(0)` → matchmaking | humain (file publique) | non | file, match, partie complète, rematch public |
| M3 | Blitz 1v1 staké | `onPlay(25/100/500)` | humain | **oui** (USDT escrow) | wallet SIWE, lock du stake, geo-gating, limites journalières, settlement, refund |
| M4 | Freeroll quotidien | `onFreeroll()` | humain | ticket 🎟️ | débit/remboursement du ticket, prix |
| M5 | Table privée (gratuite) | `onCreateTable(0)` + lien `#/g/CODE` | ami invité | non | création, join par code, rematch privé (jamais la file publique), reconnexion |
| M6 | Table privée stakée | `onCreateTable(25/100/500)` | ami | **oui** | comme M5 + M3 |
| M7 | Pratique 4 joueurs | `onPractice4()` | 3 bots client | non | partie locale complète |
| M8 | 4 joueurs online gratuit | `onPlay4(0)` | humains + bot-fill (12 s) | non | Sit&Go, sièges 0–3, quadrants tournés, forfait → bot |
| M9 | 4 joueurs online staké | `onPlay4(25/100/500)` | 4 humains stakers | **oui** | fill 60 s sinon **refund all**, lock ×4, settlement |

**Transversal à tous les modes online** : commit-reveal d'équité (hello
`entropyCommit` = sha256, révélation `game.entropy` sur match), horloge 15 s
(`BLITZ.moveClockMs`) avec auto-play puis forfait/bot, heartbeat, reconnexion/resume
(2p uniquement — le 4p forfeite vers un bot), rematch, emotes/cadeaux.

## 3. Environnement de test (recette éprouvée dans ce repo)

**Local d'abord.** La prod n'est sondée qu'en lecture (parties gratuites), jamais en
mode staké, et **jamais** en rafale (rate-limit : espacer les connexions ~1 s).

```bash
# 1. Serveur local (état en mémoire, settlement désactivé sans ARBITER_PRIVATE_KEY)
cd apps/server && nohup npx tsx src/index.ts > /tmp/ludo-server.log 2>&1 &
curl -s http://localhost:8787/health   # {"ok":true,...}

# 2. Web buildé pointant sur le serveur local — PAS `vite preview` (OOM sous Playwright)
VITE_SERVER_URL=ws://localhost:8787 npm run build --workspace @ludo/web
cd apps/web/dist && python3 -m http.server 8898 &
```

**Pilotage** : Playwright directement en Node (`import pw from '<repo>/node_modules/playwright/index.js'; const { chromium } = pw;`),
headless, `--no-sandbox`, un `browserContext` par joueur. Pour les tests protocole
purs, client WebSocket `ws` (import CJS par défaut) — le `hello` exige
`entropyCommit` hexadécimal 64 (sha256 de l'entropie), et la room ne démarre
qu'après `game.entropy` (révélation).

**Sélecteurs stables connus** : `.mrow` (lignes du lobby), `button.t4mode` (modale 4p),
`.tablecode`, `button.dicebtn` (mon dé 2p), `.huddie` (dé adverse 2p),
`.ludodie`/`.ludodie--tap` (dés 4p), `.token`/`.token--movable`, `.pbanner--sN` (2p),
`.plabel--qN` (4p, q0 = bas-gauche), texte `/(tap to close)/i` (modale d'accueil),
`/REMATCH|REVANCHE/i`.

**Modes stakés (M3/M6/M9)** : sans fonds réels, tester jusqu'aux frontières —
refus sans wallet, refus sans SIWE, refus geo-bloqué, refus `entropyCommit` manquant,
annulation + refund à l'expiration du fill (M9 : 60 s). Le happy-path on-chain n'est
testé que sur testnet et **sur autorisation explicite**.

## 4. Référentiels appliqués

- **ISO/IEC 25010** — caractéristiques ciblées : adéquation fonctionnelle,
  fiabilité (maturité, tolérance aux fautes, récupérabilité), efficacité
  d'interaction, robustesse.
- **ISTQB (CTAL-TA)** — conception : partitions d'équivalence, valeurs limites,
  **tests de transition d'états** (le moteur de jeu EST une machine à états),
  tables de décision pour les gates (wallet × geo × limites × consentement).
- **SBTM** (Session-Based Test Management, Bach/Bolton) — l'exploratoire se fait en
  sessions chartées de 60–90 min, avec notes horodatées et débriefing par charte.
- **Heuristiques d'oracle FEW HICCUPPS** — en particulier *Comparable Products*
  (Ludo King/Ludo Club), *Explainability* (tout écart doit être explicable) et
  *Product history* (le catalogue §6 est l'historique).

## 5. Méthode — règles non négociables

Ces règles sortent de l'expérience directe sur ce repo ; chacune a déjà évité ou
révélé un vrai bug ici :

1. **Contrôle d'abord.** Avant de corriger quoi que ce soit : reproduire le défaut
   sur le build/serveur NON corrigé avec une sonde chiffrée. Après correction :
   la même sonde, mêmes conditions. Le rapport contient les deux nombres
   (ex. « dé visible 0–32 ms → 1688–1701 ms »).
2. **Oracles valides.** (a) Mesurer `getComputedStyle`, jamais le style inline —
   la cible d'une transition CSS saute instantanément, seule la valeur calculée
   révèle l'animation. (b) Un élément démonté rend l'oracle muet : vérifier
   l'existence avant de lire. (c) **Assertions non-vacues** : « nom A == nom B »
   ne prouve rien si les deux joueurs ont tiré le même nom — relancer jusqu'à
   obtenir des identités distinctes. (d) Exclure des mesures serveur les
   événements cadencés par le harnais lui-même (un tap de robot à 150 ms n'est
   pas un auto-move serveur). (e) Attendre le calme du plateau avant de mesurer
   un mouvement (une marche précédente pollue la fenêtre).
3. **Deux écrans, toujours.** Chaque vérification d'affichage se fait sur les DEUX
   (ou QUATRE) clients simultanément : la classe de bugs la plus grave de ce projet
   était des états incohérents entre écrans (noms, sièges, plateaux).
4. **Chaque siège compte.** Tester depuis le siège 0 ne prouve rien : la moitié des
   bugs historiques ne frappaient que le siège 1 (ou 1–3 en 4p). Chaque scénario
   se rejoue depuis chaque position.
5. **Parties complètes.** Chaque mode est joué jusqu'à `game.over` au moins une
   fois, puis rematch, puis nouvelle partie complète. Un audit qui s'arrête au
   premier tour ne détecte ni les gels de milieu de partie ni les bugs de fin.
6. **Chaos réseau et cycle de vie.** Par mode : couper le socket en plein tour
   (le sien / celui de l'adversaire), reconnecter pendant `awaiting-move`,
   laisser expirer l'horloge 1×/2×/jusqu'au forfait, fermer l'onglet pendant un
   rematch en attente, `visibilitychange` (écran verrouillé) en pleine partie.
7. **Concurrence et spam.** Double-tap sur le dé, tap simultané des deux joueurs,
   spam d'emotes (throttle), `game.move` avec un token illégal, messages
   hors-séquence (protocole direct via `ws`).
8. **Hygiène des changements.** Tout correctif : `npm run typecheck && npm run lint
   && npm test`, bump `CACHE` dans `apps/web/public/sw.js` si le client change,
   commit par défaut découvert→prouvé→corrigé→vérifié. **Aucune action de prod**
   (deploy Fly/Vercel, secrets, scale) sans autorisation nommée explicite,
   à chaque fois.

## 6. Catalogue de régression — les 23 défauts déjà identifiés

Chacun DOIT avoir une sonde automatisée dans le harnais final. Colonne « oracle » =
le signal chiffré qui prouvait le bug.

| ID | Défaut (résumé) | Zone | Oracle de régression |
|----|-----------------|------|----------------------|
| R1 | Lancer multi-choix : état post-roll jamais envoyé → roller gelé | `room.ts doRoll` | après un 6 multi-choix, `game.state` reçu < 500 ms, `.token--movable` cliquable |
| R2 | Passage de tour sans `game.state` (aucun coup légal) → plateau gelé | `announceTurn` 2p+4p | après un roll sans coup, l'autre joueur peut lancer < 2 s |
| R3 | Rematch : entropie révélée une seule fois par session → 2e partie jamais démarrée | client `session.ts` | rematch → `game.state` reçu (partie 2 démarre) |
| R4 | Rematch privé fuyait dans la file publique | serveur | rematch privé ne matche jamais un inconnu en attente |
| R5 | Reconnexion : `activeTurn` périmé → impossible de lancer → auto-play « away » | store `RESUME` | après resume, `canRoll` vrai au tour suivant |
| R6 | Sockets silencieusement morts (pas de heartbeat) → plateau figé | client 2p+4p | ping/pong + fermeture forcée après 25 s de silence |
| R7 | Bannières codées siège 0 → l'invité voyait les noms inversés | GameScreen | `.pbanner--s0` = mon nom sur les DEUX écrans |
| R8 | Plateau 2p jamais tourné → siège 1 jouait du coin opposé | Board.tsx | les deux joueurs se voient en bas-gauche |
| R9 | Plateau 4p idem pour sièges 1–3 | Board4.tsx | 4 sièges : mon label en `q0`, géométrie = rotation rigide 90°·k |
| R10 | Mon dé démonté en plein tumble (auto-move instantané) | GameScreen | `button.dicebtn` présent ≥ 650 ms après le tap (0 violation) |
| R11 | Dés 4p montés à la volée → tumble jamais joué | Game4OnlineScreen | `.ludodie` count == 4 en permanence |
| R12 | Nom d'invité re-tiré à chaque connexion | identité | même nom `hello.ok` avant/après reload |
| R13 | Rematch échangeait les sièges ~50 % | re-pair serveur | sièges identiques partie 1 → partie 2 (l'invité clique en dernier) |
| R14 | « Cercle noir » : anneau de focus natif sur les pions SVG | CSS | `outlineStyle === 'none'` après tap d'un token |
| R15 | 8 identités invitées seulement (nom & drapeau corrélés au même hash) | `deriveIdentity` | ≥ 25 noms distincts sur 100 connexions |
| R16 | Drapeau inventé (hash puis géo) — règle produit : globe par défaut | serveur + bots | invités & bots = 🌍 uniquement ; `customFlag` choisi honoré |
| R17 | Table 4p : deux sièges pouvaient partager un label | `startRoom4` | 0 doublon sur ≥ 50 tables ; suffixe « Nom 2 » observé |
| R18 | 1v1 même nom : écrans en désaccord ; labels perdus au resume | `youName` protocole | collision forcée → « Imani »/« Imani 2 » cohérents, y compris après reconnexion |
| R19 | Le dé adverse tournait pendant MON lancer (rembobinage des tours) | Die3D `snap()` | 1 seule matrice calculée sur le dé adverse pendant mon roll |
| R20 | Résultat adverse visible 0–32 ms | `DIE_HOLD_MS` | visibilité ≥ 1200 ms après début du tumble |
| R21 | Le pion partait pendant le tumble (auto-move synchrone au roll) | `room.ts` pacing | gap `game.dice`→`game.moved` serveur ≥ 700 ms ; pion ≥ 700 ms dans le navigateur |
| R22 | 2 machines Fly = état splitté → matchmaking intermittent | infra | exactement 1 machine `started` (prod uniquement, lecture) |
| R23 | Partie gratuite bloquée sur « Opponent found! » si une révélation manque | reveal timeout | partie démarre ≤ 6 s même si un client ne révèle pas |

## 7. Chasse aux inconnus — matrice de couverture

Pour chaque mode M1–M9, dérouler ces classes (prioriser selon le risque :
M5/M8 sont les plus joués, M3/M6/M9 portent l'argent) :

- **Transitions d'états du moteur** : sortie de base sur 6 ; trois 6 consécutifs
  (tour brûlé + toast) ; capture (burst + renvoi en base) ; case étoile/sûre ;
  entrée colonne d'arrivée ; dépassement (rebond ou coup illégal ?) ; dernier
  pion → victoire ; blitz 2 pions vs ludo4 4 pions.
- **Fin de partie** : victoire par finish / abandon / forfait d'horloge ;
  modale de résultat des deux côtés ; ELO ; rematch accepté / refusé / unilatéral
  avec départ de l'autre.
- **Timers** : auto-play à 15 s (1×, 2×, streak max → forfait 2p / bot 4p) ;
  reprise de la main après auto-play ; rematch pendant que l'horloge de l'autre
  court encore.
- **Réseau** : perte socket dans chacun des états (`awaiting-roll`, `awaiting-move`,
  pendant la marche du pion, pendant la modale de fin) ; double reconnexion ;
  resume avec la MÊME room côté serveur (2p) ; 4p = siège → bot, vérifier
  l'affichage du remplacement.
- **Multi-onglets / multi-appareils** : le même joueur ouvre 2 onglets
  (sessionToken partagé — hijack ? double file ?).
- **Frontières monétaires (sans fonds)** : chaque porte de refus (wallet absent,
  SIWE refusé, geo-bloqué, limite journalière, `entropyCommit` absent sur staké,
  ticket freeroll manquant) rend un message clair et NE bloque pas la session.
- **Équité** : le commit sha256 publié en début de partie se vérifie contre la
  révélation en fin de partie (bouton « verify » + recalcul indépendant).
- **UI sous contrainte** : viewport mobile étroit (Pixel 5), thème sombre,
  `prefers-reduced-motion`, langue FR/EN, PWA installée avec ancien SW en cache
  (bump `CACHE` → reload → nouvelle version active).

## 8. Livrables et critères de sortie

1. **Harnais e2e commité** sous `e2e/` (scripts Node/Playwright autonomes,
   `README` avec la commande unique de lancement) couvrant : R1–R23 + une partie
   complète par mode M1–M9 + les sondes de cadence (dés, pion, visibilité).
2. **Journal de bugs** : un fichier par défaut trouvé — sévérité
   (P0 bloque la partie / P1 induit une erreur de jeu / P2 cosmétique),
   repro minimale, oracle chiffré avant/après, mode(s) affecté(s), commit du fix.
3. **Rapport final** (`docs/QA-AUDIT-REPORT-<date>.md`) : matrice modes × classes
   de tests avec verdict ✅/❌/⚠️ ; défauts trouvés/corrigés/résiduels ; risques
   acceptés (ex. happy-path staké non joué on-chain) ; recommandations classées.
4. **Critères de sortie** : 100 % des sondes R1–R23 vertes ; 1 partie complète +
   1 rematch verts par mode jouable localement ; 0 P0/P1 ouvert ; toute
   correction déployée re-vérifiée contre la prod live (sur autorisation).

## 9. Règles d'engagement (rappel contractuel)

- Chaque action mutant la production (deploy Fly/Vercel, secrets, scale,
  contrats) exige une **autorisation nommée, à chaque occurrence** — un « oui »
  antérieur ne se reporte pas.
- Jamais de partie stakée réelle en prod pendant l'audit ; sondes prod = parties
  gratuites, espacées (rate-limit), aux heures creuses de préférence.
- Aucun secret commité ; wallet de test dev-unlock :
  `0x3154835dEAf9DF60A7aCaf45955236e73aD84502`.
- Changements de protocole : `packages/shared` → serveur → client, champs
  optionnels rétrocompatibles d'abord, serveur déployé avant le web.
