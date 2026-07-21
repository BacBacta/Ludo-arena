/**
 * Celo chains the app can target. Celo Sepolia is the current testnet
 * (successor to Alfajores); mainnet is Celo. Selected via VITE_CHAIN.
 */
import { defineChain } from 'viem';
import { celo as celoBase } from 'viem/chains';

// Base-fee headroom for viem's fee estimator. viem's DEFAULT is 1.2× — too thin
// for Celo's spiky base fee: a burst pushed the block base fee above the
// estimated maxFeePerGas between estimate and mine, and the node rejected the
// staking tx ("the fee cap (maxFeePerGas … gwei) cannot be lower than block base
// fee"). 2× gives comfortable margin. It does NOT overpay — EIP-1559 charges only
// (base fee + priority) and refunds the rest of the cap — it just stops the
// under-cap rejection. Preferred over a manual maxFeePerGas override (which
// escrow.ts warns lands below the NATIVE base fee when derived from the token
// gas price); this keeps viem estimating against the native base fee, only wider.
const BASE_FEE_MULTIPLIER = 2;

// Mainnet: keep Celo's formatters + serializers (they carry CIP-64 feeCurrency —
// gas paid in cUSD) and only widen the fee margin. Spreading preserves both.
export const celo = { ...celoBase, fees: { ...celoBase.fees, baseFeeMultiplier: BASE_FEE_MULTIPLIER } };

export const celoSepolia = defineChain({
  id: 11_142_220,
  name: 'Celo Sepolia',
  nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
  rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://celo-sepolia.blockscout.com' } },
  fees: { baseFeeMultiplier: BASE_FEE_MULTIPLIER },
  testnet: true,
});

export const CHAINS = { celo, 'celo-sepolia': celoSepolia } as const;
export type ChainKey = keyof typeof CHAINS;

// import.meta.env is undefined outside Vite (e.g. the node verify script)
const envKey = import.meta.env?.VITE_CHAIN as ChainKey | undefined;
export const ACTIVE_CHAIN_KEY: ChainKey = envKey && envKey in CHAINS ? envKey : 'celo-sepolia';
export const activeChain = CHAINS[ACTIVE_CHAIN_KEY];
