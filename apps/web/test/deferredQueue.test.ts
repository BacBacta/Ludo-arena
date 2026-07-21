import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression — "both players search forever, nobody is in the queue". A STAKED
// queue.join is DEFERRED until the wallet is SIWE-proven; the release paths were
// (a) the friends.update pushed after wallet.prove and (b) a fallback armed
// after signing. But a RESUMED session that is ALREADY proven server-side gets
// hello.ok WITHOUT a walletNonce → the SIWE block never runs → nothing ever
// releases the deferred join. So attempt 1 in a browser session worked (fresh
// session → nonce → prove → release) and every LATER staked attempt hung
// silently. This drives the REAL RemoteSession over a fake WebSocket.

vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  (globalThis as unknown as Record<string, unknown>).window = {}; // isMiniPay() → false
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

import { RemoteSession } from '../src/lib/session';

type FakeWSType = { instances: Array<{ url: string; sent: string[]; onopen: (() => void) | null; onmessage: ((e: { data: string }) => void) | null }> };
const FakeWS = (globalThis as unknown as { WebSocket: FakeWSType }).WebSocket;

// Every SessionEvents callback becomes a no-op (we assert on the wire, not the UI).
const evStub = new Proxy({}, { get: () => () => undefined }) as never;

const HELLO_OK_BASE = { t: 'hello.ok', sessionToken: 'tok', name: 'Tester', flag: '🏳️', elo: 1000, games: 0, wins: 0, pid: 'pid1' };

async function openedSession(auth: { signMessage?: (m: string) => Promise<string> }) {
  FakeWS.instances.length = 0;
  const session = new RemoteSession(evStub, 1, 'ws://test', () => undefined, '0x00000000000000000000000000000000000000aa', { kind: 'queue' }, { consent: { tosVersion: 'v', age18: true }, ...auth } as never);
  await vi.waitFor(() => {
    if (FakeWS.instances.length === 0) throw new Error('ws not created yet');
  });
  const ws = FakeWS.instances[0]!;
  ws.onopen?.();
  return { session, ws };
}

const sentTypes = (ws: { sent: string[] }): string[] => ws.sent.map((s) => (JSON.parse(s) as { t: string }).t);

describe('deferred staked queue.join release', () => {
  beforeEach(() => localStorage.clear());

  it('an ALREADY-PROVEN session (hello.ok without walletNonce) queues immediately', async () => {
    const { session, ws } = await openedSession({ signMessage: async () => '0xsig' });
    ws.onmessage?.({ data: JSON.stringify(HELLO_OK_BASE) }); // no walletNonce
    await vi.waitFor(() => {
      if (!sentTypes(ws).includes('queue.join')) throw new Error('queue.join not sent');
    });
    expect(sentTypes(ws)).toContain('queue.join');
    session.dispose();
  });

  it('an UNPROVEN session (walletNonce present) still defers until the proven ack', async () => {
    const { session, ws } = await openedSession({ signMessage: async () => '0xsig' });
    ws.onmessage?.({ data: JSON.stringify({ ...HELLO_OK_BASE, walletNonce: 'nonce1' }) });
    // The signature is in flight → the join must NOT have been sent yet…
    expect(sentTypes(ws)).not.toContain('queue.join');
    await vi.waitFor(() => {
      if (!sentTypes(ws).includes('wallet.prove')) throw new Error('prove not sent');
    });
    // …and the server's proven ack (friends.update) releases it.
    ws.onmessage?.({ data: JSON.stringify({ t: 'friends.update', friends: [], requests: [], outgoing: [] }) });
    await vi.waitFor(() => {
      if (!sentTypes(ws).includes('queue.join')) throw new Error('queue.join not sent');
    });
    session.dispose();
  });
});
