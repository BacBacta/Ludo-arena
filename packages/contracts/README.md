# @ludo/contracts

Ludo Arena Solidity contracts.

## Deployment (E3.1) — solc + viem, no Foundry needed

```bash
# local validation (hardhat node + full join/settle/refund smoke test)
npm run node -w packages/contracts        # terminal 1: local chain
npm run smoke -w packages/contracts      # terminal 2: full-flow assertions
NETWORK=localhost npm run deploy -w packages/contracts

# public testnet
cp packages/contracts/.env.example packages/contracts/.env
# fill DEPLOYER_PRIVATE_KEY (funded via faucet) + NETWORK (sepolia | celo-sepolia | alfajores)
npm run deploy -w packages/contracts
```

Addresses land in `deployments.json` (keyed by network). On chains without cUSD
(e.g. Ethereum Sepolia) the script deploys `TestUSD`, an open-faucet test
stablecoin — never use it on mainnet. The deploy script verifies the on-chain
immutables (arbiter, treasury, rakeBps) after deployment.

## Foundry tests (optional toolchain)

```bash
# Prerequisite: foundryup (https://getfoundry.sh)
forge install foundry-rs/forge-std   # first time
forge build
forge test -vv
```

Note: `test/LudoEscrow.t.sol` depends on forge-std (installed by `forge install`, not versioned).
The same flows are covered without Foundry by `script/smoke.ts` against a local node.
See `docs/SMART_CONTRACTS.md` at the repo root for lifecycle, invariants and v1 limits.
