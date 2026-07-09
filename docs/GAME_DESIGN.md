# Game design — résumé opérationnel

(Version complète : document Word « Ludo Arena — Conception », hors repo.)

## Format cœur : Blitz 1v1

- 2 pions par joueur. Le pion 1 démarre sur la case départ, le pion 2 sort de la base avec un 6.
- Piste standard de 52 cases, 8 cases sûres (étoiles), colonne maison de 5 cases.
- Dépassement autorisé pour finir (pas de dé exact requis) → parties de 3-6 min (~68 lancers en moyenne, validé par simulation).
- 6 ou capture = rejoue. Capture = pion adverse renvoyé en base (sauf case sûre).
- Horloge 15 s/décision, auto-move à expiration, 3 auto-moves consécutifs = forfait.
- Victoire : les 2 pions arrivés au centre.

## Boucles de rétention

| Boucle | Mécanique | KPI |
|---|---|---|
| Session | revanche en 1 tap, matchmaking < 10 s | ≥ 3 parties/session |
| Quotidienne | défi du jour, série de connexion, 1 freeroll/jour | D1 ≥ 40 % |
| Hebdo | ligues à divisions (promotion/relégation lundi) | D7 ≥ 20 % |
| Sociale | table privée par lien WhatsApp, parrainage 0,25 $ | K ≥ 0,3 |

## Anti-churn

- Matchmaking ELO ± 100.
- 3 défaites misées consécutives → cashback 20 % du rake + ticket freeroll.
- Limite de dépense quotidienne (défaut 2 $), auto-exclusion, pas de mécaniques casino.
- Déconnexion ≠ défaite (auto-move, reconnexion 60 s).

## Modèle économique (hybride 3 étages)

1. Rake 8-10 % sur parties misées (0,10 – 2 $), 10-12 % sur tournois — **geo-gaté** selon la légalité.
2. Pass de saison 0,99 $/mois + cosmétiques.
3. Freerolls sponsorisés + programme d'incitation MiniPay (grants CELO indexés sur l'activité on-chain).

## Ton UI

Premium sobre : fond vert forêt profond (#0E1512), cartes #16211C, accent or #F5B301, joueur #2E9E6B, adversaire #E8833A. Micro-animations discrètes, jamais de clignotements casino. Typo system-ui. FR/EN au lancement (puis PT/ES/SW).
