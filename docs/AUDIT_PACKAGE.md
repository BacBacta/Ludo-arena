# AUDIT_PACKAGE.md — Smart-contract audit dossier (Phase 2)

> Prepared for an **external human auditor**. This package does NOT replace that
> audit — it is the material to accelerate it. An independent audit remains a
> hard pre-mainnet requirement (see [TESTING_REPORT.md](../TESTING_REPORT.md)).
>
> Scope: `packages/contracts/src/` on branch `test/pre-launch-campaign`.
> Toolchain: Foundry (solc 0.8.24, optimizer 200) + Slither. Testnet: Celo Sepolia.

## 1. Contracts in scope

| Contract | Holds funds? | Role |
|---|---|---|
| `LudoEscrow.sol` | **Yes** | 1v1 stake escrow (the LIVE staked mode). Two players lock equal stakes; the arbiter signs the single winner. Pull-payment (C3) after the R-ESCROW-1 fix. |
| `LudoEscrowN.sol` | **Yes** | 2–4-seat generalisation (staked M9). Same trust model + pull-payment. |
| `CosmeticsStore.sol` | No (pass-through) | `buy(itemId)` pulls the price straight to the treasury; never rests funds. |
| `MockUSDT.sol`, `TestUSD.sol` | Faucets | Open-mint **testnet-only** stand-ins (6- and 18-decimal). Never for mainnet. |

## 2. Trust model & authorization

- **Off-chain outcome, on-chain custody.** The contracts never see dice/moves. The
  winner is whoever the server's **arbiter key** signs: an EIP-191 signature over
  `keccak256(abi.encode(chainid, escrow, gameId, winner))`. This is the SOLE
  authorization the contract trusts for a payout.
- **Bounded arbiter power.** The arbiter can only ever name a **depositor** as
  winner (`NotAPlayer` otherwise) and can only `voidGame` an Active game back to
  its depositors. It can never divert funds to a non-participant.
- **Governance.** `owner` (defaults to `treasury`) can set the rake within a hard
  ceiling `MAX_RAKE_BPS = 10%` and allowlist stablecoins. Rake is **snapshotted at
  game creation** so a mid-game change can't re-price a settled pot.
- **Safety valves.** `refundExpired`/`refundUnfilled` (lone/unfilled after
  `JOIN_TIMEOUT` 120 s) and a permissionless `refundActive` (after `ACTIVE_TIMEOUT`
  24 h) guarantee funds are recoverable even if the arbiter key is lost.

## 3. Invariants (fuzz-verified)

`test/InvariantEscrow.t.sol`, `test/InvariantEscrowN.t.sol` — StdInvariant handler
campaigns driving bounded random `join/settle/refund/void/withdraw/warp`
interleavings (128 runs × 250 depth locally; 256 × 500 in the `ci` profile).

- **`invariant_solvent` (master money invariant):** the escrow's token balance
  ALWAYS equals the stakes locked in open games (Filling/Active) **plus** every
  credited-but-unwithdrawn amount. This single equality subsumes *the pot is never
  distributed twice*, *sum of outputs ≤ sum of inputs*, *no value creation*, and
  *credits are always fully backed*. Result: 128 000 calls, **0 reverts, 0
  violations** for both escrows.
- **`invariant_resolvedGamesReleaseFunds`:** a Settled/Refunded game holds no
  locked funds of its own (terminal state machine).

Additional targeted fuzz (`test/FuzzAuthorization.t.sol`, 256 runs each):

- **Only the arbiter signature settles** — any other signer → `BadSignature`, pot
  untouched (`testFuzz_onlyArbiterSignatureSettles`).
- **Arbiter can't pay a non-depositor** — signature over any stranger → `NotAPlayer`
  (`testFuzz_arbiterCannotPayANonDepositor`).
- **A player withdraws only their OWN credit** — another account's `withdraw`
  reverts `NothingToWithdraw` (`testFuzz_withdrawOnlyOwnCredit`).

Plus the pre-existing property fuzz `testFuzz_PayoutPlusRakeEqualsPot` (payout +
rake == pot for any stake/rake).

## 4. Test coverage summary

| Layer | Files | Result |
|---|---|---|
| Unit | `LudoEscrow.t.sol` (18), `LudoEscrowN.t.sol` (25), `CosmeticsStore.t.sol` (9) | full lifecycle, guards, refunds, governance, batch |
| Adversarial | `Adversarial.t.sol` (13), `AdversarialN.t.sol` (5) | no-return USDT, fee-on-transfer (allowlist), reentrancy, **C3 blacklist pay-or-credit** (both escrows) |
| Invariant | `InvariantEscrow.t.sol` (1), `InvariantEscrowN.t.sol` (2) | solvency across 128k random calls |
| Authorization fuzz | `FuzzAuthorization.t.sol` (3) | arbiter-only, depositor-only, own-credit-only |
| Fork | `ForkCeloSepolia.t.sol` (2) | join/settle + refund vs the **real deployed MockUSDT** (6-dec) on a Celo Sepolia fork |

**Total: 78 forge tests, 0 failing.** Run: `forge test` (fork tests self-skip
unless `CELO_SEPOLIA_RPC` is set).

## 5. Static analysis (Slither)

`slither src/` — **34 results, all triaged; none is a vulnerability in the money
path.** Dispositions:

| Detector | Where | Disposition |
|---|---|---|
| `reentrancy-no-eth`, `reentrancy-events` | escrow `_settle`/`_refundBoth`/`_refundAll` | **Justified (safe).** CEI: `status` is set to the terminal value BEFORE any transfer, so a re-entrant call reverts (`BadStatus`). Only owner-allowlisted, non-callback stablecoins are ever the token (no ERC777 hooks). Proven by `testReentrantToken_NoDoublePay`. |
| `calls-loop` | `LudoEscrowN._refundAll` | **Justified.** The C3 pay-or-credit loop uses the non-reverting `_tryTransfer`; one bad recipient can't abort the batch, and allowlisted tokens bound gas. |
| `low-level-calls` | `_safeTransfer`/`_safeTransferFrom`/`_tryTransfer` | **Justified (intentional).** SafeERC20-style `.call` to tolerate non-bool-returning tokens (canonical USDT). Return data is decoded and checked. |
| `timestamp` | `refundExpired`/`refundUnfilled`/`refundActive` | **Justified.** Timeouts are 120 s / 24 h; a miner's few-second timestamp nudge is irrelevant at that scale. |
| `missing-zero-check` | `CosmeticsStore` ctor + `setToken` | **Justified (low).** Owner-only; a zero token merely makes `buy()` revert until the owner calls `setToken` again. No funds at risk (the store never rests funds). |
| `missing-inheritance` | `MockUSDT`, `TestUSD` | **Justified.** Testnet faucets; they implement the ERC20 surface the escrow uses without a formal `is IERC20`. Not deployed to mainnet. |
| `naming-convention`, `unindexed-event-address` | `CosmeticsStore` | **Cosmetic.** No security impact. |

Full output: run `slither src/ --solc-remaps "forge-std/=lib/forge-std/src/"`.

## 6. Security checklist (audit brief)

- **Reentrancy** — CEI everywhere (status set before transfers); the `withdraw`
  path zeroes the credit before transferring. Test: `testReentrantToken_NoDoublePay`.
- **Access control** — arbiter (immutable) is the only settle/void authority;
  owner-only governance (`onlyOwner`); allowlist gates tokens. Fuzz-verified.
- **Front-running** — `settle` is idempotent (once-only state machine); a front-run
  `settle` with the same signature just wins the race with an identical result. The
  gameId is a 128-bit server secret. Residual: **permissionless `join`** lets a
  stranger who learns a gameId squat a seat — mitigated **server-side** (the stake
  gate verifies on-chain depositors == matched players before dealing, R-SETTLE-3),
  and any stranded stake is auto-recovered (R-SETTLE-1) or `refundActive`-able.
- **Oracle/result manipulation** — the only "oracle" is the arbiter signature; the
  contract enforces winner ∈ depositors and rejects malleable signatures
  (high-`s`/non-{27,28}-`v`). Fuzz: `testFuzz_onlyArbiterSignatureSettles`.
- **ERC-20 transfer-failure handling** — SafeERC20-style for no-return tokens;
  **pay-or-credit** so a blacklisted/frozen recipient (USDT/USDC) is credited for
  later `withdraw` instead of locking everyone's funds (C3, both escrows). Allowlist
  keeps fee-on-transfer/rebasing tokens out.

## 7. Residual items for the human auditor / ops (NOT closed here)

1. **Arbiter key custody (R-KEY-1).** A single hot key signs every payout AND is
   `treasury`+`owner` on the current deployment. Move to KMS + split signer/submitter
   before mainnet. On-chain mitigations (`refundActive`, bounded arbiter power) limit
   but don't remove the risk.
2. **Redeploy (R-DEPLOY-1).** The pull-payment `LudoEscrow` (R-ESCROW-1) and the
   post-C3 `LudoEscrowN` must be (re)deployed; the currently-deployed testnet
   bytecode predates these fixes.
3. **Fee-currency / gas on Celo.** Not exercised here; confirm the arbiter can pay
   gas in the fee currency at settle time.
4. **Formal review of the EIP-191 digest** binding `chainid`+`escrow` (replay across
   deployments) — believed sound; worth an auditor's explicit sign-off.

## 8. Deployment (testnet)

Celo Sepolia (`deployments.json`): escrow `0x5b2d…41d4`, escrowN `0x8d7a…3a80`,
MockUSDT `0x862F…5897` (6-dec), arbiter == treasury `0x947F…951B`, rake 900 bps.
**No Celo mainnet deployment exists.**
