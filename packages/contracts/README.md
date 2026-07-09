# @ludo/contracts

Ludo Arena Solidity contracts (Foundry).

```bash
# Prerequisite: foundryup (https://getfoundry.sh)
forge install foundry-rs/forge-std   # first time
forge build
forge test -vv
```

Note: `test/LudoEscrow.t.sol` depends on forge-std (installed by `forge install`, not versioned).
See `docs/SMART_CONTRACTS.md` at the repo root for lifecycle, invariants and v1 limits.
This package is not wired into `npm run typecheck` (separate Foundry toolchain) — contracts CI is still to add (BACKLOG E3).
