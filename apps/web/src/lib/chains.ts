/**
 * Celo chains the app can target. Celo Sepolia is the current testnet
 * (successor to Alfajores); mainnet is Celo. Selected via VITE_CHAIN.
 */
import { defineChain } from 'viem';
import { celo } from 'viem/chains';

export const celoSepolia = defineChain({
  id: 11_142_220,
  name: 'Celo Sepolia',
  nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
  rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://celo-sepolia.blockscout.com' } },
  testnet: true,
});

export const CHAINS = { celo, 'celo-sepolia': celoSepolia } as const;
export type ChainKey = keyof typeof CHAINS;

// import.meta.env is undefined outside Vite (e.g. the node verify script)
const envKey = import.meta.env?.VITE_CHAIN as ChainKey | undefined;
export const ACTIVE_CHAIN_KEY: ChainKey = envKey && envKey in CHAINS ? envKey : 'celo-sepolia';
export const activeChain = CHAINS[ACTIVE_CHAIN_KEY];
