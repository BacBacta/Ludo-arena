/**
 * READ-ONLY fee probe — run INSIDE the Fly machine (fly-ops `probe-fees`) to
 * diagnose the house bot's CIP-64 "fee cap cannot be lower than block base fee"
 * rejection with the PRODUCTION env (SETTLEMENT_RPC, fee switches) and live
 * mainnet numbers. Sends NO transaction. CommonJS on purpose: executed with
 * plain `node` from /tmp against /app's installed viem, no build step.
 *
 * What it reveals:
 *  - whether SETTLEMENT_RPC is set (and to which host) vs the forno default;
 *  - eth_gasPrice WITH the cUSD feeCurrency param vs WITHOUT: a provider that
 *    ignores the Celo-specific param silently returns the NATIVE price, and a
 *    cap computed from it can land under the cUSD-denominated base fee;
 *  - the live numbers to check whether the 3x multiplier actually covers.
 */
const path = require('node:path');
// Resolve viem from the server's installed tree regardless of CWD.
const viem = require(require.resolve('viem', { paths: ['/app/apps/server', '/app', process.cwd()] }));

const CUSD = '0x765DE816845861e75A25fCA122bb6898B8B1282a';

(async () => {
  const rpc = (process.env.SETTLEMENT_RPC || '').trim() || 'https://forno.celo.org';
  const redacted = rpc.replace(/\/\/[^/]*@/, '//***@');
  const host = (() => { try { return new URL(rpc).host; } catch { return '(unparseable)'; } })();
  const client = viem.createPublicClient({ transport: viem.http(rpc) });

  const [gasNative, gasCusd, tipCusd, block] = await Promise.all([
    client.request({ method: 'eth_gasPrice', params: [] }).then(BigInt),
    client.request({ method: 'eth_gasPrice', params: [CUSD] }).then(BigInt).catch((e) => `ERR ${e.message}`),
    client.request({ method: 'eth_maxPriorityFeePerGas', params: [CUSD] }).then(BigInt).catch((e) => `ERR ${e.message}`),
    client.getBlock(),
  ]);

  console.log(`[probe-fees] rpc host        : ${host} (SETTLEMENT_RPC ${process.env.SETTLEMENT_RPC ? 'SET' : 'unset -> forno'})`);
  console.log(`[probe-fees] rpc (redacted)  : ${redacted.slice(0, 60)}`);
  console.log(`[probe-fees] CHAIN=${process.env.CHAIN} RACE_FEE_IN_STABLE=${JSON.stringify(process.env.RACE_FEE_IN_STABLE)} FEE_IN_STABLE=${JSON.stringify(process.env.FEE_IN_STABLE)} BOT_ENABLED=${JSON.stringify(process.env.RACE_HOUSE_BOT_ENABLED)}`);
  console.log(`[probe-fees] block baseFee   : ${block.baseFeePerGas} (native wei/gas, block ${block.number})`);
  console.log(`[probe-fees] gasPrice native : ${gasNative}`);
  console.log(`[probe-fees] gasPrice cUSD   : ${gasCusd}`);
  console.log(`[probe-fees] tip cUSD        : ${tipCusd}`);

  if (typeof gasCusd === 'bigint') {
    const sameAsNative = gasCusd === gasNative;
    console.log(`[probe-fees] cUSD price == native price: ${sameAsNative} ${sameAsNative ? '<-- provider likely IGNORES the feeCurrency param' : '(param honoured)'}`);
    if (typeof tipCusd === 'bigint') {
      // viem celo fees: maxFeePerGas = multiply(gasPrice - tip) + tip
      const capX3 = 3n * (gasCusd - tipCusd) + tipCusd;
      console.log(`[probe-fees] viem cap at x3  : ${capX3}`);
      if (block.baseFeePerGas) {
        console.log(`[probe-fees] cap/nativeBase  : ${Number(capX3) / Number(block.baseFeePerGas)} (must exceed the cUSD-denominated base fee ratio)`);
      }
    }
  }

  // --- FeeCurrencyDirectory: the node's OWN conversion source. Resolve it via
  // the Celo registry (0x...ce10, stable across networks) and print the cUSD
  // exchange rate BOTH ways vs the live base fee, so the fix can hard-code the
  // verified direction. Read-only calls.
  try {
    const REGISTRY = '0x000000000000000000000000000000000000ce10';
    const dir = await client.readContract({
      address: REGISTRY,
      abi: [{ type: 'function', name: 'getAddressForString', stateMutability: 'view', inputs: [{ name: 'identifier', type: 'string' }], outputs: [{ type: 'address' }] }],
      functionName: 'getAddressForString',
      args: ['FeeCurrencyDirectory'],
    });
    console.log(`[probe-fees] FeeCurrencyDirectory: ${dir}`);
    const [numerator, denominator] = await client.readContract({
      address: dir,
      abi: [{ type: 'function', name: 'getExchangeRate', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ name: 'numerator', type: 'uint256' }, { name: 'denominator', type: 'uint256' }] }],
      functionName: 'getExchangeRate',
      args: [CUSD],
    });
    console.log(`[probe-fees] rate numerator  : ${numerator}`);
    console.log(`[probe-fees] rate denominator: ${denominator}`);
    if (block.baseFeePerGas) {
      const b = block.baseFeePerGas;
      const dirA = (b * numerator) / denominator; // token = native * num/den
      const dirB = (b * denominator) / numerator; // token = native * den/num
      console.log(`[probe-fees] baseFee -> cUSD (num/den): ${dirA}`);
      console.log(`[probe-fees] baseFee -> cUSD (den/num): ${dirB}`);
      console.log(`[probe-fees] node cUSD floor quote     : ${gasCusd} (the plausible direction should sit ABOVE this when base > floor)`);
    }
  } catch (e) {
    console.log(`[probe-fees] directory probe failed: ${e && e.message ? e.message.slice(0, 200) : e}`);
  }
})().catch((e) => {
  console.error('[probe-fees] FAILED:', e && e.message ? e.message : e);
  process.exit(1);
});
