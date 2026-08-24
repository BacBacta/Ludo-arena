/**
 * The four staking seats used to produce on-chain proof of the 4-player journey
 * (`LudoEscrowN.join` — the last ⚠ of docs/listing/MINIPAY_SUBMISSION.md §2).
 *
 * READ-ONLY: prints each seat's address and balance, sends no transaction.
 *
 * WHY A MNEMONIC AND NOT FOUR LOOSE KEYS. The seats have to survive: money is
 * sent to them, sits there between runs, and has to be swept back afterwards.
 * Four private keys pasted around get lost or leaked; one phrase held in one
 * place, deriving the same four addresses every time, does not. The phrase is
 * the ONLY thing that can move those funds — this script never prints it and
 * never sends it anywhere.
 *
 * First run, on YOUR OWN machine (never in CI, never in a throwaway container):
 *
 *   npm run seat-addresses -w packages/contracts
 *
 * With no SEAT_MNEMONIC it mints a fresh phrase, writes it to
 * packages/contracts/.seat-mnemonic (git-ignored, mode 0600) and prints only the
 * four addresses. Back that file up before funding anything: lose it and every
 * USD₮ sent to those addresses is stranded for good. Then either keep it there
 * or move it into your password manager and pass it back as SEAT_MNEMONIC.
 *
 * Later runs, to re-read the same seats and check the money landed:
 *
 *   NETWORK=celo npm run seat-addresses -w packages/contracts
 *
 * The derived keys feed `staked4-dryrun` (SEAT_KEYS) and, eventually, the real
 * depositing run. Deriving them stays a local, deliberate act — this script does
 * not hand them out.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, formatUnits, http, type Address, type Chain } from 'viem';
import { english, generateMnemonic, mnemonicToAccount } from 'viem/accounts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* ambient env */
}
const env = (n: string): string | undefined => {
  const v = process.env[n];
  return v && v.trim() !== '' ? v.trim() : undefined;
};

const NETWORKS: Record<string, { chain: Chain; defaultRpc: string }> = {
  celo: {
    chain: defineChain({
      id: 42_220, name: 'Celo',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: { default: { http: ['https://forno.celo.org'] } },
    }),
    defaultRpc: 'https://forno.celo.org',
  },
  'celo-sepolia': {
    chain: defineChain({
      id: 11_142_220, name: 'Celo Sepolia',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } },
    }),
    defaultRpc: 'https://forno.celo-sepolia.celo-testnet.org',
  },
};

const SEATS = 4;
const MNEMONIC_FILE = join(ROOT, '.seat-mnemonic');

const networkName = env('NETWORK') ?? 'celo';
const preset = NETWORKS[networkName];
if (!preset) {
  console.error(`seat-addresses: set NETWORK to one of: ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}

const stakeCents = Number(env('STAKE_CENTS') ?? '25');
if (!Number.isInteger(stakeCents) || stakeCents <= 0) {
  console.error('seat-addresses: STAKE_CENTS must be a positive integer (25 = the smallest visible tier).');
  process.exit(1);
}

// ---------------------------------------------------------------- the phrase

/** Reads the phrase from the environment, else the local file, else mints one. */
function loadMnemonic(): { phrase: string; origin: 'env' | 'file' | 'generated' } {
  const fromEnv = env('SEAT_MNEMONIC');
  if (fromEnv) return { phrase: fromEnv, origin: 'env' };
  if (existsSync(MNEMONIC_FILE)) {
    const phrase = readFileSync(MNEMONIC_FILE, 'utf8').trim();
    if (phrase) return { phrase, origin: 'file' };
  }
  // Generating in CI would be worse than useless: the runner is wiped, so the
  // only copy of the phrase dies with it while its addresses may already hold
  // money. Refuse, and let a human do it where the phrase can be kept.
  if (env('CI') || env('GITHUB_ACTIONS')) {
    console.error(
      'seat-addresses: no SEAT_MNEMONIC, and refusing to generate one in CI — the runner is\n' +
        'wiped after the job, so the phrase would be lost and any USD₮ on those seats stranded.\n' +
        'Generate it on a machine you keep, then pass it in as the SEAT_MNEMONIC secret.',
    );
    process.exit(1);
  }
  const phrase = generateMnemonic(english);
  writeFileSync(MNEMONIC_FILE, `${phrase}\n`, { mode: 0o600 });
  chmodSync(MNEMONIC_FILE, 0o600);
  return { phrase, origin: 'generated' };
}

const { phrase, origin } = loadMnemonic();
let accounts;
try {
  accounts = Array.from({ length: SEATS }, (_, i) => mnemonicToAccount(phrase, { addressIndex: i }));
} catch {
  console.error(
    `seat-addresses: SEAT_MNEMONIC${origin === 'file' ? ` (from ${MNEMONIC_FILE})` : ''} is not a valid BIP-39 phrase.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------- balances

const deployments = JSON.parse(readFileSync(join(ROOT, 'deployments.json'), 'utf8')) as Record<
  string,
  { stablecoin: Address; stablecoinSymbol?: string; stablecoinDecimals?: number; escrowN?: Address }
>;
const dep = deployments[networkName];
if (!dep?.stablecoin) {
  console.error(`seat-addresses: no stablecoin in deployments.json for '${networkName}'.`);
  process.exit(1);
}
const decimals = Number(dep.stablecoinDecimals ?? 18);
const client = createPublicClient({ chain: preset.chain, transport: http(env('CELO_RPC') ?? preset.defaultRpc) });
const ERC20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

const symbol =
  dep.stablecoinSymbol ??
  ((await client.readContract({ address: dep.stablecoin, abi: ERC20, functionName: 'symbol' }).catch(() => 'token')) as string);
const need = BigInt(stakeCents) * 10n ** BigInt(decimals - 2);

console.log(`\n[seat-addresses] network=${networkName}  token=${symbol} ${dep.stablecoin}`);
console.log(`  phrase: ${origin === 'env' ? 'SEAT_MNEMONIC' : origin === 'file' ? MNEMONIC_FILE : 'NEWLY GENERATED'}  ·  derivation m/44'/60'/0'/0/0…3`);
console.log(`  a seat needs ${formatUnits(need, decimals)} ${symbol} to stake ${stakeCents}c, plus a little CELO for gas\n`);

let funded = 0;
for (const [i, a] of accounts.entries()) {
  const [bal, native] = await Promise.all([
    client.readContract({ address: dep.stablecoin, abi: ERC20, functionName: 'balanceOf', args: [a.address] }) as Promise<bigint>,
    client.getBalance({ address: a.address }),
  ]);
  const ok = bal >= need;
  if (ok) funded++;
  console.log(
    `  seat ${i + 1}  ${a.address}  ${ok ? '✓' : '·'} ${formatUnits(bal, decimals)} ${symbol} · ${formatUnits(native, 18)} CELO`,
  );
}
console.log(`\n  ${funded}/${SEATS} seats funded for a ${stakeCents}c table.`);

if (origin === 'generated') {
  console.log(
    `\n  ⚠ The phrase behind these four addresses was just written to\n` +
      `      ${MNEMONIC_FILE}   (git-ignored, mode 0600)\n` +
      `    That file is the ONLY thing that can ever move funds from them. Back it up\n` +
      `    BEFORE sending any ${symbol}: if it is lost, the money is stranded for good.`,
  );
}
console.log('');
