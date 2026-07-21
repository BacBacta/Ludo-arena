/**
 * Toast-sized cause of a failed wallet/tx call. viem's `shortMessage` names the
 * exact revert / RPC cause ("transfer amount exceeds balance", "nonce too low"…)
 * without the multi-line request dump; fall back to Error.message, then String().
 * Truncated so a toast stays readable. Born from the "Stake not locked" incident:
 * the cause only went to a console that page auto-reloads keep wiping, so every
 * failure report came back cause-less — the toast must carry its own diagnosis.
 */
export function describeTxError(e: unknown, max = 120): string {
  const s = String((e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? e);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
