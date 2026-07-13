import { describe, expect, it } from 'vitest';
import { getAddress, keccak256, toBytes } from 'viem';
import { createCosmeticsVerifier, itemIdFor } from '../src/cosmetics.js';

describe('cosmetics verifier (rec 6)', () => {
  it('itemIdFor is keccak256(bytes(id)), lowercased and deterministic', () => {
    expect(itemIdFor('obsidian')).toBe(keccak256(toBytes('obsidian')).toLowerCase());
    expect(itemIdFor('obsidian')).toBe(itemIdFor('obsidian'));
    expect(itemIdFor('aurora')).not.toBe(itemIdFor('obsidian'));
  });

  it('is dormant (null) when the chain is unknown', () => {
    expect(createCosmeticsVerifier({ CHAIN: 'no-such-chain' })).toBeNull();
  });

  it('is dormant on a chain with no CosmeticsStore deployed', () => {
    // celo mainnet is never deployed in tests → the store address is absent
    expect(createCosmeticsVerifier({ CHAIN: 'celo' })).toBeNull();
  });

  it('builds a verifier when a store address is explicitly configured', () => {
    const addr = '0x000000000000000000000000000000000000dEaD';
    const v = createCosmeticsVerifier({ CHAIN: 'celo-sepolia', COSMETICS_STORE_ADDRESS: addr });
    expect(v).not.toBeNull();
    expect(v?.address).toBe(getAddress(addr));
  });
});
