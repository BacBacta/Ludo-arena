/**
 * READ-ONLY — enumerate Celo mainnet's registered fee currencies from the
 * FeeCurrencyDirectory and, for each, resolve the UNDERLYING token + decimals.
 * Purpose: find the exact USD₮ fee-currency ADAPTER address (the value to pass
 * as `feeCurrency` for gas), which is DIFFERENT from the raw 6-decimal USDT
 * token used for staking. Run in-machine (mainnet RPC) via fly-ops. No tx.
 */
const viem = require(require.resolve('viem', { paths: ['/app/apps/server', '/app', process.cwd()] }));

const DIRECTORY = '0x15F344b9E6c3Cb6F0376A36A64928b13F62C6276';
const USDT = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e'.toLowerCase();
const DIR_ABI = [
  { type: 'function', name: 'getCurrencies', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getExchangeRate', stateMutability: 'view', inputs: [{ name: 't', type: 'address' }], outputs: [{ name: 'n', type: 'uint256' }, { name: 'd', type: 'uint256' }] },
];
// FeeCurrencyAdapter surface varies by version — try several underlying getters.
const ADAPTER_ABI = [
  { type: 'function', name: 'adaptedToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getAdaptedToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'wrappedToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];
const ERC20 = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];

(async () => {
  const rpc = (process.env.SETTLEMENT_RPC || '').trim() || 'https://forno.celo.org';
  const pc = viem.createPublicClient({ transport: viem.http(rpc) });
  const read = (address, abi, functionName, args = []) => pc.readContract({ address, abi, functionName, args });

  const currencies = await read(DIRECTORY, DIR_ABI, 'getCurrencies');
  console.log(`[fee-curr] FeeCurrencyDirectory ${DIRECTORY} — ${currencies.length} registered:`);
  for (const addr of currencies) {
    let sym = '?', dec = '?', underlying = null, uSym = '?', uDec = '?';
    try { sym = await read(addr, ERC20, 'symbol'); } catch {}
    try { dec = String(await read(addr, ERC20, 'decimals')); } catch {}
    for (const fn of ['adaptedToken', 'getAdaptedToken', 'wrappedToken']) {
      try { underlying = await read(addr, ADAPTER_ABI, fn); if (underlying) break; } catch {}
    }
    if (underlying) {
      try { uSym = await read(underlying, ERC20, 'symbol'); } catch {}
      try { uDec = String(await read(underlying, ERC20, 'decimals')); } catch {}
    }
    let rate = '';
    try { const r = await read(DIRECTORY, DIR_ABI, 'getExchangeRate', [addr]); rate = `rate=${r[0]}/${r[1]}`; } catch {}
    const isUsdt = (underlying && underlying.toLowerCase() === USDT) || addr.toLowerCase() === USDT;
    console.log(`  ${isUsdt ? '>>> USDT ' : ''}${addr}  sym=${sym} dec=${dec}  underlying=${underlying || 'self'}${underlying ? ` (${uSym}, ${uDec}dec)` : ''}  ${rate}`);
  }
  console.log('\n[fee-curr] raw USDT token (for staking/approve/balances): ' + USDT + '  (6 decimals)');
  console.log('[fee-curr] the ADAPTER whose underlying == USDT is the value for feeCurrency (gas).');
})().catch((e) => { console.error('[fee-curr] FAILED:', e && e.message ? e.message : e); process.exit(1); });
