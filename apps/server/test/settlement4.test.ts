import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { GameStatusN, JOIN_TIMEOUT_N_S, SettlementQueue4, type ArbiterNLike } from '../src/settlement4.js';
import { MemoryStore } from '../src/store/memory.js';

const WINNER = '0x1111111111111111111111111111111111111111' as Address;
const SEAT_B = '0x2222222222222222222222222222222222222222' as Address;
const SEAT_C = '0x3333333333333333333333333333333333333333' as Address;
const SEAT_D = '0x4444444444444444444444444444444444444444' as Address;
const SEATS: Address[] = [WINNER, SEAT_B, SEAT_C, SEAT_D];
const TX = '0xset4' as Hex;
const REFUND_TX = '0xref4' as Hex;

function makeArbiterN(over: Partial<ArbiterNLike> = {}): ArbiterNLike {
  return {
    chainId: 11_142_220,
    gameStatus: async () => ({ status: GameStatusN.Active, seatCount: 4, joined: 4, createdAt: 0 }),
    seatsOf: async () => SEATS,
    submitSettle: async () => TX,
    submitRefundUnfilled: async () => REFUND_TX,
    ...over,
  };
}

describe('SettlementQueue4', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('settles an Active job whose winner is a seat, notifies, and persists the tx', async () => {
    const store = new MemoryStore();
    const settled: Array<[string, string]> = [];
    const q = new SettlementQueue4({
      store,
      arbiter: makeArbiterN(),
      onSettled: (gameId, tx) => settled.push([gameId, tx]),
      onRefunded: () => {},
    });
    await q.enqueue('g1', WINNER);
    await vi.runOnlyPendingTimersAsync();

    expect(settled).toEqual([['g1', TX]]);
    expect(await store.listPendingSettlements()).toEqual([]);
  });

  it('marks failed (no submit) when nobody staked (status None)', async () => {
    const store = new MemoryStore();
    const submit = vi.fn(async () => TX);
    const q = new SettlementQueue4({
      store,
      arbiter: makeArbiterN({ gameStatus: async () => ({ status: GameStatusN.None, seatCount: 4, joined: 0, createdAt: 0 }), submitSettle: submit }),
      onSettled: () => {},
      onRefunded: () => {},
    });
    await q.enqueue('g2', WINNER);
    await vi.runOnlyPendingTimersAsync();

    expect(submit).not.toHaveBeenCalled();
    expect(await store.listPendingSettlements()).toEqual([]);
  });

  it('does NOT settle when the winner is not an on-chain seat (mismatch → failed)', async () => {
    const store = new MemoryStore();
    const submit = vi.fn(async () => TX);
    const q = new SettlementQueue4({
      store,
      arbiter: makeArbiterN({
        // active table, but WINNER is not among the actual seats → settle() would revert
        seatsOf: async () => [SEAT_B, SEAT_C, SEAT_D],
        submitSettle: submit,
      }),
      onSettled: () => {},
      onRefunded: () => {},
    });
    await q.enqueue('gm', WINNER);
    await vi.runOnlyPendingTimersAsync();

    expect(submit).not.toHaveBeenCalled();
    expect(await store.listPendingSettlements()).toEqual([]); // marked failed, not retried forever
  });

  it('refunds an unfilled table once the join timeout has elapsed', async () => {
    const store = new MemoryStore();
    const refunded: Array<[string, string]> = [];
    const q = new SettlementQueue4({
      store,
      arbiter: makeArbiterN({ gameStatus: async () => ({ status: GameStatusN.Filling, seatCount: 4, joined: 2, createdAt: 500 }) }),
      onSettled: () => {},
      onRefunded: (gameId, tx) => refunded.push([gameId, tx]),
      now: () => 500 + JOIN_TIMEOUT_N_S + 1, // already past the timeout
    });
    await q.enqueueRefundUnfilled('g3');
    await vi.runOnlyPendingTimersAsync();

    expect(refunded).toEqual([['g3', REFUND_TX]]);
    expect(await store.listPendingSettlements()).toEqual([]);
  });

  it('waits for the timeout window before refunding, then refunds', async () => {
    const store = new MemoryStore();
    const refund = vi.fn(async () => REFUND_TX);
    let now = 1_000;
    const q = new SettlementQueue4({
      store,
      arbiter: makeArbiterN({ gameStatus: async () => ({ status: GameStatusN.Filling, seatCount: 4, joined: 3, createdAt: 1_000 }), submitRefundUnfilled: refund }),
      onSettled: () => {},
      onRefunded: () => {},
      now: () => now,
    });
    await q.enqueueRefundUnfilled('g4');
    await vi.runOnlyPendingTimersAsync();
    expect(refund).not.toHaveBeenCalled(); // still inside the 120 s window
    expect(await store.listPendingSettlements()).toHaveLength(1); // rescheduled, still pending

    now = 1_000 + JOIN_TIMEOUT_N_S + 1;
    await vi.runAllTimersAsync();
    expect(refund).toHaveBeenCalledOnce();
  });

  it('is idempotent when the game is already Settled on-chain', async () => {
    const store = new MemoryStore();
    const submit = vi.fn(async () => TX);
    const q = new SettlementQueue4({
      store,
      arbiter: makeArbiterN({ gameStatus: async () => ({ status: GameStatusN.Settled, seatCount: 4, joined: 4, createdAt: 0 }), submitSettle: submit }),
      onSettled: () => {},
      onRefunded: () => {},
    });
    await q.enqueue('g5', WINNER);
    await vi.runOnlyPendingTimersAsync();

    expect(submit).not.toHaveBeenCalled();
    expect(await store.listPendingSettlements()).toEqual([]);
  });

  it('retries with backoff and eventually settles', async () => {
    const store = new MemoryStore();
    let calls = 0;
    const q = new SettlementQueue4({
      store,
      arbiter: makeArbiterN({
        submitSettle: async () => {
          calls += 1;
          if (calls < 3) throw new Error('rpc hiccup');
          return TX;
        },
      }),
      onSettled: () => {},
      onRefunded: () => {},
    });
    await q.enqueue('g6', WINNER);
    await vi.runAllTimersAsync();

    expect(calls).toBe(3);
    expect(await store.listPendingSettlements()).toEqual([]);
  });

  it('gives up after the max attempts and marks the job failed', async () => {
    const store = new MemoryStore();
    const alerts: string[] = [];
    const q = new SettlementQueue4({
      store,
      arbiter: makeArbiterN({
        submitSettle: async () => {
          throw new Error('always down');
        },
      }),
      onSettled: () => {},
      onRefunded: () => {},
      onAlert: (m) => alerts.push(m),
    });
    await q.enqueue('g7', WINNER);
    await vi.runAllTimersAsync();

    expect(await store.listPendingSettlements()).toEqual([]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('PAYOUT FAILED');
  });

  it('resumePending re-processes only 4p jobs (leaves 2p jobs to the 1v1 queue)', async () => {
    const store = new MemoryStore();
    await store.enqueueSettlement({ gameId: 'four', winnerWallet: WINNER, chainId: 11_142_220, status: 'pending', attempts: 0, variant: '4p' });
    await store.enqueueSettlement({ gameId: 'two', winnerWallet: WINNER, chainId: 11_142_220, status: 'pending', attempts: 0, variant: '2p' });
    await store.enqueueSettlement({ gameId: 'other-chain', winnerWallet: WINNER, chainId: 42_220, status: 'pending', attempts: 0, variant: '4p' });
    const settled: string[] = [];
    const q = new SettlementQueue4({ store, arbiter: makeArbiterN(), onSettled: (g) => settled.push(g), onRefunded: () => {} });

    await q.resumePending();
    await vi.runOnlyPendingTimersAsync();

    expect(settled).toEqual(['four']); // not 'two' (2p) and not 'other-chain'
    // the untouched 2p job stays pending for the 1v1 queue to pick up
    const stillPending = (await store.listPendingSettlements()).map((j) => j.gameId).sort();
    expect(stillPending).toEqual(['other-chain', 'two']);
  });
});
