# Backlog d'implémentation

Chaque tâche est autoportante et calibrée pour un agent. Cocher à la livraison. Respecter `AGENTS.md`.

## E1 — Fondations (fait dans le scaffold)

- [x] Moteur de jeu pur + tests + simulation
- [x] Protocole partagé typé
- [x] Serveur ws : hello/queue/rooms/dés commit-reveal/auto-move
- [x] Frontend : lobby, matchmaking, plateau SVG, fin de partie, mode bot
- [x] Contrat LudoEscrow (create/join/settle/rake) + tests Foundry
- [x] CI (typecheck, tests, simulation, build)

## E2 — PvP production-ready

- [ ] **E2.1 Persistance** : remplacer les Map en mémoire par Redis (sessions, files, rooms) + Postgres (joueurs, parties, ELO). Schéma dans la PR. *AC : un restart serveur ne tue pas les parties en cours.*
- [ ] **E2.2 Reconnexion complète** : resume via sessionToken depuis le client (UI « reconnexion… »), resync d'état. *AC : couper le réseau 20 s en pleine partie → la partie continue.*
- [ ] **E2.3 ELO persistant + matchmaking ±100** avec élargissement progressif (+50/5 s). *AC : test unitaire de la fenêtre.*
- [ ] **E2.4 Rate limiting & taille de trame** (déjà borné à 1 Ko) + ban temporaire. *AC : test d'abus.*

## E3 — Intégration on-chain réelle

- [ ] **E3.1 Déploiement Alfajores** de LudoEscrow + script `forge script` + adresses dans `packages/contracts/deployments.json`.
- [ ] **E3.2 Flux de mise côté web** : approve cUSD + `join(gameId)` via viem (tx legacy, feeCurrency cUSD), états UI (en attente de confirmation, verrouillé). *AC : partie misée complète sur Alfajores.*
- [ ] **E3.3 Arbitre serveur** : signature EIP-712 du résultat, soumission `settle()`, retry + file de règlements. *AC : payout < 5 s après game.over en testnet.*
- [ ] **E3.4 Timeout on-chain** : remboursement si l'adversaire ne join pas en 120 s (`refundExpired`).

## E4 — Rétention

- [ ] **E4.1 Défi du jour** (config serveur, progression, récompense ticket) + UI.
- [ ] **E4.2 Série de connexion** (streak) persistée + récompenses J3/J7.
- [ ] **E4.3 Ligue hebdomadaire** : divisions, classement, promotion/relégation cron lundi 00:00 UTC.
- [ ] **E4.4 Table privée** : création de room par code/lien (`/g/ABC123`), partage WhatsApp.
- [ ] **E4.5 Cashback anti-tilt** : détection 3 défaites misées consécutives → crédit 20 % rake + toast.

## E5 — Confiance & conformité

- [ ] **E5.1 Page de vérification des dés** : rejouer les hash côté client (WebCrypto) depuis `fairnessReveal`, UI pédagogique.
- [ ] **E5.2 Limites de jeu responsable** côté serveur : mise max/jour par wallet (défaut 200 cents), auto-exclusion, page paramètres.
- [ ] **E5.3 Anti multi-comptes v1** : empreinte device + refus de parties misées répétées contre le même wallet (> 3/jour).
- [ ] **E5.4 Geo-gating** : header pays (CDN) → stakes désactivés si pays non autorisé (liste config).

## E6 — Polish & i18n

- [ ] **E6.1 i18n complet** FR/EN (fichiers `apps/web/src/lib/i18n.ts`) puis PT/ES/SW.
- [ ] **E6.2 Sons discrets** (dé, capture, victoire) — < 30 Ko au total, opt-out.
- [ ] **E6.3 Animations de déplacement des pions** (interpolation case par case, 120 ms/case).
- [ ] **E6.4 Onboarding première session** : partie de bienvenue gratuite dotée, tooltip unique.
- [ ] **E6.5 PWA** : manifest + service worker (cache assets, offline vs bot).

## E7 — Listing MiniPay

- [ ] **E7.1 CGU + politique de confidentialité** (pages statiques, exigées par les ToS Mini Apps).
- [ ] **E7.2 Test dans MiniPay** (mode dev, checklist docs.minipay.xyz), corrections container/viewport.
- [ ] **E7.3 Soumission listing** + analytics d'activation (funnel première session).
