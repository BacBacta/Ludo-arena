/**
 * Makes the deployed CosmeticsStore match deployments.json — its accepted TOKEN
 * first, then the ENTIRE shared cosmetics catalogue (every priced
 * PREMIUM_COSMETICS item + the season-premium pass). Reads current on-chain
 * state first and writes only what differs (idempotent — re-running is a no-op).
 *
 * The source of truth is imported STRAIGHT from packages/shared/src/protocol.ts
 * (type-only deps, safe under tsx), so listings can never drift from what the
 * client displays.
 *
 * WHY THE TOKEN STEP LIVES HERE — the ordering is a money-safety property, not a
 * convenience. Prices are stored in the token's BASE UNITS, so the two writes are
 * only safe in one order:
 *
 *   setToken THEN setPrices  → between the two, a $1 item still carries its old
 *                              18-dec price (1e18). Read as 6-dec USD₮ that is
 *                              1e12 tokens: every buy reverts on balance. Broken,
 *                              but fail-SAFE.
 *   setPrices THEN setToken  → between the two, a $1 item carries its new 6-dec
 *                              price (1e6) while the store still pulls 18-dec
 *                              cUSD: 1e6 base units is 0.000000000001 cUSD. The
 *                              whole catalogue is FREE for anyone watching.
 *
 * Splitting these across two scripts invites the second order. Running them here,
 * token first, makes it unreachable — and the guard before setPrices re-reads the
 * token on-chain so a partial run can never reprice against a stale token.
 *
 * Decimals come from the token itself (`decimals()`), not from deployments.json:
 * a typo in that file would otherwise misprice the entire catalogue by orders of
 * magnitude. The config value is cross-checked and a mismatch aborts.
 *
 * Usage:
 *   NETWORK=celo DEPLOYER_PRIVATE_KEY=0x<owner> npm run list-cosmetics -w packages/contracts
 *   DRY_RUN=true …  prints the full plan (repoint + price diff) and writes nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  toBytes,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PREMIUM_COSMETICS, SEASON_PREMIUM } from '../../shared/src/protocol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* rely on ambient env */
}
function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : undefined;
}

const CHAINS: Record<string, { chain: Chain; defaultRpc: string; rpcEnv: string }> = {
  'celo-sepolia': {
    chain: defineChain({
      id: 11_142_220,
      name: 'Celo Sepolia',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } },
      blockExplorers: { default: { name: 'Blockscout', url: 'https://celo-sepolia.blockscout.com' } },
    }),
    defaultRpc: 'https://forno.celo-sepolia.celo-testnet.org',
    rpcEnv: 'CELO_SEPOLIA_RPC',
  },
  celo: {
    chain: defineChain({
      id: 42_220,
      name: 'Celo',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: { default: { http: ['https://forno.celo.org'] } },
      blockExplorers: { default: { name: 'Celoscan', url: 'https://celoscan.io' } },
    }),
    defaultRpc: 'https://forno.celo.org',
    rpcEnv: 'CELO_RPC',
  },
};

const networkName = env('NETWORK') ?? 'celo-sepolia';
const preset = CHAINS[networkName];
if (!preset) {
  console.error(`list-cosmetics only supports: ${Object.keys(CHAINS).join(', ')}`);
  process.exit(1);
}
const dryRun = env('DRY_RUN') === 'true';

const rawPk = env('DEPLOYER_PRIVATE_KEY');
if (!rawPk) {
  console.error('DEPLOYER_PRIVATE_KEY is required (must be the CosmeticsStore owner / deployer).');
  process.exit(1);
}
const pk = (rawPk.startsWith('0x') ? rawPk : `0x${rawPk}`) as Hex;
const account = privateKeyToAccount(pk);
const rpc = env(preset.rpcEnv) ?? preset.defaultRpc;
const publicClient = createPublicClient({ chain: preset.chain, transport: http(rpc) });
const walletClient = createWalletClient({ account, chain: preset.chain, transport: http(rpc) });

const deploymentsPath = join(ROOT, 'deployments.json');
const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8')) as Record<string, Record<string, unknown>>;
const dep = deployments[networkName];
if (!dep?.cosmeticsStore) {
  console.error(`No cosmeticsStore in deployments.json['${networkName}'] — deploy it first.`);
  process.exit(1);
}
if (Number(dep.chainId) !== preset.chain.id) {
  console.error(`chainId mismatch (deployments ${String(dep.chainId)} != ${preset.chain.id}).`);
  process.exit(1);
}
const store = dep.cosmeticsStore as Address;
const wantToken = getAddress(dep.stablecoin as string);

const STORE_ABI = [
  { type: 'function', name: 'setPrices', stateMutability: 'nonpayable', inputs: [{ name: 'itemIds', type: 'bytes32[]' }, { name: 'prices', type: 'uint256[]' }], outputs: [] },
  { type: 'function', name: 'setToken', stateMutability: 'nonpayable', inputs: [{ name: '_token', type: 'address' }], outputs: [] },
  { type: 'function', name: 'priceOf', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'token', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;
const ERC20_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

/** Load-balanced public RPCs may serve a read from a node that hasn't seen the
 *  write block yet — retry before believing a verification failure. */
async function readWithRetry<T>(fn: () => Promise<T>, accept: (v: T) => boolean): Promise<T> {
  let last: T = await fn();
  for (let attempt = 0; attempt < 6 && !accept(last); attempt++) {
    await new Promise((r) => setTimeout(r, 2_500));
    last = await fn();
  }
  return last;
}

console.log(`[list] network=${networkName} signer=${account.address} store=${store}${dryRun ? ' (DRY RUN)' : ''}`);

const owner = (await publicClient.readContract({ address: store, abi: STORE_ABI, functionName: 'owner' })) as Address;
if (owner.toLowerCase() !== account.address.toLowerCase()) {
  console.error(`[list] signer is NOT the store owner (owner=${owner}) — the writes would revert.`);
  process.exit(1);
}

// ---- 1. token: repoint the store at the configured stake token, FIRST. --------
const haveToken = getAddress(
  (await publicClient.readContract({ address: store, abi: STORE_ABI, functionName: 'token' })) as Address,
);

// Decimals from the TOKEN, not the config — the config is only cross-checked.
const decimals = Number(
  await publicClient.readContract({ address: wantToken, abi: ERC20_ABI, functionName: 'decimals' }),
);
if (decimals < 2) {
  console.error(`[list] token ${wantToken} reports ${decimals} decimals — unsupported (prices are in cents).`);
  process.exit(1);
}
const configDecimals = dep.stablecoinDecimals === undefined ? 18 : Number(dep.stablecoinDecimals);
if (configDecimals !== decimals) {
  console.error(
    `[list] deployments.json says stablecoinDecimals=${configDecimals} but ${wantToken} reports ${decimals}. ` +
      `Repricing on the wrong figure would be off by 10^${Math.abs(configDecimals - decimals)} — fix the config first.`,
  );
  process.exit(1);
}
const priceUnit = 10n ** BigInt(decimals - 2); // cents → base units

if (haveToken !== wantToken) {
  console.log(`[list] token repoint: ${haveToken} → ${wantToken} (${decimals} decimals)`);
  if (!dryRun) {
    const tx = await walletClient.writeContract({ account, chain: preset.chain, address: store, abi: STORE_ABI, functionName: 'setToken', args: [wantToken] });
    const rcpt = await publicClient.waitForTransactionReceipt({ hash: tx });
    if (rcpt.status !== 'success') throw new Error(`setToken reverted (tx ${tx})`);
    const now = await readWithRetry(
      () => publicClient.readContract({ address: store, abi: STORE_ABI, functionName: 'token' }) as Promise<Address>,
      (v) => getAddress(v) === wantToken,
    );
    if (getAddress(now) !== wantToken) throw new Error(`setToken verify failed: token=${now}`);
    console.log(`[list] token repointed (tx ${tx}) — every price below is now read in ${decimals}-dec units.`);
  }
} else {
  console.log(`[list] ✓ token already ${wantToken} (${decimals} decimals)`);
}

// ---- 2. prices: diff the whole catalogue, write only what differs. ------------
const WANT: Array<{ id: string; cents: number }> = [
  ...PREMIUM_COSMETICS.filter((c) => c.cents > 0).map((c) => ({ id: c.id, cents: c.cents })),
  { id: SEASON_PREMIUM.itemId, cents: SEASON_PREMIUM.cents },
];
console.log(`[list] catalogue: ${WANT.length} priced item(s)`);

const pending: Array<{ id: string; itemId: Hex; price: bigint; had: bigint }> = [];
for (const w of WANT) {
  const itemId = keccak256(toBytes(w.id));
  const want = BigInt(w.cents) * priceUnit;
  const had = (await publicClient.readContract({ address: store, abi: STORE_ABI, functionName: 'priceOf', args: [itemId] })) as bigint;
  if (had === want) {
    console.log(`[list] ✓ ${w.id} already listed at ${had} ($${(w.cents / 100).toFixed(2)})`);
  } else {
    pending.push({ id: w.id, itemId, price: want, had });
    console.log(`[list] → ${w.id}: ${had} → ${want} ($${(w.cents / 100).toFixed(2)})`);
  }
}

if (dryRun) {
  console.log(`[list] DRY RUN — ${pending.length} price write(s) withheld, nothing sent.`);
  process.exit(0);
}
if (pending.length === 0) {
  console.log('[list] catalogue already in sync — nothing to write.');
  process.exit(0);
}

// The guard that makes the unsafe order unreachable: never price the catalogue in
// units of a token the store does not actually pull. A partial earlier run, or a
// repoint that silently failed, would otherwise list every item for dust.
const tokenNow = getAddress(
  (await publicClient.readContract({ address: store, abi: STORE_ABI, functionName: 'token' })) as Address,
);
if (tokenNow !== wantToken) {
  console.error(`[list] ABORT: store token is ${tokenNow}, expected ${wantToken}. Repricing now would list the catalogue in the wrong units.`);
  process.exit(1);
}

const tx = await walletClient.writeContract({
  account,
  chain: preset.chain,
  address: store,
  abi: STORE_ABI,
  functionName: 'setPrices',
  args: [pending.map((p) => p.itemId), pending.map((p) => p.price)],
});
await publicClient.waitForTransactionReceipt({ hash: tx });
console.log(`[list] setPrices(${pending.length} items) tx ${tx}`);

for (const p of pending) {
  const onChain = await readWithRetry(
    () => publicClient.readContract({ address: store, abi: STORE_ABI, functionName: 'priceOf', args: [p.itemId] }) as Promise<bigint>,
    (v) => v === p.price,
  );
  if (onChain !== p.price) throw new Error(`verify failed for ${p.id}: priceOf=${onChain}, expected ${p.price}`);
}
console.log(`[list] verified: ${pending.length} item(s) listed against ${wantToken}. The shop rail covers the full catalogue.`);
