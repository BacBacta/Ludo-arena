/**
 * WalletConnect (Reown) connection for plain mobile/desktop browsers that have
 * NO injected wallet (i.e. outside MiniPay). Lets a user pair Valora / MetaMask
 * mobile / any WC v2 wallet via QR or deeplink, so they can stake and mint
 * without MiniPay. Gated on VITE_WC_PROJECT_ID — absent → the option stays
 * hidden and the app is MiniPay/injected-only, exactly as before.
 *
 * The heavy @walletconnect/ethereum-provider bundle is imported DYNAMICALLY,
 * only when the user actually taps "connect with a wallet", so it never lands
 * in the initial chunk (keeps the cold-start bundle lean for low-end Android).
 */
import { activeChain } from './chains';
import { connectWalletWith, type Wallet } from './minipay';

/** The configured WalletConnect project id (from cloud.reown.com), or undefined. */
export function wcProjectId(): string | undefined {
  return import.meta.env.VITE_WC_PROJECT_ID?.trim() || undefined;
}

/** True when WalletConnect is configured → the browser-wallet connect option can
 *  be offered. False → callers keep the MiniPay-only path. */
export function walletConnectAvailable(): boolean {
  return !!wcProjectId();
}

// Cache the provider across calls so a reconnect within the session reuses the
// existing pairing instead of spawning a second modal / session.
let providerPromise: Promise<{ request(args: { method: string; params?: unknown[] }): Promise<unknown>; enable(): Promise<string[]>; disconnect(): Promise<void> }> | null = null;

async function getProvider(projectId: string): Promise<{ request(args: { method: string; params?: unknown[] }): Promise<unknown>; enable(): Promise<string[]>; disconnect(): Promise<void> }> {
  if (!providerPromise) {
    providerPromise = (async () => {
      const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
      const rpc = activeChain.rpcUrls.default.http[0];
      return EthereumProvider.init({
        projectId,
        // The app is single-chain (Celo Sepolia / Celo). Requiring it on connect
        // makes the wallet switch/add the network up front, so later stake+mint
        // txs never land on the wrong chain.
        chains: [activeChain.id],
        optionalChains: [activeChain.id],
        rpcMap: rpc ? { [activeChain.id]: rpc } : undefined,
        showQrModal: true,
        metadata: {
          name: 'Ludo Arena',
          description: 'Play Ludo for real stakes on Celo.',
          url: typeof window !== 'undefined' ? window.location.origin : 'https://www.ludoarena.xyz',
          icons: ['https://www.ludoarena.xyz/icon-192.png'],
        },
      });
    })();
  }
  return providerPromise;
}

/**
 * Opens the WalletConnect modal and returns a connected Wallet on the active
 * chain, or null when unconfigured / the user dismisses the modal. The returned
 * provider satisfies EIP-1193, so it drives the same viem stake/mint/sign paths
 * as the injected wallet (non-MiniPay → standard gas, personal_sign works).
 */
export async function connectViaWalletConnect(): Promise<Wallet | null> {
  const projectId = wcProjectId();
  if (!projectId) return null;
  try {
    const provider = await getProvider(projectId);
    await provider.enable(); // opens the QR/deeplink modal; resolves once paired
    return await connectWalletWith(provider);
  } catch {
    // user closed the modal, rejected the session, or pairing failed → let the
    // caller fall back (toast). Drop the cached provider so a retry re-inits.
    providerPromise = null;
    return null;
  }
}

/** Tear down any live WalletConnect session (best-effort). */
export async function disconnectWalletConnect(): Promise<void> {
  if (!providerPromise) return;
  try {
    const provider = await providerPromise;
    await provider.disconnect();
  } catch {
    /* already gone */
  }
  providerPromise = null;
}
