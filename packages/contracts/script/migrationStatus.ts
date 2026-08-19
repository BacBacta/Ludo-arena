/**
 * READ-ONLY cutover report: how far along is the stake-token migration on the
 * target network? No key, no writes — every call is an `eth_call`, so this is
 * safe to run from anywhere, including CI, at any moment.
 *
 * It answers the one question the runbook keeps raising: which of the on-chain
 * steps have actually landed? Each line is FAIT (done) or A FAIRE (outstanding),
 * measured against `deployments.json` + the shared catalogue rather than against
 * a human's memory of what was run.
 *
 *   1. allowlist   — `allowedToken(stakeToken)` on LudoEscrow and LudoEscrowN.
 *                    False means every `join` reverts with TokenNotAllowed.
 *   2. tier rakes  — `tierRakeBps(token, rawAmount)` for each configured tier.
 *                    Rakes are keyed by (token, RAW amount), so nothing carries
 *                    over across a token switch: an unset tier reads 0 and the
 *                    escrow silently falls back to the global rakeBps.
 *   3. store       — the CosmeticsStore's token, and how many catalogue prices
 *                    match at that token's decimals.
 *
 * Decimals come from the token itself, and the value in deployments.json is
 * reported next to it so a drifted config is visible rather than assumed.
 *
 * Usage: NETWORK=celo npm run migration-status -w packages/contracts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  toBytes,
  type Address,
  type Chain,
} from 'viem';
import { PREMIUM_COSMETICS, SEASON_PREMIUM, RAKE_BPS_BY_STAKE, RAKE_BPS } from '../../shared/src/protocol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* rely on ambient env */
}
const env = (n: string): string | undefined => {
  const v = process.env[n];
  return v && v.trim() !== '' ? v.trim() : undefined;
};

const CHAINS: Record<string, { chain: Chain; defaultRpc: string; rpcEnv: string }> = {
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
};

const networkName = env('NETWORK') ?? 'celo';
const preset = CHAINS[networkName];
if (!preset) {
  console.error(`migration-status supports: ${Object.keys(CHAINS).join(', ')}`);
  process.exit(1);
}

const deployments = JSON.parse(readFileSync(join(ROOT, 'deployments.json'), 'utf8')) as Record<string, Record<string, unknown>>;
const dep = deployments[networkName];
if (!dep?.escrow) {
  console.error(`No escrow in deployments.json['${networkName}'].`);
  process.exit(1);
}

const pc = createPublicClient({ chain: preset.chain, transport: http(env(preset.rpcEnv) ?? preset.defaultRpc) });
const token = getAddress(dep.stablecoin as string);

const ESCROW_ABI = [
  { type: 'function', name: 'allowedToken', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'tierRakeBps', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint96' }], outputs: [{ type: 'uint16' }] },
] as const;
const STORE_ABI = [
  { type: 'function', name: 'token', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'priceOf', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
] as const;
const ERC20_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

const mark = (ok: boolean): string => (ok ? 'FAIT   ' : 'A FAIRE');
let outstanding = 0;
const tally = (ok: boolean): boolean => {
  if (!ok) outstanding++;
  return ok;
};

const [symbol, decimals] = await Promise.all([
  pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }),
  pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }),
]);
const dec = Number(decimals);
const configDec = dep.stablecoinDecimals === undefined ? 18 : Number(dep.stablecoinDecimals);
const unit = 10n ** BigInt(dec - 2);

console.log(`network=${networkName}  stake token=${token}  symbol=${symbol}  decimals=${dec}`);
if (configDec !== dec) {
  console.log(`  ⚠ deployments.json says stablecoinDecimals=${configDec} — the chain says ${dec}. Fix the config before any repricing.`);
  outstanding++;
}

console.log('\n1. allowlist (sans elle, chaque join revoque TokenNotAllowed)');
const escrows: Array<[string, Address]> = [['LudoEscrow', dep.escrow as Address]];
if (dep.escrowN) escrows.push(['LudoEscrowN', dep.escrowN as Address]);
for (const [name, addr] of escrows) {
  const ok = (await pc.readContract({ address: addr, abi: ESCROW_ABI, functionName: 'allowedToken', args: [token] })) as boolean;
  console.log(`  ${mark(tally(ok))}  ${name}`);
}

console.log('\n2. rakes par palier (0 on-chain = repli sur le global)');
for (const [centsKey, wantBps] of Object.entries(RAKE_BPS_BY_STAKE)) {
  const cents = Number(centsKey);
  const units = BigInt(cents) * unit;
  const got = Number(await pc.readContract({ address: dep.escrow as Address, abi: ESCROW_ABI, functionName: 'tierRakeBps', args: [token, units] }));
  const effective = got === 0 ? `${RAKE_BPS} (repli global)` : String(got);
  console.log(`  ${mark(tally(got === wantBps))}  ${String(cents).padStart(3)}c = ${String(units).padStart(20)} unites | on-chain ${effective} | attendu ${wantBps}`);
}

console.log('\n3. CosmeticsStore');
if (!dep.cosmeticsStore) {
  console.log('  (pas de store deploye sur ce reseau)');
} else {
  const store = dep.cosmeticsStore as Address;
  const storeToken = getAddress((await pc.readContract({ address: store, abi: STORE_ABI, functionName: 'token' })) as Address);
  console.log(`  ${mark(tally(storeToken === token))}  token = ${storeToken}`);

  const want = [
    ...PREMIUM_COSMETICS.filter((c) => c.cents > 0).map((c) => ({ id: c.id, cents: c.cents })),
    { id: SEASON_PREMIUM.itemId, cents: SEASON_PREMIUM.cents },
  ];
  const wrong: string[] = [];
  for (const w of want) {
    const had = (await pc.readContract({ address: store, abi: STORE_ABI, functionName: 'priceOf', args: [keccak256(toBytes(w.id))] })) as bigint;
    if (had !== BigInt(w.cents) * unit) wrong.push(w.id);
  }
  console.log(`  ${mark(tally(wrong.length === 0))}  prix corrects : ${want.length - wrong.length}/${want.length}`);
  if (wrong.length) console.log(`      a reprixer : ${wrong.slice(0, 8).join(', ')}${wrong.length > 8 ? ` … +${wrong.length - 8}` : ''}`);
}

console.log(
  outstanding === 0
    ? '\nBascule terminee — plus rien en attente on-chain.'
    : `\n${outstanding} point(s) en attente. Ordre : allow-token, puis set-tier-rake (un passage par palier), puis list-cosmetics.`,
);
