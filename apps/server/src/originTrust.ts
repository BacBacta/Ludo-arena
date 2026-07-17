/**
 * Defence-in-depth for R-AUTH-1. MiniPay wallets cannot personal_sign, so the
 * server accepts `miniPay:true` as an ownership proof. That flag is client-set, so
 * on its own any client can claim any (public) wallet as proven and reach the
 * wallet-keyed writes (tickets, RG limits) — the money path is separately guarded
 * by the on-chain depositor check (R-SETTLE-3), but ticket/limit griefing is not.
 *
 * This gate ties the MiniPay auto-prove to the WebSocket Origin. Browsers forbid
 * JavaScript from setting Origin, so a malicious WEBSITE cannot forge it — this
 * fully closes the browser vector. A non-browser SCRIPT can still set any Origin;
 * that residual needs an unforgeable MiniPay attestation, which is platform-
 * dependent (tracked in TESTING_REPORT.md as the remaining human/ops step).
 */

/** Whether a MiniPay auto-prove is trustworthy for this connection's Origin. With
 *  no allowlist configured (dev/testnet) the behaviour is unchanged; once set, only
 *  listed origins may auto-prove. */
export function miniPayOriginTrusted(origin: string | undefined, allowlist: ReadonlySet<string>): boolean {
  if (allowlist.size === 0) return true; // not configured → dev/testnet behaviour
  return origin !== undefined && allowlist.has(origin);
}
