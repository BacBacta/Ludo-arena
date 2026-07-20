import { describe, expect, it } from 'vitest';
import { RaceFaucet } from '../src/race.js';
import { CHAINS } from '../src/settlement.js';

// B1 fee-abstraction plumbing: the faucet can be told to pay its own transfer
// gas in the stablecoin (Celo feeCurrency) so it needs no native CELO. The
// gas-in-cUSD BEHAVIOUR only shows up against a real Celo node (CIP-64); here we
// pin that the config flag reaches the faucet so fund() will pass feeCurrency.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // hardhat #0
const RACEPASS = ('0x' + '1'.repeat(40)) as `0x${string}`;
const STABLE = ('0x' + '2'.repeat(40)) as `0x${string}`;
const base = { quotaCents: 10, poolCents: 3000, jit: true, perGameCents: 2 };

describe('RaceFaucet fee abstraction (B1)', () => {
  it('carries feeInStable=true (pay gas in cUSD, no CELO needed)', () => {
    const f = new RaceFaucet(CHAINS['celo-sepolia']!, RACEPASS, STABLE, KEY, { ...base, feeInStable: true });
    expect(f.feeInStable).toBe(true);
    expect(f.stablecoin.toLowerCase()).toBe(STABLE); // the token gas is paid in
  });

  it('defaults to native-coin gas when feeInStable=false (unchanged behaviour)', () => {
    const f = new RaceFaucet(CHAINS['celo-sepolia']!, RACEPASS, STABLE, KEY, { ...base, feeInStable: false });
    expect(f.feeInStable).toBe(false);
  });
});
