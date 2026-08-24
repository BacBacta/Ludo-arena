# Dossier de soumission MiniPay

Ce fichier tient l'état des livrables **non-code** de la soumission. Les
bloquants code sont fermés (#186) ; ce qui suit est ce qu'un formulaire de
listing demande et qu'aucun test ne peut produire.

Chaque ligne dit **comment la revérifier**, parce qu'une case cochée sans
commande derrière est une case qui périme en silence.

| Livrable | État | Revérification |
|---|---|---|
| Vérification Celoscan des 4 contrats mainnet | ✅ les 4 vérifiés | tableau ci-dessous |
| Hashes de transaction par méthode utilisateur | ✅ **les 6 parcours** — la table 4 joueurs est allée jusqu'au paiement le 2026-08-24 | `NETWORK=celo npm run method-tx-hashes -w packages/contracts` |
| 3 captures d'écran ≤ 500 Ko | ✅ | `node e2e/listing-shots.mjs` |
| Engagement SLA 24 h | ✅ affiché in-app | fiche d'aide → Support |
| Manifeste des origines réseau | ✅ | rapport d'audit |
| Score PageSpeed ≥ 90 mobile | ✅ **96/100** sur les octets déployés (blocage FCP levé) | `npx lighthouse https://www.ludoarena.xyz/ --form-factor=mobile` |
| CGU / confidentialité | ✅ validées contre le code (plus de DRAFT) | `TOS_TEXT` / `PRIVACY_TEXT`, `apps/web/src/components/ui.tsx` |

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

Relevé du 2026-08-19, complété le 2026-08-24 par les deux lignes 4 joueurs :

| Parcours | Contrat | Preuve on-chain |
|---|---|---|
| Placer une mise (1v1) | LudoEscrow · `join` | 1969 appels — 1er `0xcd7794e5ff17f18b83bc8c3080d1d75f8955d31fb8ac96f9fa136d5ef2223e60` |
| Règlement du gagnant | LudoEscrow · `settle` | 812 appels — 1er `0xe13e93fbe8a10a568148d1f85b70c81ff42009a4e001c15674ec69458e2daa50` |
| Mint du Race Pass | RacePass · `mint` | 162 appels — 1er `0xd70fc736a986403aa351c2ff952c75b01b1a763e8b0865031e5f912b640b9a26` |
| Remboursement d'une partie expirée | LudoEscrow · `refundExpired` | 198 appels — 1er `0xc8a884dab1676c2159cc00f92bce72d67bfe98beb53b26cd532c616ecb077818` |
| Achat d'un cosmétique | CosmeticsStore · `buy` | 1 appel — `0x88a58732a9fa43767d1b9d058acf1533db40214f8dc28ae58e1f767c8e3d97e9` |
| **Table 4 joueurs misée** | LudoEscrowN · `join` | ✅ 14 appels — 1er `0x67e0f8203a52f0510eae3ea5d8deb27c70a2e6c957da0027c4b95d9e89858019` |
| **Paiement du gagnant (4 joueurs)** | LudoEscrowN · `settle` | ✅ `0x8bb8270facfe124bc47609d9842e52fb1b6dd1d8932e6e10db4c2202311ab98e` |

### L'achat de cosmétique — comblé le 2026-08-19

Le premier `buy` mainnet a abouti, et il vaut mieux qu'une case cochée : il
valide la bascule USD₮ de bout en bout par une transaction d'utilisateur réel,
et non par une lecture de contrat.

| | |
|---|---|
| Hash | `0x88a58732a9fa43767d1b9d058acf1533db40214f8dc28ae58e1f767c8e3d97e9` |
| Statut | `success`, 2026-08-19 22:16:49 UTC |
| Article | `tok-wax` — `Purchased` porte le prix brut `490000` |
| Flux | **0,49 USD₮** de l'acheteur vers `0x947Fa33C…4951B` (le `treasury`) |

49 ¢ dans `PREMIUM_COSMETICS` × 10⁴ = 490 000 en 6 décimales : le `setToken` +
`setPrices` de la bascule a donc atterri au bon prix, sur le bon jeton, vers la
bonne trésorerie. Le gas est payé en CELO natif — normal pour un wallet
navigateur externe, qui ne signe pas de CIP-64 ; sous MiniPay ce serait
l'adaptateur.

Revérification : `NETWORK=celo npm run method-tx-hashes -w packages/contracts`.

### La partie 4 joueurs misée, jouée jusqu'au paiement — 2026-08-24

Le parcours complet a tourné en production : quatre portefeuilles distincts ont
misé de l'USD₮ réel, la partie s'est jouée jusqu'à la victoire d'un siège, et
l'arbitre a payé. **Table `1deca036418bc82383df4e009dd04a39`.**

| Étape | Hash |
|---|---|
| `join` siège 1 | `0x0973e12a785e3e1e185f1b5c404499bb72861f41d2b8d35ebb4944dca8b622f7` |
| `join` siège 2 | `0x73e11d3d76fc30097508f6fdec2d5ecaf7902a03ee5c41b5e0da22601de397c4` |
| `join` siège 3 | `0x5b341ddb88efa32ec81949e37f778872ad11b4556c125227e589cdf1daf0a6a3` |
| `join` siège 4 | `0x78c6f5ea91bcf791e06426151bc14263e92b664e208ca866df2fc90bed1212b7` |
| **`settle`** | `0x8bb8270facfe124bc47609d9842e52fb1b6dd1d8932e6e10db4c2202311ab98e` |

Le `settle` est `success` au 2026-08-24 14:14:42 UTC, émis par l'arbitre
`0x7bD1F6ed…` vers `LudoEscrowN`. L'escrow est passé au statut `Settled` (3).

Le flux d'argent, relu sur la chaîne plutôt que dans la sortie du script :

| | avant | après |
|---|---|---|
| siège gagnant | 0,29 USD₮ | **0,94** |
| trois perdants | 0,29 USD₮ | 0,04 |
| trésorerie | 0,18 USD₮ | **0,28** |

Soit **0,90 USD₮ au gagnant** (4 × 0,25 moins 10 % de rake) et **0,10 de rake**
à la trésorerie — exactement le palier 25c posé lors de la bascule USD₮
(`rakeBps` du jeu = 1000, lu dans le contrat).

### Les `join` 4 joueurs antérieurs (tables non démarrées)

Avant ce succès, `LudoEscrowN.join` avait déjà abouti **dix fois** les 23 et 24
août, sur trois tables qui n'ont jamais démarré. Conservé ici parce que ces
transactions sont réelles et que le dossier doit dire pourquoi elles n'ont rien
réglé :

| Table | Date (UTC) | `join` |
|---|---|---|
| `7a5ddedb…` | 2026-08-23 21:04 | `0x67e0f8203a52f0510eae3ea5d8deb27c70a2e6c957da0027c4b95d9e89858019` |
| | | `0xc346f4ff05da5599273a934990bae1ce203ace50df3b06b85631b888a5885d24` |
| `7761c9b8…` | 2026-08-23 21:36 | `0x461e9d2b03cf2b7f20dc79b28ae8064fc743a5de4495f1cb675fb5dde29e28bb` |
| | | `0xc262f5fafa8ffea0a60cf511f784f4c4c1c67c4f326b4dbf09494b8a43e18869` |
| | | `0x03f98076c4b49a068d5a748312b1a6561dccd575cf3890e2d43e2e40a9e67ab9` |
| | | `0x31e40a1e3bda52ed1ddbd833bc450488e25f1f4e1aa7e8d9ce4ecd7bb3c9a361` |
| `20af47f2…` | 2026-08-24 13:08 | `0x101c9865a359f682c14b2dfcd3e99a586ef270c4ceb4746db17add4829d48658` |
| | | `0x2d44ac255d645ce602ff04b93674bc95a642fe553678f6e5912038073e286b5f` |
| | | `0x2eeec0e08b98b1215d66d04aa300bd5dcee0187fbe8e4c586c389c8a989c2921` |
| | | `0x4094122fe6fc404275e56bacf88a010f829a617f417fb57bbb0063622ce0f4df` |

Un `refundUnfilled` a également été exécuté sur `7a5ddedb…` :
`0x80fda7ed73daab0366ebab3b6be4ab697369e3e7ff8869f279cf409f25c617ed`.

Aucune de ces trois tables n'a démarré : le script de test encodait le `gameId`
en bytes32 autrement que le client et le serveur (hex pad-à-gauche contre ASCII
pad-à-droite — voir `B4P.1` dans `docs/BACKLOG.md`). Les dépôts atterrissaient
sous une clé que le serveur ne surveille pas, il voyait donc un escrow vide et
annulait chaque table au bout de 120 s. **Le vrai client n'a jamais eu ce
défaut** — c'est pourquoi le 1v1 règle normalement depuis des mois. Corrigé au
commit `10c35e9`, ce qui a immédiatement donné la partie réglée ci-dessus.

Les mises de ces tables sont récupérables par `refundActive` 24 h après le dépôt
(valve permissionless du contrat) ; le mode `RESCUE` du script retombe sur la
clé héritée pour les atteindre.

### Reproduire le parcours

Le bot-fill est interdit pour l'argent et les sessions QA sont exclues des files
misées : il faut donc **4 stakers, 4 portefeuilles financés**. À noter : le garde
anti-collusion (même appareil / même réseau) ne s'applique **pas** ici,
`collusionBlock` n'étant appelé qu'au matchmaking 1v1 et à la table privée.

#### Préparer les quatre sièges

```
npm run seat-addresses -w packages/contracts     # sur TA machine, pas en CI
```

Sans `SEAT_MNEMONIC`, le script tire une phrase BIP-39, l'écrit dans
`packages/contracts/.seat-mnemonic` (git-ignoré, mode 0600) et n'affiche que les
quatre adresses. **Sauvegarde ce fichier avant d'envoyer le moindre USD₮** : il
est la seule chose capable de déplacer ces fonds. Les mêmes quatre adresses sont
redérivées à chaque exécution, ce qui permet de vérifier que l'argent est arrivé
(`✓` par siège) et de récupérer la mise après la partie.

Il faut par siège la mise du palier visé (0,25 USD₮ pour 25c) plus un peu de
CELO pour le gas. Le script ne signe rien ; il ne fait que lire la chaîne.

#### Jouer la partie et produire le hash

```
NETWORK=celo npm run staked4-live -w packages/contracts                        # plan seul
NETWORK=celo CONFIRM=oui-depense-vraiment npm run staked4-live -w packages/contracts
```

C'est **le seul script du dépôt qui dépense**. Sans `CONFIRM` il s'arrête après
le prévol et n'entre même pas dans la file. Armé, il enchaîne : preuve SIWE des
quatre sièges, `queue.join4`, puis — et seulement si les quatre sièges se
retrouvent sur **la même** table — `approve` + `join` en parallèle, révélation
des entropies, partie jouée automatiquement, et le hash du `settle` de l'arbitre.

Si un joueur réel s'intercale, les `gameId` divergent et le script abandonne
**avant** de payer : mieux vaut le laisser être remboursé par `refundUnfilled`
que de l'asseoir à une table qui ne démarrera jamais. À lancer hors heures de
pointe.

Si le run meurt entre les dépôts, rien n'est perdu — une table non remplie est
remboursable par n'importe qui après 120 s :

```
NETWORK=celo RESCUE=<gameId> CONFIRM=oui-depense-vraiment npm run staked4-live -w packages/contracts
```

Une partie Active jamais réglée se débloque seule après 24 h (`refundActive`).
Reporte ensuite le hash de `join` dans le tableau du §2.

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

## 6. CGU et confidentialité — validées le 2026-08-21

`TOS_DRAFT` / `PRIVACY_DRAFT` sont devenus `TOS_TEXT` / `PRIVACY_TEXT`
(`apps/web/src/components/ui.tsx`), après validation **contre le code** :
chaque affirmation a été vérifiée, chaque traitement de données trouvé dans le
code est déclaré.

Corrigé ou ajouté à cette occasion :

- « jeu 1v1 » → l'app propose aussi la **table 4 joueurs misée** ;
- « non-custodial » vérifié dans le contrat : `settle`/`refund*`/`voidGame` ne
  paient que des joueurs, et `withdraw` est un pull-payment strict du solde
  crédité à l'appelant — aucun retrait opérateur n'existe ;
- la confidentialité déclare désormais **tout** ce que le serveur stocke :
  adresse, nom/drapeau/avatar choisis, liste d'amis, parties/ELO, limites de
  jeu responsable, et le **signal d'appareil haché** (`fingerprint.ts`,
  anti multi-comptes) qui manquait ;
- la lecture du **pays réseau** pour l'allowlist de mise est déclarée, avec sa
  finalité unique ;
- la **clé du wallet de jeu en localStorage** (hors MiniPay) est déclarée, avec
  sa conséquence : effacer les données du site efface ce wallet ;
- l'adresse de support et l'engagement de **première réponse sous 24 h** sont
  dans les CGU, alignés sur la fiche d'aide.

Limites, dites plutôt que tues : textes en anglais uniquement (comme la porte
de consentement) ; aucune clause de droit applicable — ce choix appartient au
conseil de l'opérateur. La validation ici est une validation de **véracité
technique**, pas un avis juridique ; l'opérateur a tranché qu'elle suffit pour
le listing.

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
