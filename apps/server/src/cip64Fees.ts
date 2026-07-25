/**
 * CIP-64 fee overrides for SERVER-SIDE wallets (the Race faucet and the house
 * bot) — the RPC plumbing around @ludo/shared's pure cap arithmetic.
 *
 * WHY THIS EXISTS. The cap derivation kept being fixed in one caller at a time:
 * the house bot (#110), then the web client (#111), then unified into
 * @ludo/shared (#118) — and the RACE FAUCET was still sending its transfers with
 * a bare `{ feeCurrency }`, letting viem estimate. That is exactly the estimate
 * the node rejects with "the fee cap (maxFeePerGas gwei) cannot be lower than
 * the block base fee", which surfaced to players as "Gas seed failed — try again
 * in a moment": the burner never received its gas, so its approve/join could
 * never mine and every Race stake lock hung. Three wallets, one rule, one module.
 *
 * A CIP-64 tx pays gas in an ERC-20, so `maxFeePerGas` is denominated in that
 * token and validated against the base fee CONVERTED into it. The direction of
 * the FeeCurrencyDirectory rate is ambiguous, so `calibratedBaseFloor` picks the
 * one the node's own `eth_gasPrice([token])` quote agrees with and never caps
 * below it. See @ludo/shared/cip64 for the measured mainnet numbers.
 */
import { calibratedBaseFloor, feeCurrencyDirections, nativeGatedCapFloor } from '@ludo/shared';
import type { Address, PublicClient } from 'viem';

/** Celo registry — fixed on every Celo network; resolves the FeeCurrencyDirectory. */
const CELO_REGISTRY = '0x000000000000000000000000000000000000ce10' as Address;
const REGISTRY_ABI = [
  { type: 'function', name: 'getAddressForString', stateMutability: 'view', inputs: [{ name: 'i', type: 'string' }], outputs: [{ type: 'address' }] },
] as const;
const DIRECTORY_ABI = [
  { type: 'function', name: 'getExchangeRate', stateMutability: 'view', inputs: [{ name: 't', type: 'address' }], outputs: [{ name: 'n', type: 'uint256' }, { name: 'd', type: 'uint256' }] },
] as const;

/** The tx fields to spread onto a write. `{}` = pay in the native coin;
 *  `{ feeCurrency }` alone = the fail-open path (let viem/the node estimate). */
export type Cip64Override =
  | Record<string, never>
  | { feeCurrency: Address }
  | { feeCurrency: Address; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

/** True when the override carries an explicit cap (i.e. calibration succeeded). */
export function hasExplicitCap(o: Cip64Override): o is { feeCurrency: Address; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  return 'maxFeePerGas' in o;
}

/**
 * Build a per-wallet fee resolver. Re-derives before EVERY tx (Celo has 1s
 * blocks and the base fee moves) but caches the directory address, which never
 * changes. `capMultiplier` buys spike headroom between estimate and mine: the
 * tx only ever PAYS base+tip, but the node RESERVES gasLimit × cap, so a
 * generous multiplier costs a thin wallet reservation headroom, not fees.
 *
 * Fails OPEN (returns `{ feeCurrency }`) on any read failure: a directory or RPC
 * hiccup must degrade to the previous behaviour, never hard-block money movement.
 */
export function createCip64FeeResolver(
  publicClient: PublicClient,
  feeCurrency: Address | undefined,
  capMultiplier: bigint,
  label: string,
): (multOverride?: bigint) => Promise<Cip64Override> {
  let directory: Address | undefined;
  // `multOverride` lets a caller ESCALATE for one attempt (the house bot's retry
  // ladder) without building a second resolver: a cap-too-low reject means the
  // base fee outran the floor we read, and the answer is a fatter cap on the
  // very next try — re-derived from a FRESH floor, since the spike may also have
  // passed. Omitted → the wallet's configured multiplier.
  return async (multOverride?: bigint): Promise<Cip64Override> => {
    const mult = multOverride && multOverride > 0n ? multOverride : capMultiplier;
    if (!feeCurrency) return {};
    try {
      if (!directory) {
        directory = (await publicClient.readContract({
          address: CELO_REGISTRY, abi: REGISTRY_ABI, functionName: 'getAddressForString', args: ['FeeCurrencyDirectory'],
        })) as Address;
      }
      const [block, rate, tipHex, gasPriceHex] = await Promise.all([
        publicClient.getBlock(),
        publicClient.readContract({ address: directory, abi: DIRECTORY_ABI, functionName: 'getExchangeRate', args: [feeCurrency] }) as Promise<readonly [bigint, bigint]>,
        (publicClient.request as (a: never) => Promise<string>)({ method: 'eth_maxPriorityFeePerGas', params: [feeCurrency] } as never).catch(() => '0x0'),
        // The node's OWN token-denominated quote — the authority on which
        // direction of the directory rate is real (see @ludo/shared/cip64).
        (publicClient.request as (a: never) => Promise<string>)({ method: 'eth_gasPrice', params: [feeCurrency] } as never).catch(() => null),
      ]);
      const base = block.baseFeePerGas;
      if (base == null || base <= 0n) throw new Error('no baseFeePerGas on the head block');
      const [num, den] = rate;
      if (num <= 0n || den <= 0n) throw new Error('degenerate directory rate');
      const [dirA, dirB] = feeCurrencyDirections(base, num, den);
      const nodePrice = gasPriceHex === null ? null : BigInt(gasPriceHex);
      // NATIVE GATE: the pre-broadcast fee-cap check compares the cap NUMBER to
      // the NATIVE base fee number (measured: the bot's 6×13.76 = 82.5 gwei cUSD
      // cap was rejected as "lower than the block base fee" under a 200 gwei
      // native base, and the same lock passed only at 275 gwei). Without this
      // the bot burned its first ladder rung on EVERY lock — ~60s of the match's
      // 120s stake window — and the faucet's seeds faced the same reject. Caps
      // only: the fee actually paid stays base+tip in the token (~14 gwei cUSD).
      const baseInToken = nativeGatedCapFloor(calibratedBaseFloor(dirA, dirB, nodePrice), base);
      const tip = BigInt(tipHex);
      return { feeCurrency, maxFeePerGas: mult * baseInToken + tip, maxPriorityFeePerGas: tip };
    } catch (e) {
      console.warn(`[${label}] CIP-64 fee derivation failed — falling back to node estimation:`, e instanceof Error ? e.message : e);
      return { feeCurrency };
    }
  };
}
