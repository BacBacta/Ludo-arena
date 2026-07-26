/**
 * Wallet-connection strategy + the injected account PICKER — pure/testable.
 *
 * THE BUG CLASS ("connect keeps bringing back the old accounts"): an INJECTED
 * wallet (MetaMask's in-app browser, or the extension) remembers the account
 * connected PER SITE. Every later eth_requestAccounts silently returns that
 * same account — no sheet, no choice — whatever account is active in the
 * wallet. A dapp cannot switch it silently, but it CAN ask the wallet to
 * reopen its account chooser: wallet_requestPermissions({eth_accounts}) is the
 * standard API for exactly this. The app never called it, so on the injected
 * path the "switch wallet" button could never actually switch anything.
 *
 * (The WalletConnect flavour of the same trap — restored sessions — was fixed
 * separately: fresh pairing + storage purge in walletconnect.ts.)
 */
import type { Eip1193Provider } from './minipay';

/** How an EXPLICIT "connect/switch wallet" tap should open the flow.
 *  - injected present → the INJECTED picker. WalletConnect from inside the
 *    MetaMask browser would try to pair MetaMask to itself — nonsense — and
 *    plain eth_requestAccounts is the silent-reuse bug above.
 *  - no injected → a FRESH WalletConnect pairing (session purge included).
 *  - neither → nothing to offer (caller falls back / explains). */
export type PickStrategy = 'injected-picker' | 'wc-fresh' | 'none';

export function pickStrategy(hasInjected: boolean, wcAvailable: boolean): PickStrategy {
  if (hasInjected) return 'injected-picker';
  if (wcAvailable) return 'wc-fresh';
  return 'none';
}

/** A user rejection of the permission sheet (EIP-1193 code 4001). The caller
 *  must treat it as "picker dismissed" — NOT fall through to a plain connect,
 *  which would silently hand back the old account they just refused. */
export function isUserRejection(e: unknown): boolean {
  return (e as { code?: number } | null)?.code === 4001;
}

/**
 * Force the wallet's account chooser for this site. Returns true when the
 * wallet honoured it, false when the method is unsupported (older/other
 * wallets — the caller proceeds with the plain connect, which is the best
 * available there). A USER REJECTION rethrows: refusing the chooser must not
 * silently reconnect the old account.
 */
export async function forceAccountPicker(provider: Eip1193Provider): Promise<boolean> {
  try {
    await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
    return true;
  } catch (e) {
    if (isUserRejection(e)) throw e;
    return false; // unsupported method / wallet quirk → plain connect
  }
}
