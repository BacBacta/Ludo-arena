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

import { burnerAddress, clearBurner, getBurnerWallet, hasBurner, loadOrCreateBurnerKey } from '../src/lib/burner';

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
});
