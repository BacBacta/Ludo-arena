/**
 * Adaptive fee policy for feeCurrency (CIP-64) transactions from tiny-balance
 * burner wallets. A lock tx must satisfy FOUR node checks at once:
 *
 *   C1  maxFeePerGas >= base fee at mine time          (cap too low → rejected)
 *   C2  gas estimation must not apply an affordability cap computed on the
 *       NATIVE balance (0 for a burner)                 ("allowance (0)")
 *   C3  gasLimit >= real usage + CIP-64 intrinsic (~50k for the in-tx cUSD fee
 *       debit/credit)                                   (OOG → mined revert)
 *   C4  RESERVATION gasLimit × maxFeePerGas + value <= balance
 *                                                        ("total cost exceeds")
 *
 * C1 and C4 pull in OPPOSITE directions: a wide cap survives base-fee spikes
 * but inflates the reservation past a ~10¢ balance; a thin cap fits the balance
 * but dies on a spike. No fixed setting satisfies both in every regime, so the
 * lock ladders through plans, moving AFTER a classified failure:
 *
 *   balanced ──cap-too-low──▶ high-cap        (spike: pay for certainty)
 *   any      ──exceeds-balance──▶ thrifty     (tiny balance: cheapest viable tx)
 *   any      ──oog──▶ same plan, more gas     (limit was short, fees were fine)
 *
 * Every plan keeps cap = baseFee×mult + priority with mult >= 1 and priority>0,
 * so C1 holds BY CONSTRUCTION at estimate time on every rung; the fresh
 * base-fee re-read on each attempt covers drift.
 */

const GWEI = 1_000_000_000n;

export interface FeePlan {
  name: 'balanced' | 'high-cap' | 'thrifty';
  /** maxFeePerGas = baseFee × capMultiplier + priorityWei */
  capMultiplier: bigint;
  priorityWei: bigint;
  /** gasLimit = estimate × gasPadPercent/100 + gasHeadroom */
  gasPadPercent: bigint;
  /** CIP-64 intrinsic margin (the fee-less estimate can't see the in-tx fee
   *  debit/credit). Never below 60k — the protocol intrinsic is ~50k. */
  gasHeadroom: bigint;
}

/** Opening plan: enough spike margin for normal conditions, reservation small
 *  enough for a ~10¢ wallet at typical base fees. */
export const BALANCED: FeePlan = { name: 'balanced', capMultiplier: 2n, priorityWei: 2n * GWEI, gasPadPercent: 130n, gasHeadroom: 100_000n };
/** After a cap-too-low reject: the base fee is spiking — pay for certainty. */
export const HIGH_CAP: FeePlan = { name: 'high-cap', capMultiplier: 4n, priorityWei: 3n * GWEI, gasPadPercent: 130n, gasHeadroom: 100_000n };
/** After an exceeds-balance reject: the cheapest tx that can still mine now. */
export const THRIFTY: FeePlan = { name: 'thrifty', capMultiplier: 15n, priorityWei: 1n * GWEI, gasPadPercent: 115n, gasHeadroom: 60_000n };
/** THRIFTY's multiplier is in TENTHS (1.5×) — bigint can't carry 1.5. */
export const THRIFTY_CAP_TENTHS = true;

export function planCapWei(plan: FeePlan, baseFeePerGas: bigint): bigint {
  const scaled = plan.name === 'thrifty' ? (baseFeePerGas * plan.capMultiplier) / 10n : baseFeePerGas * plan.capMultiplier;
  return scaled + plan.priorityWei;
}

export function planGasLimit(plan: FeePlan, estimate: bigint): bigint {
  return (estimate * plan.gasPadPercent) / 100n + plan.gasHeadroom;
}

/** The cUSD the node RESERVES for this tx (fee part), in wei-of-fee-currency
 *  terms — the quantity C4 compares against the balance. */
export function planReservationWei(plan: FeePlan, estimate: bigint, baseFeePerGas: bigint): bigint {
  return planGasLimit(plan, estimate) * planCapWei(plan, baseFeePerGas);
}

export type TxFailure = 'cap-too-low' | 'exceeds-balance' | 'oog' | 'rejected' | 'other';

/** Classify a lock failure from the raw error text — the four REAL incident
 *  messages of the launch (verbatim in the tests) plus the user rejection. */
export function classifyTxFailure(e: unknown): TxFailure {
  const m = String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e).toLowerCase();
  if ((e as { code?: number })?.code === 4001 || /user (rejected|denied)/.test(m)) return 'rejected';
  if (/fee cap|max fee per gas.*(lower|less) than|maxfeepergas.*(lower|less) than|underpriced/.test(m)) return 'cap-too-low';
  if (/total cost.*exceeds the balance|insufficient funds|exceeds the balance of the account|gas required exceeds allowance/.test(m)) return 'exceeds-balance';
  if (/out of gas|intrinsic gas too low|reverted/.test(m)) return 'oog';
  return 'other';
}

/** The next rung of the ladder after a classified failure. 'rejected' never
 *  reaches here (the lock rethrows immediately — no second wallet prompt). */
export function nextFeePlan(current: FeePlan, failure: TxFailure): FeePlan {
  if (failure === 'cap-too-low') return HIGH_CAP;
  if (failure === 'exceeds-balance') return THRIFTY;
  if (failure === 'oog') {
    // Fees were acceptable — only the gas limit was short. Same fee posture,
    // bigger limit.
    return { ...current, gasPadPercent: current.gasPadPercent + 35n, gasHeadroom: current.gasHeadroom + 150_000n };
  }
  return current; // transient (stale node, lost receipt…) → same plan, retried
}

/** Server gas-seed target (RACE_SEED_CENTS default) — the balance a burner is
 *  expected to hold for gas. Below it, ask for a top-up BEFORE locking: every
 *  failed attempt burns gas, and nothing else refills between the claim and the
 *  post-game drip, so a streak of failures otherwise death-spirals the wallet.
 *  The server side is already balance-based, idempotent and capped (wallet ×3,
 *  device ×3, pool) — the client just has to ASK at the right moment. */
export const RACE_SEED_TARGET_CENTS = 10;

export function needsPreLockSeed(balanceCents: number | null, targetCents: number = RACE_SEED_TARGET_CENTS): boolean {
  return balanceCents !== null && balanceCents < targetCents;
}
