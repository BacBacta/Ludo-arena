import { describe, expect, it, afterEach } from 'vitest';
import { MemoryStore } from '../src/store/memory.js';
import { PersistentStore } from '../src/store/persistent.js';
import { playerId, type SessionRecord, type Store } from '../src/store/types.js';
import { Room, type Client } from '../src/room.js';
import { createFairness } from '../src/fairness.js';
import type { ServerMsg } from '@ludo/shared';

function makeClient(id: string): Client & { inbox: ServerMsg[] } {
  const inbox: ServerMsg[] = [];
  return {
    id,
    name: 'P' + id,
    flag: '🌍',
    elo: 1200,
    inbox,
    send(msg: ServerMsg) {
      inbox.push(msg);
    },
  };
}

const sessionRec: SessionRecord = {
  id: 'tok1',
  wallet: '0xAbC',
  entropy: 'e'.repeat(16),
  name: 'Kwame',
  flag: '🇨🇲',
  elo: 1234,
  stake: 25,
  gameId: 'g1',
  seat: 0,
};

function storeContract(name: string, make: () => Store, cleanup?: () => Promise<void>): void {
  describe(name, () => {
    afterEach(async () => {
      await cleanup?.();
    });

    it('round-trips sessions', async () => {
      const store = make();
      await store.init();
      await store.saveSession(sessionRec);
      expect(await store.loadSession('tok1')).toEqual(sessionRec);
      await store.deleteSession('tok1');
      expect(await store.loadSession('tok1')).toBeNull();
      await store.close();
    });

    it('round-trips room snapshots and lists them', async () => {
      const store = make();
      await store.init();
      const room = new Room('g1', 25, makeClient('a'), makeClient('b'), createFairness('x'.repeat(16), 'y'.repeat(16)));
      const snap = room.toSnapshot();
      await store.saveRoom(snap);
      expect(await store.loadRooms()).toEqual([snap]);
      await store.deleteRoom('g1');
      expect(await store.loadRooms()).toEqual([]);
      await store.close();
    });

    it('keeps ELO across getOrCreatePlayer calls', async () => {
      const store = make();
      await store.init();
      // unique wallet per run: the durable store keeps rows across test runs
      const wallet = '0xAbC' + Math.random().toString(16).slice(2, 10);
      const id = playerId(wallet, 's1');
      expect(id).toBe(wallet.toLowerCase());
      const first = await store.getOrCreatePlayer(id, { wallet, name: 'K', flag: '🇨🇲' });
      expect(first.elo).toBe(1200);
      await store.updateElo(id, 1250);
      const second = await store.getOrCreatePlayer(id, { wallet, name: 'K', flag: '🇨🇲' });
      expect(second.elo).toBe(1250);
      await store.getOrCreatePlayer('anon:s2', { name: 'A', flag: '🌍' });
      await store.recordGame({
        gameId: 'test-' + Math.random().toString(16).slice(2, 10),
        stakeCents: 25,
        playerA: id,
        playerB: 'anon:s2',
        winnerSeat: 0,
        reason: 'finish',
        payoutCents: 45,
        rakeCents: 5,
        eloDelta: 16,
        fairnessCommit: 'c'.repeat(64),
        serverSeed: 's'.repeat(64),
      });
      await store.close();
    });

    it('clears queues', async () => {
      const store = make();
      await store.init();
      await store.queuePush(25, 's1');
      await store.queuePush(25, 's2');
      await store.queueRemove('s1');
      await store.queueClear();
      await store.close();
    });
  });
}

storeContract('MemoryStore', () => new MemoryStore());

const REDIS_URL = process.env.REDIS_URL;
const DATABASE_URL = process.env.DATABASE_URL;
if (REDIS_URL && DATABASE_URL) {
  storeContract(
    'PersistentStore',
    () => new PersistentStore(REDIS_URL, DATABASE_URL),
    async () => {
      const store = new PersistentStore(REDIS_URL, DATABASE_URL);
      await store.init();
      await store.deleteSession('tok1');
      await store.deleteRoom('g1');
      await store.queueClear();
      await store.close();
    },
  );
} else {
  describe.skip('PersistentStore (set REDIS_URL + DATABASE_URL to run)', () => {
    it('skipped', () => {});
  });
}

describe('Room snapshot/restore', () => {
  it('restores state, dice index and streaks; the game continues identically', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    const room = new Room('g2', 25, a, b, createFairness('x'.repeat(16), 'y'.repeat(16)));
    room.start();
    // play a few turns deterministically (commit-reveal dice are reproducible)
    for (let i = 0; i < 6 && !room.isOver(); i++) {
      const st = room.getState();
      if (st.phase === 'awaiting-roll') room.roll(st.turn);
      else if (st.phase === 'awaiting-move' && st.legal.length > 0) room.move(st.turn, st.legal[0]!);
    }
    const snap = room.toSnapshot();
    room.suspend();

    const a2 = makeClient('a');
    const b2 = makeClient('b');
    const restored = Room.fromSnapshot(JSON.parse(JSON.stringify(snap)), a2, b2);
    expect(restored.getState()).toEqual(room.getState());
    expect(restored.toSnapshot()).toEqual(snap);

    // same fairness seed + same dice index -> the next roll matches on both rooms
    if (!room.isOver() && room.getState().phase === 'awaiting-roll') {
      const turn = room.getState().turn;
      room.roll(turn);
      restored.roll(turn);
      expect(restored.getState()).toEqual(room.getState());
    }
    room.suspend();
    restored.suspend();
  });

  it('attach resyncs a reconnecting client with state and turn deadline', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    const room = new Room('g3', 0, a, b, createFairness('x'.repeat(16), 'y'.repeat(16)));
    room.start();
    const late = makeClient('a');
    room.attach(0, late);
    const types = late.inbox.map((m) => m.t);
    expect(types).toEqual(['game.state', 'game.turn']);
    room.suspend();
  });

  it('fires onChange on every transition and onResult once at the end', () => {
    const a = makeClient('a');
    const b = makeClient('b');
    const room = new Room('g4', 25, a, b, createFairness('x'.repeat(16), 'y'.repeat(16)));
    let changes = 0;
    let results = 0;
    room.onChange = () => changes++;
    room.onResult = (r) => {
      results++;
      expect(r.gameId).toBe('g4');
      expect(r.payoutCents + r.rakeCents).toBe(50);
    };
    room.start();
    expect(changes).toBeGreaterThan(0);
    room.resign(1);
    expect(results).toBe(1);
    expect(room.isOver()).toBe(true);
    room.suspend();
  });
});
