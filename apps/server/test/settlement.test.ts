import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { GameStatus, JOIN_TIMEOUT_S, SettlementQueue, type ArbiterLike } from '../src/settlement.js';
import { MemoryStore } from '../src/store/memory.js';

const WINNER = '0x1111111111111111111111111111111111111111';
const PLAYER_B = '0x2222222222222222222222222222222222222222';
const TX = '0xset' as Hex;
const REFUND_TX = '0xref' as Hex;
const VOID_TX = '0xvoid' as Hex;

function makeArbiter(over: Partial<ArbiterLike> = {}): ArbiterLike {
  return {
    chainId: 11_142_220,
    gameStatus: async () => ({ status: GameStatus.Active, createdAt: 0, playerA: WINNER, playerB: PLAYER_B }),
    submitSettle: async () => TX,
    submitRefund: async () => REFUND_TX,
    submitVoid: async () => VOID_TX,
    ...over,
  };
}

describe('SettlementQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('settles an Active job, notifies, and persists the tx hash', async () => {
    const store = new MemoryStore();
    const settled: Array<[string, string]> = [];
    const q = new SettlementQueue({
      store,
      arbiter: makeArbiter(),
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
    const q = new SettlementQueue({
      store,
      arbiter: makeArbiter({ gameStatus: async () => ({ status: GameStatus.None, createdAt: 0, playerA: WINNER, playerB: PLAYER_B }), submitSettle: submit }),
      onSettled: () => {},
      onRefunded: () => {},
    });
    await q.enqueue('g2', WINNER);
    await vi.runOnlyPendingTimersAsync();

    expect(submit).not.toHaveBeenCalled();
    expect(await store.listPendingSettlements()).toEqual([]);
  });

  it('does NOT settle when the winner is not an on-chain depositor (mismatch → failed)', async () => {
    const store = new MemoryStore();
    const submit = vi.fn(async () => TX);
    const q = new SettlementQueue({
      store,
      arbiter: makeArbiter({
        // active game, but neither depositor is WINNER → settle() would revert NotAPlayer
        gameStatus: async () => ({ status: GameStatus.Active, createdAt: 0, playerA: PLAYER_B, playerB: PLAYER_B }),
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

  it('refunds a lone staker once the join timeout has elapsed (E3.4)', async () => {
    const store = new MemoryStore();
    const refunded: Array<[string, string]> = [];
    const q = new SettlementQueue({
      store,
      arbiter: makeArbiter({ gameStatus: async () => ({ status: GameStatus.WaitingOpponent, createdAt: 500, playerA: WINNER, playerB: PLAYER_B }) }),
      onSettled: () => {},
      onRefunded: (gameId, tx) => refunded.push([gameId, tx]),
      now: () => 500 + JOIN_TIMEOUT_S + 1, // already past the timeout
    });
    await q.enqueue('g3', WINNER);
    await vi.runOnlyPendingTimersAsync();

    expect(refunded).toEqual([['g3', REFUND_TX]]);
    expect(await store.listPendingSettlements()).toEqual([]);
  });

  it('waits for the timeout window before refunding, then refunds', async () => {
    const store = new MemoryStore();
    const refund = vi.fn(async () => REFUND_TX);
    let now = 1_000;
    const q = new SettlementQueue({
      store,
      arbiter: makeArbiter({ gameStatus: async () => ({ status: GameStatus.WaitingOpponent, createdAt: 1_000, playerA: WINNER, playerB: PLAYER_B }), submitRefund: refund }),
      onSettled: () => {},
      onRefunded: () => {},
      now: () => now,
    });
    await q.enqueue('g4', WINNER);
    await vi.runOnlyPendingTimersAsync();
    expect(refund).not.toHaveBeenCalled(); // still inside the 120 s window
    expect(await store.listPendingSettlements()).toHaveLength(1); // rescheduled, still pending

    now = 1_000 + JOIN_TIMEOUT_S + 1;
    await vi.runAllTimersAsync();
    expect(refund).toHaveBeenCalledOnce();
  });

  it('is idempotent when the game is already Settled on-chain', async () => {
    const store = new MemoryStore();
    const submit = vi.fn(async () => TX);
    const q = new SettlementQueue({
      store,
      arbiter: makeArbiter({ gameStatus: async () => ({ status: GameStatus.Settled, createdAt: 0, playerA: WINNER, playerB: PLAYER_B }), submitSettle: submit }),
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
    const q = new SettlementQueue({
      store,
      arbiter: makeArbiter({
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
    const q = new SettlementQueue({
      store,
      arbiter: makeArbiter({
        submitSettle: async () => {
          throw new Error('always down');
        },
      }),
      onSettled: () => {},
      onRefunded: () => {},
    });
    await q.enqueue('g7', WINNER);
    await vi.runAllTimersAsync();

    expect(await store.listPendingSettlements()).toEqual([]);
  });

  // ---- R-SETTLE-1: a refund-only job (no winner) recovers a stranded deposit ----

  it('refund job voids an Active game (both stakes locked, match must not proceed)', async () => {
    const store = new MemoryStore();
    const voidFn = vi.fn(async () => VOID_TX);
    const settle = vi.fn(async () => TX);
    const refunded: Array<[string, string]> = [];
    const q = new SettlementQueue({
      store,
      arbiter: makeArbiter({
        gameStatus: async () => ({ status: GameStatus.Active, createdAt: 0, playerA: WINNER, playerB: PLAYER_B }),
        submitVoid: voidFn,
        submitSettle: settle,
      }),
      onSettled: () => {},
      onRefunded: (gameId, tx) => refunded.push([gameId, tx]),
    });
    await q.enqueueRefund('gr1');
    await vi.runOnlyPendingTimersAsync();

    expect(voidFn).toHaveBeenCalledOnce();
    expect(settle).not.toHaveBeenCalled(); // a refund job never pays a winner
    expect(refunded).toEqual([['gr1', VOID_TX]]);
    expect(await store.listPendingSettlements()).toEqual([]);
  });

  it('refund job refunds a lone staker (WaitingOpponent) past the timeout', async () => {
    const store = new MemoryStore();
    const refund = vi.fn(async () => REFUND_TX);
    const refunded: Array<[string, string]> = [];
    const q = new SettlementQueue({
      store,
      arbiter: makeArbiter({
        gameStatus: async () => ({ status: GameStatus.WaitingOpponent, createdAt: 500, playerA: WINNER, playerB: PLAYER_B }),
        submitRefund: refund,
      }),
      onSettled: () => {},
      onRefunded: (gameId, tx) => refunded.push([gameId, tx]),
      now: () => 500 + JOIN_TIMEOUT_S + 1,
    });
    await q.enqueueRefund('gr2');
    await vi.runOnlyPendingTimersAsync();

    expect(refund).toHaveBeenCalledOnce();
    expect(refunded).toEqual([['gr2', REFUND_TX]]);
  });

  it('refund job is a clean no-op when nobody staked (status None)', async () => {
    const store = new MemoryStore();
    const voidFn = vi.fn(async () => VOID_TX);
    const refund = vi.fn(async () => REFUND_TX);
    const refunded: string[] = [];
    const q = new SettlementQueue({
      store,
      arbiter: makeArbiter({
        gameStatus: async () => ({ status: GameStatus.None, createdAt: 0, playerA: WINNER, playerB: PLAYER_B }),
        submitVoid: voidFn,
        submitRefund: refund,
      }),
      onSettled: () => {},
      onRefunded: (g) => refunded.push(g),
    });
    await q.enqueueRefund('gr3');
    await vi.runOnlyPendingTimersAsync();

    expect(voidFn).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
    expect(refunded).toEqual([]); // nothing to recover
    expect(await store.listPendingSettlements()).toEqual([]); // marked done, not retried
  });

  it('resumePending re-processes jobs from a previous run on the same chain', async () => {
    const store = new MemoryStore();
    await store.enqueueSettlement({ gameId: 'g8', winnerWallet: WINNER, chainId: 11_142_220, status: 'pending', attempts: 0 });
    await store.enqueueSettlement({ gameId: 'other-chain', winnerWallet: WINNER, chainId: 42_220, status: 'pending', attempts: 0 });
    const settled: string[] = [];
    const q = new SettlementQueue({ store, arbiter: makeArbiter(), onSettled: (g) => settled.push(g), onRefunded: () => {} });

    await q.resumePending();
    await vi.runOnlyPendingTimersAsync();

    expect(settled).toEqual(['g8']);
  });
});
