# Ludo Arena — requêtes Dune (Celo mainnet)

Analytics on-chain pour les candidatures écosystème (MiniPay builder program, Proof of Ship)
et le suivi produit. Toutes les requêtes sont en **DuneSQL** (moteur Trino) et travaillent sur
les **logs bruts** : les contrats Ludo Arena ne sont pas soumis au décodeur de Dune, donc il
n'existe pas de tables `ludo_arena_celo.*`. Rien à compléter — adresses et `topic0` sont réels.

> Pour obtenir des tables décodées (plus lisibles, et jointes automatiquement), soumets les
> contrats sur https://dune.com/contracts/new avec leur ABI. Les requêtes ci-dessous
> continueront de fonctionner ; elles n'en dépendent pas.

## Constantes vérifiées

| Rôle | Adresse | Source |
|---|---|---|
| Escrow 1v1 | `0xabdfea03be58d3276b13b40885311d84259d7f4d` | `deployments.json` → `celo.escrow` |
| Escrow 4 joueurs | `0x0142dd7125e339dcbccbb4e2fc7b28c09d21fc6e` | `celo.escrowN` |
| Boutique cosmétiques | `0x423442b6b78423ca8970ee1b92f85236d9194c6f` | `celo.cosmeticsStore` |
| RacePass (ERC-721) | `0x3ca68b8a7e2c429dec33a34e0589173dfb305be4` | `celo.racePass` |
| cUSD (mise, 18 déc.) | `0x765de816845861e75a25fca122bb6898b8b1282a` | `celo.stablecoin` |
| Arbitre (règlement) | `0x7bd1f6ed68adbc39cf7902151a53811a4f92be78` | `celo.arbiter` |
| Trésorerie (rake) | `0x947fa33c5a2157bc3618cc7b66a32a3a4b14951b` | `celo.treasury` |

`topic0` — keccak256 des signatures réelles (`packages/contracts/src/*.sol`) :

| Événement | `topic0` |
|---|---|
| `Joined(bytes32,address,address,uint96)` (1v1) | `0x18442e54262aca08a82297b67d1fd039028391053f441ac73f120c308648a83d` |
| `Joined(bytes32,address,address,uint96,uint8,uint8)` (4p) | `0xaa85d23f66243b37ec3fc663a4c15664fc76571aaefbe022178dae0bdefdba1b` |
| `Settled(bytes32,address,uint256,uint256)` | `0xe0ecb67aeade448be9222cf6735d02379e767bc18410573312005e0168f7dda5` |
| `Refunded(bytes32)` | `0xfe509803c09416b28ff3d8f690c8b0c61462a892c46d5430c8fb20abe472daf0` |
| `Minted(address,uint256)` (RacePass) | `0x30385c845b448a36257a6a1716e6ad2e1bc2cbe333cde1e69fe849ad6511adfe` |
| `Purchased(address,bytes32,uint256)` | `0x530fb329493818a269f9d8e7334df675eaf528af1cb867ab5c9ced431d196329` |

**Rappel de décodage.** Un argument `indexed` vit dans `topic1..3` ; les autres sont concaténés
dans `data` par mots de 32 octets. Une adresse occupe les 20 derniers octets de son mot, d'où
`bytearray_substring(x, 13, 20)`. `bytearray_substring` est **indexé à 1**.

---

## Q1 — Activité on-chain globale (le chiffre « Proof of Ship »)

Transactions et portefeuilles uniques touchant le protocole, par jour. C'est le graphe à mettre
en tête du dashboard : il répond directement à « quelle activité on-chain générez-vous ? ».

```sql
WITH ludo_contracts AS (
    SELECT contract_address FROM (VALUES
        (0xabdfea03be58d3276b13b40885311d84259d7f4d),  -- escrow 1v1
        (0x0142dd7125e339dcbccbb4e2fc7b28c09d21fc6e),  -- escrow 4p
        (0x423442b6b78423ca8970ee1b92f85236d9194c6f),  -- cosmetics store
        (0x3ca68b8a7e2c429dec33a34e0589173dfb305be4)   -- race pass
    ) AS t(contract_address)
)
SELECT
    date_trunc('day', t.block_time)          AS day,
    count(*)                                 AS txs,
    count(DISTINCT t."from")                 AS unique_wallets,
    count(*) FILTER (WHERE t.success)        AS txs_ok
FROM celo.transactions t
JOIN ludo_contracts c ON t."to" = c.contract_address
WHERE t.block_time >= TIMESTAMP '2026-07-20'   -- déploiement mainnet
GROUP BY 1
ORDER BY 1;
```

Variante « compteurs » pour les 4 tuiles de tête du dashboard :

```sql
WITH ludo_contracts AS (
    SELECT contract_address FROM (VALUES
        (0xabdfea03be58d3276b13b40885311d84259d7f4d),
        (0x0142dd7125e339dcbccbb4e2fc7b28c09d21fc6e),
        (0x423442b6b78423ca8970ee1b92f85236d9194c6f),
        (0x3ca68b8a7e2c429dec33a34e0589173dfb305be4)
    ) AS t(contract_address)
)
SELECT
    count(*)                                                     AS total_txs,
    count(DISTINCT t."from")                                     AS total_wallets,
    count(DISTINCT date_trunc('day', t.block_time))              AS active_days,
    min(t.block_time)                                            AS first_tx
FROM celo.transactions t
JOIN ludo_contracts c ON t."to" = c.contract_address;
```

---

## Q2 — Parties misées : volume et joueurs

Chaque `Joined` est **un joueur qui verrouille sa mise**. Une partie 1v1 en produit deux :
`games ≈ joins / 2` (le `count(DISTINCT game_id)` ci-dessous est exact, lui).

```sql
WITH joins AS (
    SELECT
        l.block_time,
        l.tx_hash,
        l.topic1                                                   AS game_id,
        bytearray_substring(l.topic2, 13, 20)                      AS player,
        bytearray_substring(bytearray_substring(l.data, 1, 32), 13, 20) AS token,
        bytearray_to_uint256(bytearray_substring(l.data, 33, 32))   AS stake_raw,
        '1v1'                                                      AS mode
    FROM celo.logs l
    WHERE l.contract_address = 0xabdfea03be58d3276b13b40885311d84259d7f4d
      AND l.topic0 = 0x18442e54262aca08a82297b67d1fd039028391053f441ac73f120c308648a83d

    UNION ALL

    SELECT
        l.block_time,
        l.tx_hash,
        l.topic1,
        bytearray_substring(l.topic2, 13, 20),
        bytearray_substring(bytearray_substring(l.data, 1, 32), 13, 20),
        bytearray_to_uint256(bytearray_substring(l.data, 33, 32)),
        '4p'
    FROM celo.logs l
    WHERE l.contract_address = 0x0142dd7125e339dcbccbb4e2fc7b28c09d21fc6e
      AND l.topic0 = 0xaa85d23f66243b37ec3fc663a4c15664fc76571aaefbe022178dae0bdefdba1b
)
SELECT
    date_trunc('day', block_time)          AS day,
    mode,
    count(DISTINCT game_id)                AS games,
    count(*)                               AS stake_locks,
    count(DISTINCT player)                 AS unique_players,
    sum(stake_raw) / 1e18                  AS volume_cusd
FROM joins
GROUP BY 1, 2
ORDER BY 1, 2;
```

> `1e18` = cUSD (18 décimales). **Après la migration USD₮ (tâche #19), le token de mise
> passe à 6 décimales** : il faudra diviser par `1e6` pour les lignes dont `token` est
> l'adresse USD₮, sinon le volume sera surestimé d'un facteur 10¹². La colonne `token` est
> déjà extraite pour permettre ce `CASE`.

---

## Q3 — Règlements, gains versés et revenu du protocole (rake)

```sql
SELECT
    date_trunc('day', l.block_time)                              AS day,
    count(*)                                                     AS games_settled,
    count(DISTINCT bytearray_substring(l.topic2, 13, 20))        AS unique_winners,
    sum(bytearray_to_uint256(bytearray_substring(l.data, 1, 32))) / 1e18  AS payouts_cusd,
    sum(bytearray_to_uint256(bytearray_substring(l.data, 33, 32))) / 1e18 AS rake_cusd
FROM celo.logs l
WHERE l.contract_address IN (
        0xabdfea03be58d3276b13b40885311d84259d7f4d,
        0x0142dd7125e339dcbccbb4e2fc7b28c09d21fc6e)
  AND l.topic0 = 0xe0ecb67aeade448be9222cf6735d02379e767bc18410573312005e0168f7dda5
GROUP BY 1
ORDER BY 1;
```

Parties remboursées (abandon avant règlement) — utile pour surveiller la santé du matchmaking :

```sql
SELECT date_trunc('day', block_time) AS day, count(*) AS refunds
FROM celo.logs
WHERE contract_address IN (
        0xabdfea03be58d3276b13b40885311d84259d7f4d,
        0x0142dd7125e339dcbccbb4e2fc7b28c09d21fc6e)
  AND topic0 = 0xfe509803c09416b28ff3d8f690c8b0c61462a892c46d5430c8fb20abe472daf0
GROUP BY 1 ORDER BY 1;
```

---

## Q4 — Nouveaux entrants Race Week (mints du Pass)

Le RacePass est **soulbound et 1 par portefeuille** : un mint = **un nouveau joueur réel**.
C'est la meilleure métrique d'acquisition dont tu disposes on-chain.

```sql
SELECT
    date_trunc('day', block_time)                          AS day,
    count(*)                                               AS passes_minted,
    count(DISTINCT bytearray_substring(topic1, 13, 20))    AS unique_holders,
    sum(count(*)) OVER (ORDER BY date_trunc('day', block_time)) AS cumulative
FROM celo.logs
WHERE contract_address = 0x3ca68b8a7e2c429dec33a34e0589173dfb305be4
  AND topic0 = 0x30385c845b448a36257a6a1716e6ad2e1bc2cbe333cde1e69fe849ad6511adfe
GROUP BY 1
ORDER BY 1;
```

---

## Q5 — Entonnoir d'activation : Pass minté → première mise → partie réglée

La requête qui vaut le plus dans une candidature : elle montre la **conversion**, pas juste le
volume. Elle révèle aussi immédiatement une panne d'entrée (mints sans mises qui suivent).

```sql
WITH minted AS (
    SELECT
        bytearray_substring(topic1, 13, 20) AS wallet,
        min(block_time)                     AS minted_at
    FROM celo.logs
    WHERE contract_address = 0x3ca68b8a7e2c429dec33a34e0589173dfb305be4
      AND topic0 = 0x30385c845b448a36257a6a1716e6ad2e1bc2cbe333cde1e69fe849ad6511adfe
    GROUP BY 1
),
staked AS (
    SELECT
        bytearray_substring(topic2, 13, 20) AS wallet,
        min(block_time)                     AS first_stake_at,
        count(*)                            AS stakes
    FROM celo.logs
    WHERE contract_address IN (
            0xabdfea03be58d3276b13b40885311d84259d7f4d,
            0x0142dd7125e339dcbccbb4e2fc7b28c09d21fc6e)
      AND topic0 IN (
            0x18442e54262aca08a82297b67d1fd039028391053f441ac73f120c308648a83d,
            0xaa85d23f66243b37ec3fc663a4c15664fc76571aaefbe022178dae0bdefdba1b)
    GROUP BY 1
),
won AS (
    SELECT DISTINCT bytearray_substring(topic2, 13, 20) AS wallet
    FROM celo.logs
    WHERE contract_address IN (
            0xabdfea03be58d3276b13b40885311d84259d7f4d,
            0x0142dd7125e339dcbccbb4e2fc7b28c09d21fc6e)
      AND topic0 = 0xe0ecb67aeade448be9222cf6735d02379e767bc18410573312005e0168f7dda5
)
SELECT
    count(*)                                                   AS passes_minted,
    count(s.wallet)                                            AS reached_first_stake,
    count(w.wallet)                                            AS reached_a_win,
    round(100.0 * count(s.wallet) / nullif(count(*), 0), 1)    AS pct_activated,
    round(avg(date_diff('minute', m.minted_at, s.first_stake_at))
          FILTER (WHERE s.wallet IS NOT NULL), 1)              AS avg_min_to_first_stake
FROM minted m
LEFT JOIN staked s ON s.wallet = m.wallet
LEFT JOIN won    w ON w.wallet = m.wallet;
```

---

## Q6 — Joueurs actifs par jour et rétention

```sql
WITH activity AS (
    SELECT
        date_trunc('day', block_time)       AS day,
        bytearray_substring(topic2, 13, 20) AS wallet
    FROM celo.logs
    WHERE contract_address IN (
            0xabdfea03be58d3276b13b40885311d84259d7f4d,
            0x0142dd7125e339dcbccbb4e2fc7b28c09d21fc6e)
      AND topic0 IN (
            0x18442e54262aca08a82297b67d1fd039028391053f441ac73f120c308648a83d,
            0xaa85d23f66243b37ec3fc663a4c15664fc76571aaefbe022178dae0bdefdba1b)
),
firsts AS (SELECT wallet, min(day) AS cohort_day FROM activity GROUP BY 1)
SELECT
    a.day,
    count(DISTINCT a.wallet)                                              AS dau,
    count(DISTINCT a.wallet) FILTER (WHERE f.cohort_day = a.day)          AS new_players,
    count(DISTINCT a.wallet) FILTER (WHERE f.cohort_day < a.day)          AS returning_players
FROM activity a
JOIN firsts f ON f.wallet = a.wallet
GROUP BY 1
ORDER BY 1;
```

---

## Q7 — Achats de cosmétiques (revenu hors rake)

```sql
SELECT
    date_trunc('day', block_time)                          AS day,
    count(*)                                               AS purchases,
    count(DISTINCT bytearray_substring(topic1, 13, 20))    AS unique_buyers,
    sum(bytearray_to_uint256(bytearray_substring(data, 1, 32))) / 1e18 AS revenue_cusd
FROM celo.logs
WHERE contract_address = 0x423442b6b78423ca8970ee1b92f85236d9194c6f
  AND topic0 = 0x530fb329493818a269f9d8e7334df675eaf528af1cb867ab5c9ced431d196329
GROUP BY 1
ORDER BY 1;
```

---

## Deux avertissements à ne pas ignorer

1. **Le house bot est un portefeuille à toi** (`0xB64E07eEa5D478A8d97B9123d4e8b4AbdE0190e0`).
   Ses mises apparaissent on-chain comme celles de n'importe qui. Pour publier des chiffres
   honnêtes de joueurs réels, exclus-le — sinon tu comptes ton propre bot comme utilisateur :

   ```sql
   AND bytearray_substring(topic2, 13, 20) != 0xb64e07eea5d478a8d97b9123d4e8b4abde0190e0
   ```

   Idem pour le faucet Race (`0x8b9EFf52FB213f0d0ddca955abcfe89adA077f6F`) dans toute
   analyse de transferts cUSD : ses transferts sont des subventions, pas de l'activité joueur.

2. **La couverture Celo de Dune est à vérifier avant de publier.** Lance d'abord
   `SELECT max(block_time) FROM celo.logs` : si l'indexation retarde, ton dashboard affichera
   un plateau qui ressemblera à un arrêt d'activité. Ne présente pas un tel graphe sans avoir
   vérifié ce point.
