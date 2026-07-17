# Arbiter key custody (R-KEY-1) — runbook

**Status: ops task, NOT closed in code.** This document is the design + checklist
to close it before mainnet. It is written for a human operator to execute; the
server code does not — and cannot — set up a KMS by itself.

## The risk

Today a single hot `ARBITER_PRIVATE_KEY` (a plaintext Fly secret) both **signs
every settlement** and, on the current deployment, is the **treasury + owner** of
the escrow. A compromise of that one key lets the holder:

- sign `settle(gameId, attacker)` for any game they can seat in → drain pots;
- redirect the rake (treasury);
- (owner) change escrow parameters.

The always-on server process holds it in memory to sign. That is the exposure.

## Target design — split signer from submitter

```
  game result ──► [Signer]  (holds the key, offline-ish, KMS-backed)
                     │  returns only a signature over
                     │  keccak256(chainid, escrow, gameId, winner)
                     ▼
                 [Submitter] (hot, no signing key) ──► escrow.settle(gameId, winner, sig)
                     │  pays gas from a SEPARATE, low-value gas wallet
                     ▼
                  chain
```

- **Signer**: the arbiter private key lives in a **KMS / HSM** (AWS KMS, GCP KMS,
  or a cloud HSM). It exposes a *sign-digest* operation only — the raw key is never
  exported to the app. The digest is exactly what `Arbiter.signSettlement` builds
  today: `keccak256(abi.encode(chainid, escrow, gameId, winner))`, EIP-191. Access
  is authenticated (IAM role) and **rate-limited + audit-logged**.
- **Submitter**: the always-on server holds **no signing key**. It calls the signer
  for a signature, then submits the tx and pays gas from a **separate gas wallet**
  funded with only enough native token for fees. A compromise of the box leaks the
  gas wallet (cheap to rotate), not the arbiter key.

The on-chain contract already supports this split unchanged: `settle` takes the
signature as a parameter and recovers the arbiter address — it does not care
whether the signer and submitter are the same EOA.

## Migration steps (checklist)

1. **Separate the owner/treasury from the arbiter.** Redeploy (or `setOwner` /
   `setTreasury` if available) so the settlement signer is NOT also the treasury or
   owner. Least privilege: the signer should only be able to move funds *to the
   players*, which `settle`/`voidGame`/`refund*` already enforce.
2. **Provision the KMS key** and grant the signer service a sign-only IAM role.
   Import or generate the arbiter key inside the KMS; never let it touch disk.
3. **Introduce a `Signer` interface** in `apps/server/src/settlement.ts` so
   `Arbiter` depends on `sign(digest) → sig` instead of a local `privateKeyToAccount`.
   Provide two impls: `LocalSigner` (current behaviour, dev/testnet) and
   `KmsSigner` (prod). This is a small, well-scoped code change — do it as its own
   PR with a test that both signers produce the SAME signature for a fixed digest.
4. **Fund + monitor the gas wallet** separately (the existing gas-balance monitor
   already alerts; point it at the gas wallet).
5. **Rotate + alarm.** Document a key-rotation procedure and alarm on any signer
   call whose `(gameId, winner)` was not produced by a real finished game.

## Interim mitigations already in place (not a substitute)

- `refundActive` (24 h permissionless) returns stakes if the arbiter goes dark.
- On-chain depositor reconciliation (R-SETTLE-3 / G-4) means a stolen key still
  cannot pay a winner who never deposited (`settle` reverts `NotAPlayer`).
- Gas-balance monitor + ops alerts on settlement failure.

These bound the blast radius; they do not remove the single-hot-key exposure. The
split above is the fix, and it is a **human/ops task**.
