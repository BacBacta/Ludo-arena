import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shim localStorage BEFORE importing the burner module (node test env, no jsdom).
vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
});

import { burnerAddress, clearBurner, getBurnerWallet, hasBurner, loadOrCreateBurnerKey, restoreBurnerWallet } from '../src/lib/burner';

describe('burner wallet (B1)', () => {
  beforeEach(() => clearBurner());

  it('mints a key on first use and persists it', () => {
    expect(hasBurner()).toBe(false);
    const pk = loadOrCreateBurnerKey();
    expect(pk).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hasBurner()).toBe(true);
    // Same key on the next call — the wallet must survive across visits.
    expect(loadOrCreateBurnerKey()).toBe(pk);
  });

  it('derives a stable address that matches the wallet client', () => {
    const wallet = getBurnerWallet(); // creates the burner
    expect(wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(burnerAddress()).toBe(wallet.address); // address() and the client agree
    expect(getBurnerWallet().address).toBe(wallet.address); // stable across builds
  });

  it('burnerAddress is null before any burner exists', () => {
    expect(burnerAddress()).toBeNull();
    expect(hasBurner()).toBe(false);
  });

  it('ignores a corrupted stored key instead of crashing', () => {
    localStorage.setItem('ludo:burner:pk:v1', '0xnot-a-key');
    expect(hasBurner()).toBe(false); // rejected by the shape guard
    expect(burnerAddress()).toBeNull();
    // ...and a fresh valid key is minted on demand.
    expect(loadOrCreateBurnerKey()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('clearBurner wipes it', () => {
    loadOrCreateBurnerKey();
    expect(hasBurner()).toBe(true);
    clearBurner();
    expect(hasBurner()).toBe(false);
  });

  it('signs a message with its LOCAL key — no RPC (the SIWE prove path)', async () => {
    // Regression: the app's signer must pass the client's BOUND account, not the
    // bare address — an address makes viem send personal_sign to the transport
    // (plain http() to the node), which rejects it → 'signature-declined' and the
    // wallet can never prove itself. Local signing needs no network at all: this
    // test has no chain behind it, so any RPC attempt would reject.
    const wallet = getBurnerWallet();
    expect(wallet.walletClient.account).toBeDefined(); // the bound local account
    const signature = await wallet.walletClient.signMessage({
      account: wallet.walletClient.account ?? wallet.address, // the app's signer expression
      message: 'ludo-arena wallet proof',
    });
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  });
});

// Regression (the "matchmaking spins forever" incident): the burner was only
// wired into walletRef inside joinRaceWeek, so a page RELOAD left the app
// wallet-less — the staked queue then entered DEMO mode (walletBacked=false)
// and could never pair with a wallet-backed opponent (matchmaking parity).
// restoreBurnerWallet is the boot-time restore: it must REUSE a persisted
// burner and must NEVER mint one for a first-time visitor.

describe('restoreBurnerWallet (boot-time restore)', () => {
  beforeEach(() => clearBurner()); // the first describe's cleanup doesn't reach here

  it('returns null when no burner exists — and does NOT mint one', () => {
    expect(hasBurner()).toBe(false);
    expect(restoreBurnerWallet()).toBeNull();
    expect(hasBurner()).toBe(false); // a first visit must stay burner-less
  });

  it('restores the SAME wallet (same address, funds follow) across a reload', () => {
    const created = getBurnerWallet(); // the "joinRaceWeek" session
    const restored = restoreBurnerWallet(); // the post-reload boot
    expect(restored).not.toBeNull();
    expect(restored!.address).toBe(created.address);
    expect(restored!.payGasInStable).toBe(true); // still the feeCurrency wallet
  });
});
