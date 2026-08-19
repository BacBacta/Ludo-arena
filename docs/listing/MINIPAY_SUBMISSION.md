# Dossier de soumission MiniPay

Ce fichier tient l'état des livrables **non-code** de la soumission. Les
bloquants code sont fermés (#186) ; ce qui suit est ce qu'un formulaire de
listing demande et qu'aucun test ne peut produire.

Chaque ligne dit **comment la revérifier**, parce qu'une case cochée sans
commande derrière est une case qui périme en silence.

| Livrable | État | Revérification |
|---|---|---|
| Vérification Celoscan des 4 contrats mainnet | ✅ les 4 vérifiés | tableau ci-dessous |
| Hashes de transaction par méthode utilisateur | ⚠️ 3 parcours sur 4 | `NETWORK=celo npm run method-tx-hashes -w packages/contracts` |
| 3 captures d'écran ≤ 500 Ko | ✅ | `node e2e/listing-shots.mjs` |
| Engagement SLA 24 h | ✅ affiché in-app | fiche d'aide → Support |
| Manifeste des origines réseau | ✅ | rapport d'audit |
| Score PageSpeed ≥ 90 mobile | ⚠️ à mesurer hors sandbox ; 1 défaut de cache corrigé | `npx lighthouse https://www.ludoarena.xyz/ --form-factor=mobile` |
| CGU / confidentialité | ⚠️ `TOS_DRAFT` / `PRIVACY_DRAFT` | relecture juridique avant listing |

---

## 1. Vérification Celoscan (mainnet, chainId 42220)

Les quatre contrats sont **déjà vérifiés** — rien à faire.

| Contrat | Adresse | Source |
|---|---|---|
| LudoEscrow | `0xabdfea03be58d3276b13b40885311d84259d7f4d` | ✅ vérifiée |
| LudoEscrowN | `0x0142dd7125e339dcbccbb4e2fc7b28c09d21fc6e` | ✅ vérifiée |
| CosmeticsStore | `0x423442b6b78423ca8970ee1b92f85236d9194c6f` | ✅ vérifiée |
| RacePass | `0x3ca68b8a7e2c429dec33a34e0589173dfb305be4` | ✅ vérifiée |

Revérification : `https://celoscan.io/address/<adresse>#code`.

## 2. Hashes de transaction par méthode utilisateur

`deployments.json` ne garde que les tx de **déploiement**, ce qui ne répond pas
à la question du formulaire (« ce parcours a-t-il réellement tourné ? »).
`npm run method-tx-hashes` regroupe les transactions entrantes de chaque
contrat par sélecteur 4 octets et sort le **premier** et le **dernier** appel
réussi de chaque méthode. Lecture seule, sans clé.

Relevé du 2026-08-19 :

| Parcours | Contrat | Preuve on-chain |
|---|---|---|
| Placer une mise (1v1) | LudoEscrow · `join` | 1969 appels — 1er `0xcd7794e5ff17f18b83bc8c3080d1d75f8955d31fb8ac96f9fa136d5ef2223e60` |
| Règlement du gagnant | LudoEscrow · `settle` | 812 appels — 1er `0xe13e93fbe8a10a568148d1f85b70c81ff42009a4e001c15674ec69458e2daa50` |
| Mint du Race Pass | RacePass · `mint` | 162 appels — 1er `0xd70fc736a986403aa351c2ff952c75b01b1a763e8b0865031e5f912b640b9a26` |
| Remboursement d'une partie expirée | LudoEscrow · `refundExpired` | 198 appels — 1er `0xc8a884dab1676c2159cc00f92bce72d67bfe98beb53b26cd532c616ecb077818` |
| **Achat d'un cosmétique** | CosmeticsStore · `buy` | ❌ **jamais appelé sur mainnet** |

### Le trou : l'achat de cosmétique

Le `CosmeticsStore` mainnet n'avait reçu que **2 transactions**, toutes deux
administratives. Aucun `buy` n'a jamais abouti, donc **il n'existe aucun hash à
citer** pour ce parcours.

Ce n'est pas une lacune de collecte : le parcours n'a littéralement jamais
tourné en production. La bascule USD₮ a depuis été exécutée (`setToken` +
`setPrices`, voir §7), mais elle ne crée pas de preuve par elle-même —
**il faut un achat réel**, une fois le serveur redéployé, puis relancer
`method-tx-hashes` pour récupérer le hash.

`LudoEscrowN` (tables 4 joueurs) est dans le même cas — aucun `join` mainnet.
Si le formulaire ne demande une preuve que par *méthode utilisateur exposée*, la
table 4 joueurs en est une : soit on produit une partie misée réelle, soit on la
déclare hors périmètre de la soumission.

## 3. Captures d'écran

`docs/listing/screenshots/` — trois PNG au viewport Android 360×640, tous sous
la limite de 500 Ko :

| Fichier | Contenu | Poids |
|---|---|---|
| `01-lobby.png` | lobby, bascule Gratuit / Mises | 313 Ko |
| `02-board.png` | vraie partie en cours entre deux clients mobiles appariés | 188 Ko |
| `03-shop.png` | boutique de cosmétiques | 252 Ko |

Régénération : `node e2e/listing-shots.mjs` contre la pile locale
(voir `e2e/README.md`). Le script **échoue** si une image dépasse 500 Ko, et la
capture du plateau vient d'un vrai appariement joué, pas d'une maquette.

## 4. Engagement SLA 24 h

Affiché in-app dans la fiche d'aide, section Support, juste sous l'adresse à
laquelle il s'applique — dans les cinq langues de l'app (`hSupportSla`) :

> Tout ce qui bloque le jeu ou l'argent — mise coincée, gain non versé — reçoit
> une première réponse sous 24 heures.

Périmètre : **première réponse** sous 24 h sur les incidents critiques (mise
bloquée, gain non versé, impossibilité de jouer), pas une résolution garantie
sous 24 h. Contact : `SUPPORT_EMAIL` dans `apps/web/src/components/ui.tsx`.

## 5. Score PageSpeed — non mesurable depuis le dépôt, une cause réparée

URL de production : **https://www.ludoarena.xyz** (Vercel, HTTP/2, HSTS).

### Ce qui empêche la mesure ici

Deux blocages d'environnement, aucun côté application :

1. **API PageSpeed Insights** → `429 Quota exceeded` sur le projet anonyme
   partagé. Il faut une clé d'API Google, ou lancer PSI depuis un navigateur.
2. **Lighthouse en local** → Chromium n'émet jamais l'entrée
   `first-contentful-paint` dans ce conteneur (headless sans compositeur réel) :
   la page s'affiche bel et bien — le DOM est peint et lisible — mais Lighthouse
   abandonne sur `NO_FCP`. Et de toute façon Chromium ne peut pas joindre
   l'hôte de production à travers le proxy d'egress (`ERR_CONNECTION_RESET`),
   alors que `curl` y arrive.

**Pour obtenir le chiffre qui fait foi**, depuis une machine à réseau normal :

```bash
npx lighthouse https://www.ludoarena.xyz/ --form-factor=mobile --view
# ou : https://pagespeed.web.dev/analysis?url=https://www.ludoarena.xyz
```

### Ce que la production sert réellement (mesuré par `curl`)

| Ressource | Encodage | Transféré | Brut | `Cache-Control` |
|---|---|---|---|---|
| `/` (HTML) | brotli | — | — | `no-cache, no-store` (correct) |
| `/assets/index-*.js` | brotli | **243,8 Ko** | 801,8 Ko | ⚠️ voir ci-dessous |
| `/assets/index-*.css` | brotli | **22,6 Ko** | 101,0 Ko | ⚠️ voir ci-dessous |

Chemin critique réel : **266,4 Ko** sur le fil — sous le budget de 300 Ko de la
règle d'or 4. La compression et le HTTP/2 sont en place.

### Le défaut trouvé, et corrigé

`vercel.json` ne déclarait **aucune règle de cache pour `/assets/*`**. Les
fichiers y sont pourtant nommés par le HASH de leur contenu — le cas d'école du
cache immuable — mais le défaut Vercel s'appliquait :

```
cache-control: public, max-age=0, must-revalidate
```

Chaque visite revalidait donc l'intégralité des 266 Ko du chemin critique.
C'est exactement l'audit « Serve static assets with an efficient cache policy »
que PageSpeed pénalise, et un coût de rechargement à chaque retour d'un joueur.

Corrigé : `/assets/(.*)` → `public, max-age=31536000, immutable`. Sans risque de
code périmé, puisqu'un nouveau build produit de nouveaux noms de fichiers ;
`index.html`, `sw.js` et `version.json` restent en `no-store`, et ce sont eux
qui font qu'un déploiement prend effet.

**Le gain n'apparaîtra qu'après le prochain déploiement Vercel.** Mesurer le
score *après*, pas avant.

## 6. Réserve : CGU et confidentialité

`TOS_DRAFT` et `PRIVACY_DRAFT` (`apps/web/src/components/ui.tsx`) portent
« DRAFT » dans leur nom. Ils sont affichés aux joueurs derrière la porte de
consentement 18+. **À faire relire avant listing** — c'est le seul livrable de
cette liste qui engage juridiquement l'opérateur.

## 7. État de la bascule cUSD → USD₮ (mainnet)

Exécutée le 2026-08-19 via `fly-ops`, clé owner = `ESCROW_OWNER_PRIVATE_KEY`
(signataire `0x947Fa33C5A2157Bc3618Cc7B66a32A3A4b14951B`, le **treasury** — pas
l'arbitre). `migration-status` : **plus rien en attente on-chain**.

| Étape | État |
|---|---|
| `allow-token` USD₮ sur LudoEscrow + LudoEscrowN | ✅ |
| `set-tier-rake` 1¢ → 1 bps | ✅ |
| `set-tier-rake` 25¢ → 1000 bps | ✅ |
| `set-tier-rake` 100¢ → 800 bps | ✅ |
| `set-tier-rake` 500¢ → 600 bps | ✅ |
| `list-cosmetics` (setToken puis setPrices, 22/22) | ✅ |
| Redéploiement du serveur | ⛔ **bloqué : voir ci-dessous** |

Revérification : `NETWORK=celo npm run migration-status -w packages/contracts`
(lecture seule, aucune clé).

### Pourquoi le redéploiement ne peut pas suivre tout de suite

`main` est à `ff4e70b` (#179). **#183 à #186 ne sont PAS mergés** — sur `main`,
`deployments.json` pointe encore sur le cUSD. Redéployer le serveur maintenant
rebakerait donc l'ancien jeton et défairait la bascule côté applicatif.

**Ordre restant : merger d'abord, redéployer ensuite.**

En attendant, rien n'est cassé côté mises : l'allowlist est *additive*, le cUSD
reste autorisé, et le serveur en production continue de jouer en cUSD.

La seule conséquence à connaître : le `CosmeticsStore` pointe désormais sur
l'USD₮ alors que le client déployé approuve encore du cUSD — les achats de
cosmétiques échoueront jusqu'au merge + redéploiement. C'est sans perte : ce
parcours n'a jamais abouti une seule fois en production (§2), et l'ordre
inverse (reprixer avant de repointer) aurait bradé les 22 articles à une
fraction de centime.
