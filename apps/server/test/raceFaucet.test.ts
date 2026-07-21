import { describe, expect, it, vi } from 'vitest';
import { celo } from 'viem/chains';
import type { Hex } from 'viem';
import { faucetFailureMessage, RaceFaucet } from '../src/race.js';

// Reproduces the live "Funding failed — try again in a moment" incident: the
// faucet's transfer intermittently fails at BROADCAST time (a load-balanced RPC
// hands out a stale pending nonce right after a previous faucet tx — exactly the
// seed → mint → claim sequence, where the claim transfer follows the seed
// transfer within a minute). The fix under test: fund() retries the broadcast
// ONCE (a failed broadcast never reached the chain, so a retry cannot
// double-spend), and NEVER resends once it holds a tx hash.

const CFG = { quotaCents: 10, poolCents: 3000, jit: true, perGameCents: 2, feeInStable: true, seedCents: 10 };
const PK = ('0x' + '11'.repeat(32)) as Hex;
const TOKEN = '0x765DE816845861e75A25fCA122bb6898B8B1282a';
const PASS = '0x3ca68B8a7e2C429dEc33a34e0589173DFb305BE4';

/** A RaceFaucet whose chain clients are stubbed — fund()'s real control flow
 *  (broadcast → retry policy → receipt check) runs against scripted outcomes. */
function stubbedFaucet(outcomes: Array<'ok' | 'broadcast-fail'>, receiptStatus: 'success' | 'reverted' = 'success') {
  const faucet = new RaceFaucet(celo, PASS, TOKEN, PK, CFG);
  let call = 0;
  const writeContract = vi.fn(async () => {
    const o = outcomes[Math.min(call, outcomes.length - 1)];
    call++;
    if (o === 'broadcast-fail') throw new Error('replacement transaction underpriced: nonce too low');
    return ('0x' + 'ab'.repeat(32)) as Hex;
  });
  const waitForTransactionReceipt = vi.fn(async () => ({ status: receiptStatus }));
  const internals = faucet as unknown as {
    walletClient: unknown;
    publicClient: unknown;
    decimalsCache: number | null;
  };
  internals.decimalsCache = 18; // skip the on-chain decimals() read
  internals.walletClient = { writeContract };
  internals.publicClient = { waitForTransactionReceipt };
  return { faucet, writeContract, waitForTransactionReceipt };
}

describe('fund() broadcast retry (the intermittent "Funding failed" incident)', () => {
  it('a transient broadcast failure is absorbed by ONE retry — the grant lands', async () => {
    const { faucet, writeContract, waitForTransactionReceipt } = stubbedFaucet(['broadcast-fail', 'ok']);
    const hash = await faucet.fund(TOKEN, 2, 0); // 0ms retry delay in tests
    expect(hash).toMatch(/^0x/);
    expect(writeContract).toHaveBeenCalledTimes(2); // failed broadcast → one retry
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it('a healthy broadcast is sent exactly once (no gratuitous resend)', async () => {
    const { faucet, writeContract } = stubbedFaucet(['ok']);
    await faucet.fund(TOKEN, 2, 0);
    expect(writeContract).toHaveBeenCalledTimes(1);
  });

  it('a persistent broadcast failure still surfaces (no infinite retry)', async () => {
    const { faucet, writeContract } = stubbedFaucet(['broadcast-fail', 'broadcast-fail']);
    await expect(faucet.fund(TOKEN, 2, 0)).rejects.toThrow('nonce too low');
    expect(writeContract).toHaveBeenCalledTimes(2); // exactly one retry, then give up
  });

  it('NEVER resends after a hash exists — a mined revert throws without retrying', async () => {
    const { faucet, writeContract } = stubbedFaucet(['ok'], 'reverted');
    await expect(faucet.fund(TOKEN, 2, 0)).rejects.toThrow('faucet transfer reverted');
    expect(writeContract).toHaveBeenCalledTimes(1); // resending here could double-pay
  });
});

describe('faucet failure message (what the player sees in the toast)', () => {
  it('a DRY faucet says so — the one failure retrying can never fix', () => {
    expect(faucetFailureMessage('claim', 3, 2, 'transfer amount exceeds balance')).toContain('out of funds');
  });
  it('a funded faucet surfaces the real cause, labelled per path', () => {
    const m = faucetFailureMessage('claim', 500, 2, 'nonce too low');
    expect(m).toContain('Funding failed');
    expect(m).toContain('nonce too low');
    expect(faucetFailureMessage('seed', 500, 10, 'nonce too low')).toContain('Gas seed failed');
  });
  it('an unreadable balance never claims "dry" — it shows the cause instead', () => {
    expect(faucetFailureMessage('claim', null, 2, 'boom')).toContain('boom');
  });
  it('long causes are truncated to keep the toast sane', () => {
    const m = faucetFailureMessage('claim', 500, 2, 'x'.repeat(500));
    expect(m.length).toBeLessThan(200);
  });
});
