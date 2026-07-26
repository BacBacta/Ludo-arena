import { describe, expect, it } from 'vitest';
import {
  isBurnerAddress,
  MIN_MINT_GAS_NATIVE_WEI,
  mintBlockedOnGas,
  raceClaimToastKey,
  raceEntryWalletKind,
  shouldRestoreBurnerAtBoot,
} from '../src/lib/raceEntry';

// THE BUG CLASS, as reported: "I connect a NEW MetaMask address and it still
// says already funded" + "when I disconnect, the old wallet comes back".
// Outside MiniPay the entry silently used the app burner whatever was
// connected, and boot re-installed that burner even after an explicit switch.

const BURNER = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' as const;
const EXTERNAL = '0x743bB002B6f925442BE7F6AE0a3F9D56Ed15cD7B';

describe('raceEntryWalletKind — which wallet carries the entry', () => {
  it('MiniPay → the ambient wallet, whatever the preference says', () => {
    expect(raceEntryWalletKind(true, false)).toBe('ambient');
    expect(raceEntryWalletKind(true, true)).toBe('ambient');
  });

  it('explicit switch → THEIR wallet (a different address = a different entry)', () => {
    expect(raceEntryWalletKind(false, true)).toBe('external');
  });

  it('default → the app burner (unchanged behaviour)', () => {
    expect(raceEntryWalletKind(false, false)).toBe('burner');
  });
});

describe('isBurnerAddress — dropping a lingering burner before pairing', () => {
  it('matches case-insensitively (checksummed vs lowercased)', () => {
    expect(isBurnerAddress(BURNER.toLowerCase(), BURNER)).toBe(true);
  });

  it('an external address is not the burner', () => {
    expect(isBurnerAddress(EXTERNAL, BURNER)).toBe(false);
  });

  it('unknowns are NOT the burner — a failed read must never block', () => {
    expect(isBurnerAddress(undefined, BURNER)).toBe(false);
    expect(isBurnerAddress(EXTERNAL, null)).toBe(false);
  });
});

describe('shouldRestoreBurnerAtBoot — "the old wallet keeps coming back"', () => {
  it('restores the burner in default mode (the matchmaking-spinner guard)', () => {
    expect(shouldRestoreBurnerAtBoot(false, false)).toBe(true);
  });

  it('does NOT restore it after an explicit switch to an external wallet', () => {
    // Re-installing the burner here is what made the old address reappear on
    // every reload in external mode.
    expect(shouldRestoreBurnerAtBoot(false, true)).toBe(false);
  });

  it('never restores a burner inside MiniPay (its wallet is ambient)', () => {
    expect(shouldRestoreBurnerAtBoot(true, false)).toBe(false);
    expect(shouldRestoreBurnerAtBoot(true, true)).toBe(false);
  });
});

describe('mintBlockedOnGas — each gas mode checks ITS OWN balance', () => {
  it('stable mode: blocked below the cUSD floor, clear at/above it', () => {
    expect(mintBlockedOnGas(true, 3, 8, null)).toBe(true);
    expect(mintBlockedOnGas(true, 8, 8, null)).toBe(false);
  });

  it('stable mode ignores the native balance entirely', () => {
    // A burner never holds CELO — that must not block its cUSD-gas mint.
    expect(mintBlockedOnGas(true, 10, 8, 0n)).toBe(false);
  });

  it('native mode: blocked below the wei floor, clear at/above it', () => {
    expect(mintBlockedOnGas(false, null, 8, MIN_MINT_GAS_NATIVE_WEI - 1n)).toBe(true);
    expect(mintBlockedOnGas(false, null, 8, MIN_MINT_GAS_NATIVE_WEI)).toBe(false);
  });

  it('native mode ignores the cUSD balance entirely', () => {
    // A MetaMask wallet with 0 cUSD but sponsored CELO must be allowed to mint
    // — the cUSD floor means nothing to it.
    expect(mintBlockedOnGas(false, 0, 8, MIN_MINT_GAS_NATIVE_WEI * 2n)).toBe(false);
  });

  it('a null balance is a failed READ, not an empty wallet — fail OPEN', () => {
    expect(mintBlockedOnGas(true, null, 8, null)).toBe(false);
    expect(mintBlockedOnGas(false, null, 8, null)).toBe(false);
  });

  it('the native floor sits well under the sponsorship target (no deadlock)', () => {
    const sponsorTarget = 2_000_000_000_000_000n; // server default: 0.002 CELO
    expect(MIN_MINT_GAS_NATIVE_WEI < sponsorTarget).toBe(true);
  });
});

describe('raceClaimToastKey — a fresh registration must not read as a refusal', () => {
  it('selfFunded → its own message (the "already funded" complaint)', () => {
    expect(raceClaimToastKey(true, true)).toBe('raceSelfFunded');
  });

  it('a true idempotent re-claim keeps "already funded"', () => {
    expect(raceClaimToastKey(true, undefined)).toBe('raceAlreadyFunded');
    expect(raceClaimToastKey(true, false)).toBe('raceAlreadyFunded');
  });

  it('a funded claim keeps the funded toast', () => {
    expect(raceClaimToastKey(false, undefined)).toBe('raceFunded');
  });
});
