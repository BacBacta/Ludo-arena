import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { SettlementQueue, type ArbiterLike } from '../src/settlement.js';
import { MemoryStore } from '../src/store/memory.js';

const WINNER = '0x1111111111111111111111111111111111111111';
const TX = '0xabc' as Hex;

function makeArbiter(over: Partial<ArbiterLike> = {}): ArbiterLike {
  return {
    chainId: 11_142_220,
    isSettleable: async () => true,
    submitSettle: async () => TX,
    ...over,
  };
}

describe('SettlementQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('settles a job, notifies, and persists the tx hash', async () => {
    const store = new MemoryStore();
    const settled: Array<[string, string]> = [];
    const q = new SettlementQueue({
      store,
      arbiter: makeArbiter(),
      onSettled: (gameId, tx) => settled.push([gameId, tx]),
    });
    await q.enqueue('g1', WINNER);
    await vi.runOnlyPendingTimersAsync();

    expect(settled).toEqual([['g1', TX]]);
    expect(await store.listPendingSettlements()).toEqual([]); // no longer pending
  });

  it('skips (marks failed) when the game is not Active on-chain', async () => {
    const store = new MemoryStore();
    const submit = vi.fn();
    const q = new SettlementQueue({
      store,
      arbiter: makeArbiter({ isSettleable: async () => false, submitSettle: submit }),
      onSettled: () => {},
    });
    await q.enqueue('g2', WINNER);
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
    });
    await q.enqueue('g3', WINNER);
    // drive the backoff timers (1s, 2s, …) to completion
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
    });
    await q.enqueue('g4', WINNER);
    await vi.runAllTimersAsync();

    // failed jobs are not pending (won't be retried on next boot)
    expect(await store.listPendingSettlements()).toEqual([]);
  });

  it('resumePending re-processes jobs from a previous run on the same chain', async () => {
    const store = new MemoryStore();
    await store.enqueueSettlement({ gameId: 'g5', winnerWallet: WINNER, chainId: 11_142_220, status: 'pending', attempts: 0 });
    await store.enqueueSettlement({ gameId: 'other-chain', winnerWallet: WINNER, chainId: 42_220, status: 'pending', attempts: 0 });
    const settled: string[] = [];
    const q = new SettlementQueue({ store, arbiter: makeArbiter(), onSettled: (g) => settled.push(g) });

    await q.resumePending();
    await vi.runOnlyPendingTimersAsync();

    expect(settled).toEqual(['g5']); // only the matching-chain job
  });
});
