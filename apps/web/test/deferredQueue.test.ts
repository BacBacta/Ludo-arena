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

describe('post-game socket drop (the mobile rematch black hole)', () => {
  beforeEach(() => localStorage.clear());

  it('RECONNECTS after game.over so the rematch channel survives a dropped socket', async () => {
    FakeWS.instances.length = 0;
    const session = new RemoteSession(evStub, 1, 'ws://test', () => undefined, '0x00000000000000000000000000000000000000aa', { kind: 'queue' }, { consent: { tosVersion: 'v', age18: true } } as never);
    await vi.waitFor(() => { if (FakeWS.instances.length === 0) throw new Error('no ws'); });
    const ws = FakeWS.instances[0]!;
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify(HELLO_OK_BASE) });
    // A game runs and ends → the player sits on the end screen.
    ws.onmessage?.({ data: JSON.stringify({ t: 'match.found', gameId: 'g1', seat: 0, opponent: { name: 'Rival', flag: '' }, stakeCents: 1, potCents: 2, fairnessCommit: 'a'.repeat(64) }) });
    ws.onmessage?.({ data: JSON.stringify({ t: 'game.over', winner: 0, reason: 'finish', payoutCents: 2, rakeCents: 0, eloDelta: 1, fairnessReveal: { serverSeed: '', entropies: ['', ''] } }) });
    // The mobile socket silently dies on the end screen…
    (ws as unknown as { onclose: (() => void) | null }).onclose?.();
    // …and the session must come back (old code: no reconnect after the game →
    // the opponent's offer was undeliverable and our polls were silent no-ops).
    await vi.waitFor(
      () => { if (FakeWS.instances.length < 2) throw new Error('no reconnect'); },
      { timeout: 3000 },
    );
    const ws2 = FakeWS.instances[1]!;
    ws2.onopen?.();
    ws2.onmessage?.({ data: JSON.stringify(HELLO_OK_BASE) });
    session.pollRematch();
    expect(sentTypes(ws2)).toContain('rematch.poll'); // the channel lives again
    expect(sentTypes(ws2)).not.toContain('queue.join'); // a resume NEVER re-queues by itself
    session.dispose();
  });
});

describe('mid-staking socket drop (the blank-blue-screen freeze)', () => {
  beforeEach(() => localStorage.clear());

  // Production incident: player B (desktop, low-balance burner) got match.found,
  // then the pre-lock gas seed ONE-SHOT resumed the same session token → the
  // server's R-RT-1 takeover CLOSED the match socket mid-staking. On reconnect
  // the game was still PENDING (deposits in flight) so hello.ok had no
  // `resumed` — and the client concluded "game gone" (onGone → lobby, match
  // context dropped). When the room then started, game.state flipped the app to
  // the game screen with NO match → GameScreen null-rendered a blank blue page
  // forever while the server auto-played B to a 3-miss forfeit of a real stake.
  it('a PENDING match survives a drop: no onGone, context replayed, state lands', async () => {
    FakeWS.instances.length = 0;
    let gone = 0;
    let stated = 0;
    const ev = new Proxy({}, {
      get: (_t, k) => {
        if (k === 'onGone') return () => { gone += 1; };
        if (k === 'onState') return () => { stated += 1; };
        return () => undefined;
      },
    }) as never;
    const session = new RemoteSession(ev, 1, 'ws://test', () => undefined, '0x00000000000000000000000000000000000000aa', { kind: 'queue' }, { consent: { tosVersion: 'v', age18: true } } as never);
    await vi.waitFor(() => { if (FakeWS.instances.length === 0) throw new Error('no ws'); });
    const ws = FakeWS.instances[0]!;
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify(HELLO_OK_BASE) });
    // Opponent found — the game is created but NOT started (stakes in flight).
    ws.onmessage?.({ data: JSON.stringify({ t: 'match.found', gameId: 'g1', seat: 1, opponent: { name: 'Rival', flag: '' }, stakeCents: 1, potCents: 2, fairnessCommit: 'a'.repeat(64) }) });
    // The takeover (or any blip) closes the match socket mid-staking…
    (ws as unknown as { onclose: (() => void) | null }).onclose?.();
    await vi.waitFor(
      () => { if (FakeWS.instances.length < 2) throw new Error('no reconnect'); },
      { timeout: 3000 },
    );
    const ws2 = FakeWS.instances[1]!;
    ws2.onopen?.();
    // …and the resumed hello has NO `resumed` (the room hasn't started yet).
    ws2.onmessage?.({ data: JSON.stringify(HELLO_OK_BASE) });
    // The old code declared the game gone RIGHT HERE (lobby, match dropped).
    expect(gone).toBe(0);
    // The server replays the pending match context on the fresh socket…
    ws2.onmessage?.({ data: JSON.stringify({ t: 'match.found', gameId: 'g1', seat: 1, opponent: { name: 'Rival', flag: '' }, stakeCents: 1, potCents: 2, fairnessCommit: 'a'.repeat(64) }) });
    // …and the room eventually starts: the state must reach the app normally.
    ws2.onmessage?.({ data: JSON.stringify({ t: 'game.state', state: { turn: 1, phase: 'awaiting-roll', positions: [[0, 0], [0, 0]], dice: null } }) });
    expect(stated).toBeGreaterThan(0);
    expect(gone).toBe(0);
    // A resume never re-queues by itself (the #81 landmine stays dead).
    expect(sentTypes(ws2)).not.toContain('queue.join');
    session.dispose();
  });

  it('a STARTED game that is truly gone on resume still fires onGone (legit path)', async () => {
    FakeWS.instances.length = 0;
    let gone = 0;
    const ev = new Proxy({}, { get: (_t, k) => (k === 'onGone' ? () => { gone += 1; } : () => undefined) }) as never;
    const session = new RemoteSession(ev, 1, 'ws://test', () => undefined, '0x00000000000000000000000000000000000000aa', { kind: 'queue' }, { consent: { tosVersion: 'v', age18: true } } as never);
    await vi.waitFor(() => { if (FakeWS.instances.length === 0) throw new Error('no ws'); });
    const ws = FakeWS.instances[0]!;
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify(HELLO_OK_BASE) });
    ws.onmessage?.({ data: JSON.stringify({ t: 'match.found', gameId: 'g1', seat: 0, opponent: { name: 'Rival', flag: '' }, stakeCents: 1, potCents: 2, fairnessCommit: 'a'.repeat(64) }) });
    // The room started (we SAW state) — this is a real in-progress game.
    ws.onmessage?.({ data: JSON.stringify({ t: 'game.state', state: { turn: 0, phase: 'awaiting-roll', positions: [[0, 0], [0, 0]], dice: null } }) });
    (ws as unknown as { onclose: (() => void) | null }).onclose?.();
    await vi.waitFor(
      () => { if (FakeWS.instances.length < 2) throw new Error('no reconnect'); },
      { timeout: 3000 },
    );
    const ws2 = FakeWS.instances[1]!;
    ws2.onopen?.();
    // No `resumed` for a game we had STARTED → it ended/expired while away.
    ws2.onmessage?.({ data: JSON.stringify(HELLO_OK_BASE) });
    expect(gone).toBe(1);
    session.dispose();
  });

  it('a REPLAYED match.found re-reveals the entropy (the original may have died with the socket)', async () => {
    const { session, ws } = await openedSession({ signMessage: async () => '0xsig' });
    ws.onmessage?.({ data: JSON.stringify(HELLO_OK_BASE) });
    const mf = { t: 'match.found', gameId: 'g1', seat: 0, opponent: { name: 'Rival', flag: '' }, stakeCents: 1, potCents: 2, fairnessCommit: 'a'.repeat(64) };
    ws.onmessage?.({ data: JSON.stringify(mf) });
    ws.onmessage?.({ data: JSON.stringify(mf) }); // replay (server resend on resume)
    const entropies = sentTypes(ws).filter((t) => t === 'game.entropy');
    expect(entropies.length).toBe(2); // duplicate is a silent no-op server-side
    session.dispose();
  });
});

describe('requestRaceSeed (pre-lock gas seed over the LIVE match socket)', () => {
  beforeEach(() => localStorage.clear());

  // The seed must ride the existing game socket: the old one-shot resumed the
  // SAME session token, and the server's takeover closed the match socket at
  // the exact moment the stake was being locked (the freeze's first domino).
  it('sends race.seed on the open socket — never opens a second connection', async () => {
    const { session, ws } = await openedSession({ signMessage: async () => '0xsig' });
    ws.onmessage?.({ data: JSON.stringify(HELLO_OK_BASE) });
    const before = FakeWS.instances.length;
    const p = session.requestRaceSeed();
    expect(sentTypes(ws)).toContain('race.seed');
    expect(FakeWS.instances.length).toBe(before); // no one-shot, no takeover
    ws.onmessage?.({ data: JSON.stringify({ t: 'race.seeded', seedCents: 8, alreadySeeded: false, txHash: '0xseed' }) });
    await expect(p).resolves.toMatchObject({ seedCents: 8 });
    session.dispose();
  });
});

describe('pollRematch (reliable rematch offer — pull recovers a missed push)', () => {
  beforeEach(() => localStorage.clear());

  it('sends rematch.poll on the open socket, and surfaces the offer the server returns', async () => {
    FakeWS.instances.length = 0;
    let offered: string | null = null;
    const ev = new Proxy({}, { get: (_t, k) => (k === 'onRematchOffer' ? (name: string) => { offered = name; } : () => undefined) }) as never;
    const session = new RemoteSession(ev, 1, 'ws://test', () => undefined, '0x00000000000000000000000000000000000000aa', { kind: 'queue' }, { consent: { tosVersion: 'v', age18: true } } as never);
    await vi.waitFor(() => { if (FakeWS.instances.length === 0) throw new Error('no ws'); });
    const ws = FakeWS.instances[0]!;
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify(HELLO_OK_BASE) });

    session.pollRematch();
    expect(sentTypes(ws)).toContain('rematch.poll');

    // The server answers the poll with the opponent's pending offer.
    ws.onmessage?.({ data: JSON.stringify({ t: 'rematch.offer', name: 'Rival' }) });
    expect(offered).toBe('Rival');
    session.dispose();
  });
});
