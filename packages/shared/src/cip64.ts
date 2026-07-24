/**
 * CIP-64 (Celo fee-abstraction) gas-cap arithmetic — the SINGLE source of truth
 * for the web client AND the server's house bot.
 *
 * WHY THIS LIVES HERE. The derivation existed twice — apps/web/src/lib/escrow.ts
 * and apps/server/src/houseBot.ts — and the copies drifted, which is what caused
 * a production outage: a fix applied to the bot's copy (deriving the cap from the
 * FeeCurrencyDirectory, taking the MAX of both conversion directions) landed in
 * the client's copy too and silently broke every new player's Race Pass mint.
 * One implementation, one test suite, both callers.
 *
 * THE ARITHMETIC. A CIP-64 tx pays gas in an ERC-20, so its `maxFeePerGas` is
 * denominated in that token and the node validates it against the base fee
 * CONVERTED into the same token. The FeeCurrencyDirectory exposes the rate as
 * (numerator, denominator) and NOTHING in the pair says which way round it is —
 * hence the historical MAX-of-both-directions, which is safe for a rich wallet
 * (EIP-1559 refunds: the tx pays base+tip, never the cap) but catastrophic for a
 * thin one, because the node RESERVES gasLimit × maxFeePerGas up front.
 *
 * MEASURED ON CELO MAINNET (2026-07-24, native base fee 200 gwei, cUSD):
 *   rate num/den = 0.068247 ⇒ direction A = 13.65 gwei · direction B = 2930 gwei
 *   node eth_gasPrice([cUSD]) = 13.82 gwei
 *   mined CIP-64 txs (type 123) all charged gasPrice ≈ 13.8-14.1 gwei
 * So direction A is the truth and B over-caps ~215×: it turned a Race Pass mint
 * into a ~150c reservation against a 10c gas seed ("insufficient funds") while
 * the fee actually paid stayed under 1c.
 *
 * THE RULE. `eth_gasPrice([token])` is the node's own token-denominated quote —
 * the authority on what it charges — so it disambiguates the orientation: pick
 * the direction nearest that quote, and never cap BELOW the quote (that is the
 * "max fee per gas less than block base fee" reject). With no quote (a node
 * without Celo's RPC extension) keep the conservative MAX: over-reserving only
 * hurts a thin wallet, under-capping fails outright.
 */

/** Both directions the directory rate can convert a native base fee into the fee
 *  currency. Returns [a, b]; which one is real is decided by `calibratedBaseFloor`. */
export function feeCurrencyDirections(baseFeePerGas: bigint, num: bigint, den: bigint): readonly [bigint, bigint] {
  if (baseFeePerGas <= 0n || num <= 0n || den <= 0n) return [baseFeePerGas, baseFeePerGas];
  return [(baseFeePerGas * num) / den, (baseFeePerGas * den) / num];
}

/**
 * The fee-currency-denominated base floor to build a cap from: the conversion
 * direction the NODE agrees with, never below the node's own quote.
 * `nodePrice` = eth_gasPrice([feeCurrency]), or null when unavailable.
 */
export function calibratedBaseFloor(a: bigint, b: bigint, nodePrice: bigint | null): bigint {
  const hi = a > b ? a : b;
  if (nodePrice === null || nodePrice <= 0n) return hi; // no oracle → stay conservative
  const da = a > nodePrice ? a - nodePrice : nodePrice - a;
  const db = b > nodePrice ? b - nodePrice : nodePrice - b;
  const near = da <= db ? a : b;
  return near > nodePrice ? near : nodePrice;
}

/** What the node RESERVES for a tx (fee part), in fee-currency wei. The quantity
 *  that must fit inside a freshly-seeded burner's balance — not the fee paid. */
export function feeReservationWei(gasLimit: bigint, maxFeePerGas: bigint): bigint {
  return gasLimit * maxFeePerGas;
}
