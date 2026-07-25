import { describe, expect, it } from 'vitest';
import { GasEstimateUnavailableError, RPC_BUSY_SENTINEL, mintFailureToast, BALANCED, planCapWei } from '../src/lib/feePlan';
import { planFeeExtras } from '../src/lib/escrow';

// THE RULE UNDER TEST: never tell a player their entry "is still being funded"
// unless that is the one thing we could not disprove. Every branch of the toast
// decision is anchored to a piece of evidence; this matrix pins all of them.

const base = { needGas: true, seedError: null as string | null, payGasInStable: true, miniPay: false, balCents: null as number | null, minCents: 4 };

describe('mintFailureToast — the evidence-anchored triage', () => {
  it('a non-gas failure is a claim failure, never a funding story', () => {
    expect(mintFailureToast({ ...base, needGas: false })).toEqual({ kind: 'key', key: 'raceClaimFailed' });
  });

  it("the server's own refusal beats every guess", () => {
    expect(mintFailureToast({ ...base, seedError: 'This device already used its gas-seed allowance.' }))
      .toEqual({ kind: 'server-words', text: 'This device already used its gas-seed allowance.' });
  });

  it('a NATIVE-gas wallet is told about the native coin', () => {
    expect(mintFailureToast({ ...base, payGasInStable: false })).toEqual({ kind: 'key', key: 'raceNeedGas' });
  });

  it('balance AT/ABOVE the floor proves funding landed → the failure is the node, retry is honest', () => {
    expect(mintFailureToast({ ...base, balCents: 10 })).toEqual({ kind: 'key', key: 'raceRpcBusy' });
    expect(mintFailureToast({ ...base, balCents: 4 })).toEqual({ kind: 'key', key: 'raceRpcBusy' });
  });

  it('balance BELOW the floor proves the seed did not land', () => {
    expect(mintFailureToast({ ...base, balCents: 0 })).toEqual({ kind: 'key', key: 'raceSeedStalled' });
    expect(mintFailureToast({ ...base, balCents: 3 })).toEqual({ kind: 'key', key: 'raceSeedStalled' });
  });

  it('MiniPay shares the evidence branches — it is seeded like a burner now', () => {
    expect(mintFailureToast({ ...base, miniPay: true, balCents: 10 })).toEqual({ kind: 'key', key: 'raceRpcBusy' });
    expect(mintFailureToast({ ...base, miniPay: true, balCents: 0 })).toEqual({ kind: 'key', key: 'raceSeedStalled' });
  });

  it('the unreadable-balance fallback: MiniPay can self-serve (top up), a burner cannot', () => {
    expect(mintFailureToast({ ...base, balCents: null })).toEqual({ kind: 'key', key: 'raceFundingPending' });
    expect(mintFailureToast({ ...base, miniPay: true, balCents: null })).toEqual({ kind: 'key', key: 'raceNeedStableGas' });
  });

  it('precedence: server words > native-gas > balance evidence', () => {
    expect(mintFailureToast({ ...base, seedError: 'pool dry', miniPay: true, balCents: 10 }).kind).toBe('server-words');
    expect(mintFailureToast({ ...base, payGasInStable: false, miniPay: true })).toEqual({ kind: 'key', key: 'raceNeedGas' });
  });
});

// THE C2 TRAP. Fee caps WITHOUT an explicit gas limit make viem re-estimate with
// the fee fields; the node then caps affordability against the NATIVE balance —
// 0 for a burner — and the tx dies with "gas required exceeds allowance (0)",
// a fake gas-shortfall the UI read as "still being funded". planFeeExtras must
// therefore never emit caps-without-gas: it retries the estimate, then throws
// typed instead of arming the trap.

const GWEI = 1_000_000_000n;
const CUSD = '0x765DE816845861e75A25fCA122bb6898B8B1282a' as const;
const NODE_QUOTE = 13_820_000_000n;

function clientWithFlakyEstimate(failures: number) {
  let calls = 0;
  return {
    client: {
      readContract: async (r: { functionName: string }) => {
        if (r.functionName === 'getAddressForString') return CUSD;
        if (r.functionName === 'getExchangeRate') return [68_247n, 1_000_000n];
        throw new Error(`unexpected read ${r.functionName}`);
      },
      getBlock: async () => ({ baseFeePerGas: 200n * GWEI }),
      request: async () => `0x${NODE_QUOTE.toString(16)}`,
      estimateContractGas: async () => {
        calls += 1;
        if (calls <= failures) throw new Error('429 too many requests');
        return 120_000n;
      },
    } as never,
    calls: () => calls,
  };
}

const req = { address: CUSD, abi: [], functionName: 'mint', args: [], account: CUSD } as never;

describe('planFeeExtras never arms the C2 trap', () => {
  it('retries a failed estimate and succeeds on the second try', async () => {
    const { client, calls } = clientWithFlakyEstimate(1);
    const extras = await planFeeExtras(client, CUSD, BALANCED, req, true);
    expect(calls()).toBe(2);
    expect(typeof extras.gas).toBe('bigint'); // caps AND gas, or neither
    expect(extras.maxFeePerGas).toBe(planCapWei(BALANCED, NODE_QUOTE));
  });

  it('throws typed (retriable) when the estimate keeps failing — no caps-without-gas ever escape', async () => {
    const { client } = clientWithFlakyEstimate(99);
    await expect(planFeeExtras(client, CUSD, BALANCED, req, true)).rejects.toBeInstanceOf(GasEstimateUnavailableError);
  });

  it('the thrown error carries the sentinel the UI maps to "node busy, retry"', () => {
    expect(new GasEstimateUnavailableError().message).toContain(RPC_BUSY_SENTINEL);
  });

  it('an injected wallet (MiniPay) is untouched — {feeCurrency} only, no estimate needed', async () => {
    const { client, calls } = clientWithFlakyEstimate(99);
    const extras = await planFeeExtras(client, CUSD, BALANCED, req, false);
    expect(extras).toEqual({ feeCurrency: CUSD });
    expect(calls()).toBe(0);
  });
});
