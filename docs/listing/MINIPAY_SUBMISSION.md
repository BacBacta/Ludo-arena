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
| Score PageSpeed ≥ 90 mobile | ❌ à mesurer | URL de production requise |
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

Le `CosmeticsStore` mainnet n'a reçu que **2 transactions**, toutes deux
administratives (`setPrices` au déploiement). Aucun `buy` n'a jamais abouti, donc
**il n'existe aucun hash à citer** pour ce parcours.

Ce n'est pas une lacune de collecte, c'est l'état du contrat : il pointe encore
sur le cUSD (`setToken` n'a jamais été appelé) et son catalogue est prixé en
unités 18-décimales. Le parcours ne peut pas produire de preuve tant que
l'étape `list-cosmetics` de la bascule USD₮ (`DEPLOY.md §5`) n'a pas tourné.
**Ordre imposé : d'abord la bascule, puis un achat réel, puis le hash.**

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

## 5. Score PageSpeed — non mesuré

Cible : 90+ mobile sur l'**URL de production**. Non mesurable depuis ce dépôt :
il faut l'URL déployée, et un `python3 -m http.server` local ne compresse rien
(`e2e/ui-perf.mjs` le dit explicitement et échoue dessus par construction — ce
n'est pas une régression).

Ce que la build donne aujourd'hui, gzip, hors serveur : chemin critique
≈ 240 Ko, chunk 3D différé ≈ 118 Ko — sous les deux budgets de la règle d'or 4.
Les avatars WebP de #186 (−82 %) ne sont pas encore reflétés dans une mesure
terrain.

## 6. Réserve : CGU et confidentialité

`TOS_DRAFT` et `PRIVACY_DRAFT` (`apps/web/src/components/ui.tsx`) portent
« DRAFT » dans leur nom. Ils sont affichés aux joueurs derrière la porte de
consentement 18+. **À faire relire avant listing** — c'est le seul livrable de
cette liste qui engage juridiquement l'opérateur.
