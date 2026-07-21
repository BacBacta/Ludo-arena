/**
 * B1 fee-abstraction DRY RUN — proves the "zero-CELO" thesis on a real Celo node.
 *
 * The whole non-MiniPay onboarding (B1) rests on one Celo-specific fact: a wallet
 * holding ZERO native CELO can still transact, paying gas in a REGISTERED fee
 * currency (cUSD / USDm / USDC / USDT) via a CIP-64 transaction (the `feeCurrency`
 * field). Everything else in B1 is unit- + locally-e2e-tested; THIS is the one bit
 * that can only be exercised against a real Celo node. Run it before mainnet.
 *
 * What it does: from a burner that holds the fee token but (ideally) 0 CELO, it
 * sends a real tx with `feeCurrency` set and asserts (a) the tx mines, (b) native
 * CELO is UNCHANGED, (c) the fee token dropped by the gas. If the burner has 0
 * CELO and the tx still succeeds, that alone is proof — a normal tx would revert
 * "insufficient funds for gas".
 *
 * IMPORTANT (why the chain is spread from viem's `celo`): viem only serialises a
 * CIP-64 gas-in-token tx when the chain object carries Celo's custom serializers.
 * A plain defineChain() does NOT — so we take viem's `celo` chain and override id +
 * RPC. (On mainnet the client already uses viem's `celo`, so the burner path works
 * there; only the app's celo-sepolia chains.ts entry is a plain defineChain, which
 * is fine because the burner launch targets mainnet.)
 *
 * SETUP (Celo Sepolia):
 *   1. Create a burner:  `openssl rand -hex 32`  → BURNER_KEY=0x<that>
 *      (or run with no BURNER_KEY once — it prints a fresh address to fund.)
 *   2. Fund it with the fee token ONLY (no CELO — that's the point). Get testnet
 *      USDm/CELO from https://faucet.celo.org/celo-sepolia; to hold a fee token
 *      with zero CELO you can send yourself CELO first, swap/receive USDm, then
 *      sweep the CELO out — or just fund USDm from another wallet.
 *   3. Run:
 *        BURNER_KEY=0x… npx tsx packages/contracts/script/feeCurrencyDryRun.ts
 *
 * Env:
 *   RPC           default https://forno.celo-sepolia.celo-testnet.org
 *   CHAIN_ID      default 11142220 (Celo Sepolia)
 *   FEE_CURRENCY  default 0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b (USDm, sepolia)
 *   BURNER_KEY    the 0x private key of the funded burner (required to send)
 */
import { celo } from 'viem/chains';
import { createPublicClient, createWalletClient, http, formatUnits, getAddress, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const RPC = process.env.RPC?.trim() || 'https://forno.celo-sepolia.celo-testnet.org';
const CHAIN_ID = Number(process.env.CHAIN_ID ?? '11142220');
const FEE_CURRENCY = getAddress((process.env.FEE_CURRENCY?.trim() || '0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b') as Address);

// Spread viem's `celo` (keeps its CIP-64 serializers + formatters) but point it at
// the target testnet — a plain defineChain would drop feeCurrency on the floor.
const chain = { ...celo, id: CHAIN_ID, name: `Celo (${CHAIN_ID})`, rpcUrls: { default: { http: [RPC] } } };

const ERC20 = parseAbi([
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

const pc = createPublicClient({ chain, transport: http(RPC) });

async function main(): Promise<void> {
  const rawKey = process.env.BURNER_KEY?.trim();
  if (!rawKey) {
    const fresh = generatePrivateKey();
    const addr = privateKeyToAccount(fresh).address;
    console.log('No BURNER_KEY set — generated a fresh burner. Fund it with the fee');
    console.log('token (NO CELO), then re-run with BURNER_KEY set.\n');
    console.log('  BURNER_KEY=%s', fresh);
    console.log('  address    %s', addr);
    console.log('  fee token  %s (fund this)', FEE_CURRENCY);
    return;
  }
  const account = privateKeyToAccount((rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex);
  const wc = createWalletClient({ account, chain, transport: http(RPC) });

  const [sym, dec] = await Promise.all([
    pc.readContract({ address: FEE_CURRENCY, abi: ERC20, functionName: 'symbol' }) as Promise<string>,
    pc.readContract({ address: FEE_CURRENCY, abi: ERC20, functionName: 'decimals' }) as Promise<number>,
  ]);
  const celoBefore = await pc.getBalance({ address: account.address });
  const tokBefore = (await pc.readContract({ address: FEE_CURRENCY, abi: ERC20, functionName: 'balanceOf', args: [account.address] })) as bigint;

  console.log(`\nchain ${CHAIN_ID} · rpc ${RPC}`);
  console.log(`burner ${account.address}`);
  console.log(`  CELO (native gas): ${formatUnits(celoBefore, 18)}`);
  console.log(`  ${sym} (fee token): ${formatUnits(tokBefore, dec)}`);
  if (tokBefore === 0n) {
    console.log(`\n❌ burner holds 0 ${sym} — it cannot pay gas in the token. Fund it first.`);
    process.exit(1);
  }
  if (celoBefore === 0n) console.log(`\n✔ burner has ZERO CELO — a successful tx below PROVES gas was paid in ${sym}.`);
  else console.log(`\n⚠ burner has some CELO; the strict proof is that its CELO stays UNCHANGED after the tx.`);

  // Gas: set ONLY feeCurrency and let viem estimate the 1559 caps. Celo validates
  // maxFeePerGas against the NATIVE base fee (CELO), which can be far above the
  // cUSD gas price, so an explicit cap derived from eth_gasPrice(token) is rejected
  // once the native base fee spikes ("max fee per gas less than block base fee").
  // (The client does the same — see feeCurrencyExtra in escrow.ts.)
  const gp = BigInt((await pc.request({ method: 'eth_gasPrice', params: [FEE_CURRENCY] } as never)) as string);
  console.log(`  ${sym} gas price (token-denominated, informational): ${gp}`);

  // The test tx: a 1-unit self-transfer of the fee token, WITH feeCurrency set so
  // gas is charged in the token (CIP-64). Minimal + state-changing → real gas.
  console.log(`\nsending self-transfer of 1 base unit of ${sym}, gas paid in ${sym} (feeCurrency)…`);
  const hash = await wc.writeContract({
    address: FEE_CURRENCY,
    abi: ERC20,
    functionName: 'transfer',
    args: [account.address, 1n],
    feeCurrency: FEE_CURRENCY,
  } as Parameters<typeof wc.writeContract>[0]);
  const receipt = await pc.waitForTransactionReceipt({ hash });
  console.log(`  tx ${hash} → ${receipt.status}`);

  const celoAfter = await pc.getBalance({ address: account.address });
  // Forno is a load-balanced RPC: a balance read right after the tx often hits a
  // node that hasn't applied the block yet and returns the STALE pre-tx balance
  // (making it look like 0 gas was charged). Re-read until the token balance moves
  // off tokBefore (the gas debit) or a few tries elapse — the delta is the gas.
  let tokAfter = tokBefore;
  for (let i = 0; i < 8 && tokAfter === tokBefore; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1500));
    tokAfter = (await pc.readContract({ address: FEE_CURRENCY, abi: ERC20, functionName: 'balanceOf', args: [account.address] })) as bigint;
  }
  const gasInToken = tokBefore - tokAfter; // self-transfer nets 0, so the whole delta is gas

  let ok = true;
  const assert = (c: boolean, m: string) => { if (!c) ok = false; console.log(`${c ? '✅' : '❌'} ${m}`); };
  console.log('');
  assert(receipt.status === 'success', 'tx mined successfully');
  assert(celoAfter === celoBefore, `native CELO UNCHANGED (${formatUnits(celoBefore, 18)} → ${formatUnits(celoAfter, 18)}) — gas did NOT come from CELO`);
  assert(gasInToken > 0n, `gas was charged in ${sym}: ${formatUnits(gasInToken, dec)} ${sym}`);

  console.log(`\n${ok ? '✅ FEE ABSTRACTION CONFIRMED' : '❌ DRY RUN FAILED'} — B1 zero-CELO onboarding is${ok ? '' : ' NOT'} viable on chain ${CHAIN_ID}.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('\n❌ dry run errored:', e instanceof Error ? e.message : e);
  console.error('If this is "unknown fee currency" / a serialisation error, the token is likely NOT a registered fee currency on this chain (run getCurrencies on the FeeCurrencyDirectory) — pick cUSD/USDm/USDC/USDT.');
  process.exit(1);
});
