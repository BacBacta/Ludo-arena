import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { gameIdToBytes32, commitToBytes32, stakeInEscrow, stakeInEscrowN, stakeUnits, cosmeticItemId } from '../src/lib/escrow';

// Deterministic wallet-integration tests (Phase 3): the on-chain stake flow is
// driven against FAKE viem clients so transaction signing, the approve/join
// sequence, idempotency and — critically — SIGNATURE REFUSAL are covered in CI
// without a browser or a real chain. Real end-to-end signing is exercised
// manually on Celo Sepolia (e2e/staked/).

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const TOKEN = '0x1111111111111111111111111111111111111111' as Address;
const ESCROW = '0x2222222222222222222222222222222222222222' as Address;
const ME = '0x00000000000000000000000000000000000000aa' as Address;
const GAME = 'a'.repeat(32); // 16-byte server gameId (32 hex chars)
const COMMIT = 'b'.repeat(64); // sha256(serverSeed) hex (32 bytes)

interface Over {
  decimals?: number;
  allowance?: bigint;
  games?: readonly unknown[];
  /** Sequenced `games` reads (one per call, last repeats) — models a retry that
   *  re-checks the escrow and finds the previous attempt's deposit landed. */
  gamesSeq?: Array<readonly unknown[]>;
  seats?: readonly Address[];
  receiptStatus?: 'success' | 'reverted';
  /** Sequenced receipt statuses (one per wait, last repeats) — models a tx that
   *  reverts once then succeeds on the retry. */
  receiptStatuses?: Array<'success' | 'reverted'>;
  /** Throw on the FIRST waitForTransactionReceipt only (lost receipt). */
  receiptThrowOnce?: unknown;
  rejectWrite?: unknown;
  /** Throw on the FIRST writeContract only (transient broadcast failure). */
  rejectWriteOnce?: unknown;
}

function fakeClients(over: Over = {}) {
  const writes: Array<{ functionName: string; args: readonly unknown[]; feeCurrency?: unknown }> = [];
  let gamesCalls = 0;
  let receiptCalls = 0;
  let writeOnceArmed = over.rejectWriteOnce !== undefined;
  let receiptThrowArmed = over.receiptThrowOnce !== undefined;
  const publicClient = {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'decimals') return over.decimals ?? 6;
      if (functionName === 'games') {
        if (over.gamesSeq) {
          const g = over.gamesSeq[Math.min(gamesCalls, over.gamesSeq.length - 1)]!;
          gamesCalls++;
          return g;
        }
        return over.games ?? [TOKEN, 0n, ZERO, ZERO, 0, 0, 0];
      }
      if (functionName === 'allowance') return over.allowance ?? 0n;
      if (functionName === 'seatsOf') return over.seats ?? [];
      throw new Error(`unexpected read ${functionName}`);
    },
    waitForTransactionReceipt: async () => {
      if (receiptThrowArmed) {
        receiptThrowArmed = false;
        throw over.receiptThrowOnce;
      }
      if (over.receiptStatuses) {
        const s = over.receiptStatuses[Math.min(receiptCalls, over.receiptStatuses.length - 1)]!;
        receiptCalls++;
        return { status: s };
      }
      return { status: over.receiptStatus ?? 'success' };
    },
  };
  const walletClient = {
    chain: { id: 11_142_220 },
    account: undefined, // injected wallet (MiniPay) → signer is the passed account
    writeContract: async (a: { functionName: string; args: readonly unknown[]; feeCurrency?: unknown }) => {
      writes.push(a);
      if (writeOnceArmed) {
        writeOnceArmed = false;
        throw over.rejectWriteOnce;
      }
      if (over.rejectWrite) throw over.rejectWrite;
      return `0x${writes.length.toString(16).padStart(64, '0')}` as Hex;
    },
  };
  return { publicClient: publicClient as unknown as never, walletClient: walletClient as unknown as never, writes };
}

describe('gameIdToBytes32', () => {
  it('left-pads a 16-byte server gameId to bytes32', () => {
    expect(gameIdToBytes32(GAME)).toBe(`0x${'0'.repeat(32)}${'a'.repeat(32)}`);
  });
  it('accepts a 0x-prefixed id and throws on non-hex', () => {
    expect(gameIdToBytes32(`0x${GAME}`)).toBe(`0x${'0'.repeat(32)}${'a'.repeat(32)}`);
    expect(() => gameIdToBytes32('nothex!!')).toThrow(/not hex/);
  });
});

describe('stakeUnits', () => {
  it('converts cents → token base units by decimals', () => {
    expect(stakeUnits(25, 6)).toBe(250_000n); // 0.25 USDT (6 dec)
    expect(stakeUnits(100, 18)).toBe(10n ** 18n); // 1.00 (18 dec)
    expect(() => stakeUnits(25, 1)).toThrow(/decimals < 2/);
  });
});

describe('cosmeticItemId', () => {
  it('is deterministic keccak256 of the id', () => {
    expect(cosmeticItemId('gold')).toBe(cosmeticItemId('gold'));
    expect(cosmeticItemId('gold')).not.toBe(cosmeticItemId('silver'));
  });
});

describe('stakeInEscrow (1v1)', () => {
  it('approves then joins with the right args when the allowance is short', async () => {
    const { publicClient, walletClient, writes } = fakeClients({ allowance: 0n, decimals: 6 });
    const statuses: string[] = [];
    const r = await stakeInEscrow({ walletClient, publicClient, account: ME, escrow: ESCROW, token: TOKEN, gameId: GAME, stakeCents: 25, fairnessCommit: COMMIT, onStatus: (s) => statuses.push(s) });
    expect(writes.map((w) => w.functionName)).toEqual(['approve', 'join']);
    expect(writes[1]!.args).toEqual([gameIdToBytes32(GAME), TOKEN, 250_000n, commitToBytes32(COMMIT)]); // join(gameId32, token, stakeUnits, commit)
    expect(statuses).toEqual(['approving', 'joining', 'locked']);
    expect(r.stake).toBe(250_000n);
  });

  it('skips approve when the allowance already covers the stake', async () => {
    const { publicClient, walletClient, writes } = fakeClients({ allowance: 10n ** 18n, decimals: 6 });
    await stakeInEscrow({ walletClient, publicClient, account: ME, escrow: ESCROW, token: TOKEN, gameId: GAME, stakeCents: 25, fairnessCommit: COMMIT });
    expect(writes.map((w) => w.functionName)).toEqual(['join']); // no approve
  });

  it('is idempotent: an address that already joined does NOT lock a second time', async () => {
    // games getter returns playerA == ME → already deposited.
    const { publicClient, walletClient, writes } = fakeClients({ games: [TOKEN, 250_000n, ME, ZERO, 0, 2, 900] });
    const r = await stakeInEscrow({ walletClient, publicClient, account: ME, escrow: ESCROW, token: TOKEN, gameId: GAME, stakeCents: 25, fairnessCommit: COMMIT });
    expect(writes).toEqual([]); // no tx sent
    expect(r.joinTx).toBe('0x');
  });

  it('passes MiniPay feeCurrency through to the txs', async () => {
    const { publicClient, walletClient, writes } = fakeClients({ allowance: 0n });
    await stakeInEscrow({ walletClient, publicClient, account: ME, escrow: ESCROW, token: TOKEN, gameId: GAME, stakeCents: 25, fairnessCommit: COMMIT, feeCurrency: TOKEN });
    for (const w of writes) expect(w.feeCurrency).toBe(TOKEN);
  });

  it('propagates a SIGNATURE REFUSAL (user rejects the tx)', async () => {
    const rejection = Object.assign(new Error('User rejected the request'), { code: 4001 });
    const { publicClient, walletClient } = fakeClients({ allowance: 0n, rejectWrite: rejection });
    await expect(
      stakeInEscrow({ walletClient, publicClient, account: ME, escrow: ESCROW, token: TOKEN, gameId: GAME, stakeCents: 25, fairnessCommit: COMMIT }),
    ).rejects.toThrow(/User rejected/);
  });

  it('throws when the join tx PERSISTENTLY reverts on-chain (retry exhausted)', async () => {
    const { publicClient, walletClient } = fakeClients({ allowance: 10n ** 18n, receiptStatus: 'reverted' });
    await expect(
      stakeInEscrow({ walletClient, publicClient, account: ME, escrow: ESCROW, token: TOKEN, gameId: GAME, stakeCents: 25, fairnessCommit: COMMIT, retryDelayMs: 0 }),
    ).rejects.toThrow(/join reverted/);
  });

  // The 'Stake not locked — reverted' incident: one player's lock failed
  // intermittently on the load-balanced RPC (a lagging node estimated the join
  // against a state where the approve wasn't visible yet, or a spike-window tx
  // mined as a revert). A revert moves NO funds, so one retry is money-safe —
  // and each attempt re-checks the escrow first so a lost-receipt success can
  // never double-lock.

  it('retries once when the join broadcast fails transiently, then locks', async () => {
    const boom = new Error('Execution reverted for an unknown reason.');
    const { publicClient, walletClient, writes } = fakeClients({ allowance: 10n ** 18n, rejectWriteOnce: boom });
    const r = await stakeInEscrow({ walletClient, publicClient, account: ME, escrow: ESCROW, token: TOKEN, gameId: GAME, stakeCents: 25, fairnessCommit: COMMIT, retryDelayMs: 0 });
    expect(writes.map((w) => w.functionName)).toEqual(['join', 'join']); // failed + retried
    expect(r.joinTx).not.toBe('0x');
  });

  it('retries once when the join MINES as a revert (no funds moved), then locks', async () => {
    const { publicClient, walletClient, writes } = fakeClients({ allowance: 10n ** 18n, receiptStatuses: ['reverted', 'success'] });
    const r = await stakeInEscrow({ walletClient, publicClient, account: ME, escrow: ESCROW, token: TOKEN, gameId: GAME, stakeCents: 25, fairnessCommit: COMMIT, retryDelayMs: 0 });
    expect(writes.map((w) => w.functionName)).toEqual(['join', 'join']);
    expect(r.joinTx).not.toBe('0x');
  });

  it('NEVER double-locks: a lost receipt whose join actually landed is detected on retry', async () => {
    const { publicClient, walletClient, writes } = fakeClients({
      allowance: 10n ** 18n,
      receiptThrowOnce: new Error('Timed out while waiting for transaction receipt'),
      // 1st games read: empty (pre-join). 2nd (the retry's re-check): WE are deposited.
      gamesSeq: [[TOKEN, 0n, ZERO, ZERO, 0, 0, 0], [TOKEN, 250_000n, ME, ZERO, 0, 1, 900]],
    });
    const r = await stakeInEscrow({ walletClient, publicClient, account: ME, escrow: ESCROW, token: TOKEN, gameId: GAME, stakeCents: 25, fairnessCommit: COMMIT, retryDelayMs: 0 });
    expect(writes.map((w) => w.functionName)).toEqual(['join']); // ONE join only — no double lock
    expect(r.joinTx).toBe('0x'); // resolved via the already-deposited path
  });

  it('does NOT retry a user signature refusal (no second wallet prompt)', async () => {
    const rejection = Object.assign(new Error('User rejected the request'), { code: 4001 });
    const { publicClient, walletClient, writes } = fakeClients({ allowance: 0n, rejectWrite: rejection });
    await expect(
      stakeInEscrow({ walletClient, publicClient, account: ME, escrow: ESCROW, token: TOKEN, gameId: GAME, stakeCents: 25, fairnessCommit: COMMIT, retryDelayMs: 0 }),
    ).rejects.toThrow(/User rejected/);
    expect(writes.length).toBe(1); // one prompt, one refusal — never nag again
  });
});

describe('stakeInEscrowN (4-player)', () => {
  it('joins with seatCount and is idempotent on an already-seated address', async () => {
    const { publicClient, walletClient, writes } = fakeClients({ allowance: 10n ** 18n, seats: [] });
    await stakeInEscrowN({ walletClient, publicClient, account: ME, escrow: ESCROW, token: TOKEN, gameId: GAME, stakeCents: 25, fairnessCommit: COMMIT, seatCount: 4 });
    expect(writes[0]!.functionName).toBe('join');
    expect(writes[0]!.args).toEqual([gameIdToBytes32(GAME), TOKEN, 250_000n, 4, commitToBytes32(COMMIT)]); // seatCount + commit included

    const seated = fakeClients({ seats: [ME] });
    const r = await stakeInEscrowN({ walletClient: seated.walletClient, publicClient: seated.publicClient, account: ME, escrow: ESCROW, token: TOKEN, gameId: GAME, stakeCents: 25, fairnessCommit: COMMIT, seatCount: 4 });
    expect(seated.writes).toEqual([]); // already seated → no second deposit
    expect(r.joinTx).toBe('0x');
  });

  it('propagates a signature refusal on the 4p path too', async () => {
    const { publicClient, walletClient } = fakeClients({ allowance: 0n, rejectWrite: Object.assign(new Error('User rejected'), { code: 4001 }) });
    await expect(
      stakeInEscrowN({ walletClient, publicClient, account: ME, escrow: ESCROW, token: TOKEN, gameId: GAME, stakeCents: 25, fairnessCommit: COMMIT, seatCount: 4 }),
    ).rejects.toThrow(/User rejected/);
  });
});
