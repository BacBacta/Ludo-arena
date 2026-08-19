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
| Score PageSpeed ≥ 90 mobile | ✅ **96/100** sur les octets déployés (blocage FCP levé) | `npx lighthouse https://www.ludoarena.xyz/ --form-factor=mobile` |
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

## 5. Score PageSpeed — **96 / 100 mobile**, après avoir levé un blocage

URL de production : **https://www.ludoarena.xyz** (Vercel, HTTP/2, HSTS, brotli).

### Le site n'était pas notable du tout

`.screen` et les enfants du lobby entraient par une animation partant
d'`opacity: 0`. **Tout le contenu était donc totalement transparent au premier
rendu.** Chromium ignore une peinture entièrement transparente, et une
animation d'opacité tourne sur le compositeur — aucun repeint du thread
principal ne suit. Résultat : `first-paint` était bien émis, jamais
`first-contentful-paint`.

Une page sans FCP n'est pas « mal notée », elle est **impossible à noter** :
Lighthouse et PageSpeed abandonnent sur `NO_FCP`. La cible 90+ du listing était
donc hors d'atteinte par construction, sans que rien ne le signale — la page
s'affichait normalement.

Contrôle qui a tranché : même navigateur, même serveur, même navigation. Une
page triviale émet son FCP à 28 ms ; l'application n'en émettait aucun après
12 s, texte pourtant lisible à l'écran.

Correctif : les animations d'entrée sont armées seulement une fois le premier
écran **peint** (`:root.booted`, posé depuis un effet React committé — deux
frames depuis le module s'écoulaient avant le montage et rearmaient
l'animation juste à temps pour ravaler la peinture). Le premier écran est donc
opaque, les changements d'écran suivants s'animent comme avant.

### Le relevé

Le correctif est **déployé** (`www.ludoarena.xyz`, vérifié dans le bundle servi :
`booted` dans le JS, `--entrance-screen` armé sous `:root.booted` dans le CSS).

Mesure effectuée sur les **octets réellement déployés** — index, JS, CSS, chunk
3D différé et polices récupérés depuis la production par `curl`, puis resservis
localement en brotli avec le `Cache-Control` de `vercel.json`. Aucun 404, FCP
émis à 160 ms sans étranglement.

Lighthouse mobile (le moteur de PageSpeed) :

| Métrique | Valeur | Score |
|---|---|---|
| **Performance** | | **96 / 100** |
| First Contentful Paint | 2,0 s | 0,85 |
| Largest Contentful Paint | 2,5 s | 0,90 |
| Total Blocking Time | 80 ms | 0,99 |
| Cumulative Layout Shift | 0 | 1,00 |
| Speed Index | 2,0 s | 0,99 |

Pistes restantes, sans urgence : 108 Ko de JS et 14 Ko de CSS inutilisés au
chargement.

**Réserve, à énoncer telle quelle.** Ce sont les octets de production, mais pas
le réseau de production : le CDN Vercel est remplacé par un serveur local, et
l'étranglement mobile de Lighthouse est simulé. Les temps réels seront
différents — vraisemblablement meilleurs, la latence CDN étant inférieure à
celle de ce montage, mais c'est une attente et non un résultat.

Le chiffre à porter au formulaire doit venir d'une machine à réseau normal.
Depuis cet environnement c'est impossible : Chromium reçoit `ERR_CONNECTION_RESET`
sur l'hôte de production comme sur les previews (le proxy d'egress ne laisse
passer que `curl`), et l'API PageSpeed Insights répond `429 Quota exceeded` sur
le projet anonyme partagé.

```bash
npx lighthouse https://www.ludoarena.xyz/ --form-factor=mobile --view
# ou : https://pagespeed.web.dev/analysis?url=https://www.ludoarena.xyz
```

### Ce que la production sert (mesuré par `curl`)

| Ressource | Encodage | Transféré | Brut | `Cache-Control` |
|---|---|---|---|---|
| `/` (HTML) | brotli | — | — | `no-cache, no-store` |
| `/assets/index-*.js` | brotli | 243,9 Ko | 801,8 Ko | `max-age=31536000, immutable` ✅ |
| `/assets/index-*.css` | brotli | 22,6 Ko | 101,0 Ko | `max-age=31536000, immutable` ✅ |

Chemin critique : **266,5 Ko** sur le fil, sous le budget de 300 Ko de la règle
d'or 4. Le cache immuable est en ligne depuis le merge de #187 ; auparavant
`vercel.json` ne déclarait aucune règle pour `/assets/*` et le défaut Vercel
(`max-age=0, must-revalidate`) revalidait ces 266 Ko à chaque visite.

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
| Redéploiement du serveur | ⏳ **étape suivante** |

Revérification : `NETWORK=celo npm run migration-status -w packages/contracts`
(lecture seule, aucune clé).

### Ce qui reste : redéployer le serveur

`main` est à `61b0986` : #183 à #186 sont mergés et `deployments.json` y pointe
sur l'USD₮. Il ne reste qu'à redéployer le serveur — son image rebake
`deployments.json` (décimales du faucet Race, dotation JIT) — et à redéployer
le web si Vercel ne l'a pas déjà fait sur le merge.

Tant que ce n'est pas fait, le serveur en production tourne encore sur l'image
précédente. Les mises ne risquent rien : l'allowlist est *additive*, le cUSD
reste autorisé.

La seule conséquence à connaître : le `CosmeticsStore` pointe désormais sur
l'USD₮ alors que le client déployé approuve encore du cUSD — les achats de
cosmétiques échoueront jusqu'au redéploiement. C'est sans perte : ce parcours
n'a jamais abouti une seule fois en production (§2), et l'ordre inverse
(reprixer avant de repointer) aurait bradé les 22 articles à une fraction de
centime.
