import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression — "Verify your wallet ownership to play staked games." on EVERY
// staked 4p entry from a desktop browser.
//
// `queue.join4` used to leave in the same tick as `hello`, so it always reached
// the server ahead of the SIWE proof, which needs a full round trip
// (hello.ok → sign → wallet.prove). The server's staked gate reads
// `wallet && !walletProven` and refused. Inside MiniPay the server auto-proves
// on hello, so the race was invisible there — the bug only ever showed outside
// MiniPay. The 1v1 path already deferred its join (see deferredQueue.test.ts);
// this pins the same ordering for the 4-player table.
//
// Drives the REAL Remote4 over a fake WebSocket.

vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  (globalThis as unknown as Record<string, unknown>).window = {}; // isMiniPay() → false
  (globalThis as unknown as Record<string, unknown>).document = undefined;
  class FakeWS {
    static instances: FakeWS[] = [];
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      FakeWS.instances.push(this);
    }
    send(d: string): void {
      this.sent.push(d);
    }
    close(): void {
      /* no-op */
    }
  }
  (globalThis as unknown as Record<string, unknown>).WebSocket = FakeWS;
});

import { Remote4 } from '../src/lib/remote4';

type FakeSocket = { url: string; sent: string[]; onopen: (() => void) | null; onmessage: ((e: { data: string }) => void) | null };
const FakeWS = globalThis.WebSocket as unknown as { instances: FakeSocket[] };

/** Message types sent by the client, in order. */
const kinds = (ws: FakeSocket): string[] => ws.sent.map((s) => (JSON.parse(s) as { t: string }).t);

const events = () => ({
  onQueued: () => {},
  onMatch: () => {},
  onState: () => {},
  onTurn: () => {},
  onEmote: () => {},
  onGift: () => {},
  onOver: () => {},
  onSettled: () => {},
  onRefunded: () => {},
  onError: () => {},
  onGone: () => {},
});

/** Let the entropy commit (async sha256) and any promise chain settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

/** Wait until `probe()` is true, or fail loudly.
 *
 *  A fixed number of ticks is not enough here: the entropy commit is a REAL async
 *  sha256 (WebCrypto), so on a loaded machine the socket is not constructed yet
 *  when `settle()` returns and the caller dereferences `undefined`. Polling makes
 *  the wait depend on the thing being waited for instead of on the host's speed. */
async function until(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (probe()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function open(stakeCents: number, signMessage?: (m: string) => Promise<string>): Promise<FakeSocket> {
  const before = FakeWS.instances.length;
  new Remote4(events() as never, 'ws://x', '0xWallet', stakeCents, { consent: { tosVersion: 1, age18: true }, signMessage } as never);
  await until(() => FakeWS.instances.length > before, 'the socket to be constructed');
  const ws = FakeWS.instances[FakeWS.instances.length - 1]!;
  ws.onopen?.();
  return ws;
}

const helloOk = (ws: FakeSocket, walletNonce?: string): void =>
  ws.onmessage?.({ data: JSON.stringify({ t: 'hello.ok', sessionToken: 'tok', name: 'Player', walletNonce }) });

beforeEach(() => {
  FakeWS.instances.length = 0;
});

describe('staked 4p entry — the join must follow the wallet proof', () => {
  it('does NOT join on open: a join sent with hello always beats the proof', async () => {
    const ws = await open(25, async () => '0xsig');
    expect(kinds(ws)).toEqual(['hello']);
  });

  it('sends wallet.prove BEFORE queue.join4 once the nonce arrives', async () => {
    const ws = await open(25, async () => '0xsig');
    helloOk(ws, 'nonce-abc');
    await settle();

    const order = kinds(ws);
    expect(order).toEqual(['hello', 'wallet.prove', 'queue.join4']);
    // The server reads them in order, so walletProven is set before the gate runs.
    expect(order.indexOf('wallet.prove')).toBeLessThan(order.indexOf('queue.join4'));
  });

  it('signs the nonce the server actually issued', async () => {
    const seen: string[] = [];
    const ws = await open(25, async (m) => {
      seen.push(m);
      return '0xsig';
    });
    helloOk(ws, 'nonce-xyz');
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('nonce-xyz');
  });

  it('still joins when the player DECLINES, so the server gives its own refusal', async () => {
    const ws = await open(25, async () => {
      throw new Error('user rejected');
    });
    helloOk(ws, 'nonce-abc');
    await settle();
    expect(kinds(ws)).toEqual(['hello', 'queue.join4']);
  });

  it('a free table joins immediately — nothing to prove', async () => {
    const ws = await open(0, async () => '0xsig');
    helloOk(ws, 'nonce-abc'); // a nonce may still be issued; stake 0 needs no proof
    await settle();
    expect(kinds(ws)).toEqual(['hello', 'queue.join4']);
  });

  it('an already-proven session (no nonce) joins without waiting', async () => {
    const ws = await open(25, async () => '0xsig');
    helloOk(ws, undefined); // MiniPay / already proven → server issues no nonce
    await settle();
    expect(kinds(ws)).toEqual(['hello', 'queue.join4']);
  });

  it('joins at most once even if hello.ok is delivered twice', async () => {
    const ws = await open(25, async () => '0xsig');
    helloOk(ws, 'nonce-abc');
    await settle();
    helloOk(ws, 'nonce-abc');
    await settle();
    expect(kinds(ws).filter((k) => k === 'queue.join4')).toHaveLength(1);
  });
});
