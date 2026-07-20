import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createArbiter } from '../src/settlement.js';

// Regression guard for the boot crash-loop: a misconfigured settlement secret
// (unknown CHAIN, or a CHAIN with no escrow deployed — e.g. CHAIN=celo before the
// mainnet contracts exist) used to THROW inside createArbiter, which runs at
// module load, so one bad Fly secret took the WHOLE server down (free play too).
// It must now fail SOFT: return null (staked play disabled, R-COMP-2) and let the
// process boot — the belt-and-suspenders bootSubsystem wrapper in index.ts catches
// anything this misses (e.g. a malformed faucet key).

describe('createArbiter boot safety (never crash-loops on a bad secret)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('returns null (not a throw) when no arbiter key is configured', () => {
    expect(createArbiter({})).toBeNull();
  });

  it('returns null (not a throw) on an unknown CHAIN', () => {
    const arb = createArbiter({ ARBITER_PRIVATE_KEY: '0x' + '1'.repeat(64), CHAIN: 'ethereum-mainnet' });
    expect(arb).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });

  it('returns null (not a throw) when the chain has no escrow deployed — the exact crash that took the box down', () => {
    // CHAIN=celo (mainnet, chainId 42220) has no escrow in deployments.json.
    const arb = createArbiter({ ARBITER_PRIVATE_KEY: '0x' + '1'.repeat(64), CHAIN: 'celo' });
    expect(arb).toBeNull();
    expect(errSpy).toHaveBeenCalled();
  });
});
