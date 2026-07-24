/**
 * READ-ONLY lock reproduction — run INSIDE the Fly machine (fly-ops
 * `probe-lock`) to deterministically reproduce the house bot's stake-lock fee
 * path with the PRODUCTION env, WITHOUT sending any transaction. Answers, in
 * one shot, why lockStake still fails:
 *   1. wallet nonce + cUSD balance — has the bot EVER mined a tx? (nonce 0 &&
 *      balance untouched ⇒ every attempt was rejected pre-mine, i.e. fee-cap).
 *   2. cip64Fees() reproduced exactly — does it SUCCEED or throw into the
 *      broken node-estimation fallback? Prints the computed cap.
 *   3. prepareTransactionRequest for the REAL approve tx, with the override —
 *      prints the maxFeePerGas viem ACTUALLY attaches, revealing whether the
 *      celo estimateFeesPerGas hook silently overrides our explicit cap.
 * The private key is read from env, used only to derive the address; it is
 * NEVER printed. No signing, no broadcast.
 */
const viem = require(require.resolve('viem', { paths: ['/app/apps/server', '/app', process.cwd()] }));
const { privateKeyToAccount } = require(require.resolve('viem/accounts', { paths: ['/app/apps/server', '/app', process.cwd()] }));
const { celo } = require(require.resolve('viem/chains', { paths: ['/app/apps/server', '/app', process.cwd()] }));

const CELO_REGISTRY = '0x000000000000000000000000000000000000ce10';
const REGISTRY_ABI = [{ type: 'function', name: 'getAddressForString', stateMutability: 'view', inputs: [{ name: 'i', type: 'string' }], outputs: [{ type: 'address' }] }];
const DIRECTORY_ABI = [{ type: 'function', name: 'getExchangeRate', stateMutability: 'view', inputs: [{ name: 't', type: 'address' }], outputs: [{ name: 'n', type: 'uint256' }, { name: 'd', type: 'uint256' }] }];
const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

(async () => {
  const rpc = (process.env.SETTLEMENT_RPC || '').trim() || 'https://forno.celo.org';
  const cusd = (process.env.FEE_CURRENCY || '').trim() || '0x765DE816845861e75A25fCA122bb6898B8B1282a';
  const escrow = (process.env.ESCROW_ADDRESS || '').trim() || '0xabdfea03be58d3276b13b40885311d84259d7f4d';
  const feeInStable = (process.env.FEE_IN_STABLE || '').trim() === 'true' || (process.env.RACE_FEE_IN_STABLE || '').trim() === 'true';
  const raw = (process.env.RACE_HOUSE_BOT_PRIVATE_KEY || '').trim();
  if (!raw) { console.log('[probe-lock] RACE_HOUSE_BOT_PRIVATE_KEY unset — cannot derive bot address'); return; }
  const account = privateKeyToAccount(raw.startsWith('0x') ? raw : `0x${raw}`);

  const pub = viem.createPublicClient({ chain: celo, transport: viem.http(rpc) });
  const wallet = viem.createWalletClient({ account, chain: celo, transport: viem.http(rpc) });

  console.log(`[probe-lock] bot address   : ${account.address}`);
  console.log(`[probe-lock] rpc host      : ${(() => { try { return new URL(rpc).host; } catch { return '?'; } })()}  feeInStable=${feeInStable}`);

  const [nonce, bal] = await Promise.all([
    pub.getTransactionCount({ address: account.address }),
    pub.readContract({ address: cusd, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
  ]);
  console.log(`[probe-lock] wallet nonce  : ${nonce}  ${nonce === 0 ? '<-- ZERO: the bot has NEVER mined a tx (all attempts rejected pre-mine)' : '(has mined tx)'}`);
  console.log(`[probe-lock] cUSD balance  : ${bal}  (${(Number(bal) / 1e18).toFixed(6)} cUSD)`);

  // --- reproduce cip64Fees() exactly
  let override = { feeCurrency: cusd };
  try {
    const dir = await pub.readContract({ address: CELO_REGISTRY, abi: REGISTRY_ABI, functionName: 'getAddressForString', args: ['FeeCurrencyDirectory'] });
    const [block, rate, tipHex] = await Promise.all([
      pub.getBlock(),
      pub.readContract({ address: dir, abi: DIRECTORY_ABI, functionName: 'getExchangeRate', args: [cusd] }),
      pub.request({ method: 'eth_maxPriorityFeePerGas', params: [cusd] }).catch(() => '0x0'),
    ]);
    const base = block.baseFeePerGas;
    const [num, den] = rate;
    const a = (base * num) / den, b = (base * den) / num;
    const baseInToken = a > b ? a : b;
    const tip = BigInt(tipHex);
    override = { feeCurrency: cusd, maxFeePerGas: 3n * baseInToken + tip, maxPriorityFeePerGas: tip };
    console.log(`[probe-lock] cip64Fees     : OK  base=${base}  baseInToken(max)=${baseInToken}  cap=${override.maxFeePerGas}  tip=${tip}`);
  } catch (e) {
    console.log(`[probe-lock] cip64Fees     : THREW -> fail-open to node estimation. reason: ${e && e.message ? e.message.slice(0, 180) : e}`);
  }

  // --- what does viem ACTUALLY attach? prepareTransactionRequest fills fees.
  const units = 10n ** 18n / 100n; // 1c cUSD
  for (const [label, extra] of [['WITH override', override], ['feeCurrency ONLY (old path)', { feeCurrency: cusd }]]) {
    try {
      const data = viem.encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [escrow, units] });
      const req = await wallet.prepareTransactionRequest({ account, to: cusd, data, ...extra });
      console.log(`[probe-lock] prepare ${label}: type=${req.type} maxFeePerGas=${req.maxFeePerGas} maxPriorityFeePerGas=${req.maxPriorityFeePerGas} feeCurrency=${req.feeCurrency || '(none)'}`);
    } catch (e) {
      console.log(`[probe-lock] prepare ${label}: ERROR ${e && e.shortMessage ? e.shortMessage : (e && e.message ? e.message.slice(0, 200) : e)}`);
    }
  }

  // --- ON-CHAIN TRUTH: the bot's recent txs (method + success/revert + reason).
  // Distinguishes "bot locks then match aborts" (joins succeed) from "bot join
  // reverts every time" (e.g. CommitMismatch / BadStake). Explorer, no key.
  const hosts = ['https://celo.blockscout.com', 'https://explorer.celo.org/mainnet'];
  for (const host of hosts) {
    try {
      const r = await fetch(`${host}/api/v2/addresses/${account.address}/transactions?filter=from`, { headers: { accept: 'application/json' } });
      if (!r.ok) { console.log(`[probe-lock] explorer ${host}: HTTP ${r.status}`); continue; }
      const j = await r.json();
      const items = (j.items || []).slice(0, 10);
      console.log(`[probe-lock] recent bot txs (${host}): ${items.length}`);
      for (const it of items) {
        const method = it.method || (it.decoded_input && it.decoded_input.method_call) || it.raw_input?.slice(0, 10) || '?';
        const status = it.status || it.result || '?';
        const revert = it.revert_reason ? (typeof it.revert_reason === 'string' ? it.revert_reason : JSON.stringify(it.revert_reason)) : '';
        const to = (it.to && (it.to.hash || it.to)) || '?';
        console.log(`[probe-lock]   ${it.timestamp || ''} method=${method} to=${to} status=${status} ${revert ? 'REVERT=' + revert : ''}`);
      }
      break;
    } catch (e) {
      console.log(`[probe-lock] explorer ${host}: ${e && e.message ? e.message.slice(0, 120) : e}`);
    }
  }
})().catch((e) => { console.error('[probe-lock] FAILED:', e && e.message ? e.message : e); process.exit(1); });
