import { describe, expect, it } from 'vitest';
import { celo } from 'viem/chains';
import { CHAINS } from '../src/lib/chains';

// Regression: staking (approve + join) failed with "the fee cap (maxFeePerGas
// … gwei) cannot be lower than block base fee". viem's DEFAULT baseFeeMultiplier
// is 1.2 — too thin for Celo's spiky base fee, so the estimated maxFeePerGas
// landed below the block's base fee and the node rejected the tx. We raise the
// multiplier for more headroom, WITHOUT losing Celo's formatters/serializers
// (those carry the CIP-64 feeCurrency support — gas paid in cUSD).

function multiplierValue(chain: (typeof CHAINS)[keyof typeof CHAINS]): number {
  const m = chain.fees?.baseFeeMultiplier;
  return typeof m === 'function' ? (m as () => number)() : (m as number);
}

describe('Celo fee headroom (staking gas-cap fix)', () => {
  it('mainnet carries MORE base-fee headroom than viem default (1.2)', () => {
    expect(multiplierValue(CHAINS.celo)).toBeGreaterThan(1.2);
  });

  it('testnet carries the same extra headroom (same spiky-base-fee risk)', () => {
    expect(multiplierValue(CHAINS['celo-sepolia'])).toBeGreaterThan(1.2);
  });

  it('mainnet KEEPS Celo formatters + serializers (CIP-64 feeCurrency support)', () => {
    // Losing these silently breaks gas-in-cUSD — the burner would need CELO.
    expect(CHAINS.celo.formatters).toBe(celo.formatters);
    expect(CHAINS.celo.serializers).toBe(celo.serializers);
    expect(CHAINS.celo.id).toBe(42220);
  });
});
