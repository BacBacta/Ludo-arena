import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forceAccountPicker, isUserRejection, pickStrategy } from '../src/lib/walletPick';
import { connectWalletWith, type Eip1193Provider } from '../src/lib/minipay';

// connectWalletWith touches `window` (isMiniPay detection) — give the node
// test env a bare one, with no injected provider (isMiniPay → false).
beforeAll(() => {
  (globalThis as { window?: unknown }).window = {};
});
afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
});

// THE BUG, as reported: "le connect wallet reconduit toujours les anciens
// comptes". An injected wallet (MetaMask in-app browser / extension) remembers
// the per-site connected account and silently returns it on every
// eth_requestAccounts — the switch button could never actually switch.
// wallet_requestPermissions({eth_accounts}) is the API that reopens the
// chooser; these tests pin down the request sequence and every failure mode
// against a scripted EIP-1193 provider.

const NEW = '0x1111111111111111111111111111111111111111';

/** A scripted EIP-1193 provider that records every request. */
function mockProvider(opts: {
  onPermissions?: () => unknown; // throw to simulate rejection/unsupported
  accounts?: string[];
}): { provider: Eip1193Provider; calls: string[] } {
  const calls: string[] = [];
  const provider: Eip1193Provider = {
    async request({ method }) {
      calls.push(method);
      if (method === 'wallet_requestPermissions') {
        if (opts.onPermissions) return opts.onPermissions();
        return [{ parentCapability: 'eth_accounts' }];
      }
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return opts.accounts ?? [NEW];
      if (method === 'eth_chainId') return '0xa4ec';
      return null;
    },
  };
  return { provider, calls };
}

describe('pickStrategy — an explicit switch uses the mechanism that lets the player CHOOSE', () => {
  it('injected present → the injected account picker (never WalletConnect-to-itself)', () => {
    expect(pickStrategy(true, true)).toBe('injected-picker');
    expect(pickStrategy(true, false)).toBe('injected-picker');
  });

  it('no injected → a fresh WalletConnect pairing', () => {
    expect(pickStrategy(false, true)).toBe('wc-fresh');
  });

  it('neither → nothing to offer', () => {
    expect(pickStrategy(false, false)).toBe('none');
  });
});

describe('forceAccountPicker — the chooser request itself', () => {
  it('asks wallet_requestPermissions and reports the wallet honoured it', async () => {
    const { provider, calls } = mockProvider({});
    await expect(forceAccountPicker(provider)).resolves.toBe(true);
    expect(calls).toEqual(['wallet_requestPermissions']);
  });

  it('an UNSUPPORTED method falls through (false) — older wallets still connect plainly', async () => {
    const { provider } = mockProvider({
      onPermissions: () => {
        throw Object.assign(new Error('Method not found'), { code: -32601 });
      },
    });
    await expect(forceAccountPicker(provider)).resolves.toBe(false);
  });

  it('a USER REJECTION (4001) rethrows — refusing the chooser must not mean "reuse the old account"', async () => {
    const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 });
    const { provider } = mockProvider({
      onPermissions: () => {
        throw rejection;
      },
    });
    await expect(forceAccountPicker(provider)).rejects.toBe(rejection);
    expect(isUserRejection(rejection)).toBe(true);
    expect(isUserRejection(new Error('boom'))).toBe(false);
    expect(isUserRejection(null)).toBe(false);
  });
});

describe('connectWalletWith(forcePicker) — the full connect sequence', () => {
  it('opens the chooser BEFORE reading accounts, and returns the newly picked account', async () => {
    const { provider, calls } = mockProvider({ accounts: [NEW] });
    const wallet = await connectWalletWith(provider, true);
    expect(wallet?.address).toBe(NEW);
    expect(calls[0]).toBe('wallet_requestPermissions');
    expect(calls).toContain('eth_requestAccounts');
    expect(calls.indexOf('wallet_requestPermissions')).toBeLessThan(calls.indexOf('eth_requestAccounts'));
  });

  it('a REFUSED chooser returns null — it must NOT fall through to the silent per-site reuse', async () => {
    const { provider, calls } = mockProvider({
      onPermissions: () => {
        throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      },
    });
    await expect(connectWalletWith(provider, true)).resolves.toBeNull();
    expect(calls).toEqual(['wallet_requestPermissions']); // never read accounts after a refusal
  });

  it('an UNSUPPORTED chooser still connects plainly (best available on that wallet)', async () => {
    const { provider, calls } = mockProvider({
      accounts: [NEW],
      onPermissions: () => {
        throw Object.assign(new Error('Method not found'), { code: -32601 });
      },
    });
    const wallet = await connectWalletWith(provider, true);
    expect(wallet?.address).toBe(NEW);
    expect(calls).toContain('eth_requestAccounts');
  });

  it('without forcePicker the sequence is unchanged (no permissions call at all)', async () => {
    const { provider, calls } = mockProvider({ accounts: [NEW] });
    const wallet = await connectWalletWith(provider, false);
    expect(wallet?.address).toBe(NEW);
    expect(calls).not.toContain('wallet_requestPermissions');
  });
});
