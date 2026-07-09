# @ludo/contracts

Contrats Solidity de Ludo Arena (Foundry).

```bash
# Prérequis : foundryup (https://getfoundry.sh)
forge install foundry-rs/forge-std   # première fois
forge build
forge test -vv
```

Note : `test/LudoEscrow.t.sol` dépend de forge-std (installé par `forge install`, non versionné).
Voir `docs/SMART_CONTRACTS.md` à la racine pour le cycle de vie, les invariants et les limites v1.
Ce package n'est pas branché sur `npm run typecheck` (toolchain séparée Foundry) — la CI contrats est à ajouter (BACKLOG E3).
