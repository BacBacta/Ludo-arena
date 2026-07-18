# e2e — harnais d'audit des modes de jeu

Sondes de régression et de parties complètes issues de l'audit QA
(`docs/QA-GAME-AUDIT-PROMPT.md`). Chaque sonde est un script Node autonome ;
`run-all.mjs` les enchaîne et rend un verdict consolidé.

## Lancer

```bash
# 1. serveur local (état en mémoire)
cd apps/server && npx tsx src/index.ts &

# 2. web buildé pointant sur le serveur local, servi statiquement
#    (PAS `vite preview` : il OOM sous Playwright)
VITE_SERVER_URL=ws://localhost:8787 npm run build --workspace @ludo/web
(cd apps/web/dist && python3 -m http.server 8898 &)

# 3. tout le harnais (~20 min)
node e2e/run-all.mjs

# 4. sonde PERF (Phase 6) — exige une origine qui COMPRESSE (comme la prod).
#    `python3 -m http.server` ne compresse pas : la mesure porterait alors sur les
#    octets bruts (~669 Ko) et le TTI 3G serait faux (~10 s au lieu de ~4 s).
node e2e/lib/serve-gzip.mjs apps/web/dist 8899 &
WEB=http://localhost:8899 node e2e/ui-perf.mjs
```

Variables : `SRV` (défaut `ws://localhost:8787`), `WEB` (défaut
`http://localhost:8898`). Les sondes filaires peuvent viser la prod
(`SRV=wss://ludo-arena.fly.dev`) **en parties gratuites uniquement et sans
rafale** (rate-limit : espacer ~1 s). `M8_CAP_MS` allonge la partie 4p complète
(défaut 5 min = oracle de progression ; `M8_CAP_MS=1500000` pour exiger
`game.over4`).

## Couverture

| Script | Couvre |
|---|---|
| `wire-regression.mjs` | M2+M5 parties complètes, R1–R4, R13, R23, horloge/auto-play, coups illégaux/dupliqués/hors-tour, spam d'emotes, resign |
| `wire-identity.mjs` | R12 (moitié serveur), R15–R18 (collision forcée + resume) |
| `wire-gates.mjs` | frontières M3/M4/M6/M9 + refus staké sans commit d'équité |
| `wire-4p.mjs` | M8 partie complète (ou progression sous cap), cadence dés 4p |
| `ui-2p.mjs` | M5 en UI : R5 (reconnexion), R6 (heartbeat), R7/R8 (bannières), R10, R14, rematch |
| `ui-dice.mjs` | R19, R20, R21 (matrices calculées, jamais le style inline) |
| `ui-4p.mjs` | M8 en UI : R9 (rotation par siège), R11 (4 dés montés), labels croisés |
| `ui-practice.mjs` | M1 (CTA gratuit hors-ligne → pratique 4p jouable), M7 |

Non couvert ici (voir rapport d'audit) : happy-path staké on-chain (M3/M6 —
testnet sur autorisation ; M9 grillé serveur « coming soon »), R22 (compte de
machines Fly, prod en lecture).

## Règles d'oracle (résumé de §5 du prompt d'audit)

- mesurer `getComputedStyle`, jamais le style inline ;
- filtrer par **index de log**, jamais par timestamp (une réponse locale arrive
  dans la même milliseconde que l'envoi) ;
- n'échantillonner que les clics qui ont **réellement atterri** ;
- exclure des mesures serveur les coups choisis par le harnais lui-même ;
- assertions non-vacues (deux joueurs du même nom ne prouvent rien).
