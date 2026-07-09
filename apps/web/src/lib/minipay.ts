/**
 * Intégration wallet MiniPay via viem.
 * Contraintes officielles : transactions LEGACY uniquement, feeCurrency cUSD,
 * stablecoins cUSD/USDC/USDT. Voir docs/ARCHITECTURE.md §MiniPay.
 */
import { createWalletClient, custom, type Address, type WalletClient } from 'viem';
import { celo, celoAlfajores } from 'viem/chains';

declare global {
  interface Window {
    ethereum?: {
      isMiniPay?: boolean;
      request(args: { method: string; params?: unknown[] }): Promise<unknown>;
    };
  }
}

export const STABLES = {
  celo: {
    cUSD: '0x765DE816845861e75A25fCA122bb6898B8B1282a' as Address,
    USDC: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as Address,
    USDT: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' as Address,
  },
  alfajores: {
    cUSD: '0x874069Fa1Eb16D44d622F2e0Ca25eeA172369bC1' as Address,
  },
} as const;

export function isMiniPay(): boolean {
  return Boolean(window.ethereum?.isMiniPay);
}

export function hasInjectedWallet(): boolean {
  return Boolean(window.ethereum);
}

export async function connectWallet(testnet = false): Promise<{ client: WalletClient; address: Address } | null> {
  if (!window.ethereum) return null;
  const client = createWalletClient({
    chain: testnet ? celoAlfajores : celo,
    transport: custom(window.ethereum),
  });
  const [address] = await client.requestAddresses();
  if (!address) return null;
  return { client, address };
}

/**
 * Verrouille la mise dans LudoEscrow (approve + join).
 * Implémentation complète : BACKLOG E3.2 (tx legacy, feeCurrency cUSD, états UI).
 */
export async function stakeInEscrow(): Promise<never> {
  throw new Error('Non implémenté — voir docs/BACKLOG.md E3.2');
}
