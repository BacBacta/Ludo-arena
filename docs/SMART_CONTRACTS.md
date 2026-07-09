# Smart contracts

## LudoEscrow.sol

Minimal escrow for staked 1v1 games in stablecoins (cUSD/USDC/USDT on Celo).

### Lifecycle

1. The server creates the game off-chain and provides a `gameId` (unique bytes32) + token + stake.
2. Each player calls `join(gameId, token, stake)` (after `approve`). The contract locks both stakes.
3. Game end: the arbiter (server key) signs `(gameId, winner)` and anyone can submit `settle(gameId, winner, signature)`. The contract pays `pot - rake` to the winner and the rake to the treasury.
4. If the opponent never joins: `refundExpired(gameId)` refunds after `JOIN_TIMEOUT`.

### Invariants

- The contract can NEVER pay out more than the locked pot.
- The rake is capped at 10 % (constant, immutable without redeploy).
- The arbiter cannot steal funds: it can only designate one of the two players as winner.
- A `gameId` can only be settled once.

### Known limits (v1, accepted)

- The arbiter is a central trust point (it could designate the wrong winner). Mitigation: public commit-reveal fairness + signed logs + reputation. Possible v2: arbiter network or game proofs.
- No on-chain 4-player games in v1.

### Deployment

Foundry. `forge build`, `forge test`, then `forge script script/Deploy.s.sol --rpc-url $ALFAJORES_RPC --broadcast`.
Per-network addresses in `deployments.json` (E3.1).
