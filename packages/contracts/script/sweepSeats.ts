/**
 * Vide les quatre sièges de test vers une adresse que TU donnes.
 *
 * Les sièges de `seat-addresses` sont jetables par construction : leur phrase
 * BIP-39 a été manipulée hors d'un coffre, donc rien ne doit y rester une fois le
 * test terminé. Ce script fait le ménage.
 *
 * Il envoie le solde ENTIER du jeton de mise de chaque siège vers `DEST`. Le CELO
 * n'est balayé que si tu le demandes (`SWEEP_CELO=1`), et une réserve est laissée
 * sur chaque siège : sans gas, un siège ne peut plus rien signer — ni un
 * remboursement `refundActive` en attente, ni un balayage ultérieur.
 *
 * Comme `staked4-live`, il REFUSE de dépenser sans confirmation explicite :
 *
 *   NETWORK=celo DEST=0x… npm run sweep-seats -w packages/contracts      # plan seul
 *   NETWORK=celo DEST=0x… CONFIRM=oui-depense-vraiment npm run sweep-seats -w packages/contracts
 *   … SWEEP_CELO=1 …                                                     # emporte aussi le CELO
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

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

const SEATS = 4;
const CONFIRM_PHRASE = 'oui-depense-vraiment';
/** Laissé sur chaque siège : de quoi signer plusieurs transactions encore. */
const GAS_RESERVE_WEI = 10_000_000_000_000_000n; // 0.01 CELO

const NETWORKS: Record<string, { chain: Chain; rpc: string }> = {
  celo: {
    chain: defineChain({
      id: 42_220, name: 'Celo',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: { default: { http: ['https://forno.celo.org'] } },
    }),
    rpc: 'https://forno.celo.org',
  },
  'celo-sepolia': {
    chain: defineChain({
      id: 11_142_220, name: 'Celo Sepolia',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } },
    }),
    rpc: 'https://forno.celo-sepolia.celo-testnet.org',
  },
};

const networkName = env('NETWORK') ?? 'celo';
const preset = NETWORKS[networkName];
if (!preset) {
  console.error(`sweep-seats supporte : ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}

const destRaw = env('DEST');
if (!destRaw || !isAddress(destRaw)) {
  console.error(`sweep-seats : DEST doit être une adresse valide (reçu ${destRaw ?? '<vide>'}).`);
  process.exit(1);
}
const dest = getAddress(destRaw);
const armed = env('CONFIRM') === CONFIRM_PHRASE;
const sweepCelo = env('SWEEP_CELO') === '1';

// ---------------------------------------------------------------- sièges

function loadSeats(): PrivateKeyAccount[] {
  const rawKeys = env('SEAT_KEYS')?.split(',').map((k) => k.trim()).filter(Boolean) ?? [];
  if (rawKeys.length) {
    if (rawKeys.length !== SEATS) {
      console.error(`SEAT_KEYS doit lister exactement ${SEATS} clés (reçu ${rawKeys.length}).`);
      process.exit(1);
    }
    return rawKeys.map((k) => privateKeyToAccount((k.startsWith('0x') ? k : `0x${k}`) as Hex));
  }
  let phrase = env('SEAT_MNEMONIC');
  if (!phrase) {
    try {
      phrase = readFileSync(join(ROOT, '.seat-mnemonic'), 'utf8').trim();
    } catch {
      console.error('sweep-seats : aucun siège. Passe SEAT_MNEMONIC / SEAT_KEYS, ou place .seat-mnemonic.');
      process.exit(1);
    }
  }
  try {
    return Array.from({ length: SEATS }, (_, i) => {
      const hd = mnemonicToAccount(phrase, { addressIndex: i }).getHdKey();
      if (!hd.privateKey) throw new Error('pas de clé privée');
      return privateKeyToAccount(`0x${Buffer.from(hd.privateKey).toString('hex')}` as Hex);
    });
  } catch {
    console.error('sweep-seats : la phrase des sièges n\'est pas un mnémonique BIP-39 valide.');
    process.exit(1);
  }
}

const accounts = loadSeats();
// Envoyer un siège vers lui-même brûlerait du gas pour rien et masquerait une
// faute de frappe dans DEST.
if (accounts.some((a) => a.address.toLowerCase() === dest.toLowerCase())) {
  console.error('sweep-seats : DEST est l\'un des sièges. Choisis une destination extérieure.');
  process.exit(1);
}

// ---------------------------------------------------------------- chaîne

const deployments = JSON.parse(readFileSync(join(ROOT, 'deployments.json'), 'utf8')) as Record<
  string,
  { stablecoin: Address; stablecoinDecimals?: number }
>;
const dep = deployments[networkName];
if (!dep?.stablecoin) {
  console.error(`sweep-seats : pas de stablecoin dans deployments.json pour '${networkName}'.`);
  process.exit(1);
}
const token = getAddress(dep.stablecoin);
const rpcUrl = env('CELO_RPC') ?? preset.rpc;
const pc = createPublicClient({ chain: preset.chain, transport: http(rpcUrl) });

const ERC20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

const [symbol, decimals] = await Promise.all([
  pc.readContract({ address: token, abi: ERC20, functionName: 'symbol' }) as Promise<string>,
  pc.readContract({ address: token, abi: ERC20, functionName: 'decimals' }) as Promise<number>,
]);

console.log(`\n[sweep] réseau=${networkName}  jeton=${symbol}  destination=${dest}`);
console.log(armed ? '[sweep] ARMÉ — des transactions réelles vont partir' : `[sweep] plan seul. CONFIRM=${CONFIRM_PHRASE} pour armer`);
console.log(sweepCelo ? `[sweep] le CELO sera balayé aussi (réserve de ${formatUnits(GAS_RESERVE_WEI, 18)} laissée par siège)\n` : '[sweep] CELO conservé sur les sièges (SWEEP_CELO=1 pour l\'emporter)\n');

let movedToken = 0n;
let movedCelo = 0n;

for (const [i, a] of accounts.entries()) {
  const [bal, native] = await Promise.all([
    pc.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [a.address] }) as Promise<bigint>,
    pc.getBalance({ address: a.address }),
  ]);
  console.log(`siège ${i + 1} ${a.address}  ${formatUnits(bal, decimals)} ${symbol} · ${formatUnits(native, 18)} CELO`);
  if (bal === 0n && !sweepCelo) {
    console.log('   ·       rien à emporter');
    continue;
  }
  if (!armed) {
    if (bal > 0n) console.log(`   plan    transfer ${formatUnits(bal, decimals)} ${symbol} → ${dest}`);
    if (sweepCelo && native > GAS_RESERVE_WEI) console.log(`   plan    envoi ~${formatUnits(native - GAS_RESERVE_WEI, 18)} CELO → ${dest}`);
    continue;
  }

  const wc = createWalletClient({ account: a, chain: preset.chain, transport: http(rpcUrl) });
  if (bal > 0n) {
    const hash = await wc.writeContract({ address: token, abi: ERC20, functionName: 'transfer', args: [dest, bal] });
    const r = await pc.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') {
      console.error(`   ECHEC   transfer ${symbol} (${hash})`);
      continue;
    }
    movedToken += bal;
    console.log(`   OK      ${formatUnits(bal, decimals)} ${symbol}  ${hash}`);
  }

  if (!sweepCelo) continue;
  // Le CELO part en DERNIER : le transfert du jeton en a besoin pour son gas, et
  // un siège vidé de son natif ne peut plus rien signer.
  const after = await pc.getBalance({ address: a.address });
  const fees = await pc.estimateFeesPerGas();
  const cap = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
  const cost = 21_000n * cap * 2n; // marge : le prix peut monter entre l'estimation et l'inclusion
  if (after <= GAS_RESERVE_WEI + cost) {
    console.log('   ·       CELO sous la réserve, rien à emporter');
    continue;
  }
  const value = after - GAS_RESERVE_WEI - cost;
  const hash = await wc.sendTransaction({ to: dest, value });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') {
    console.error(`   ECHEC   envoi CELO (${hash})`);
    continue;
  }
  movedCelo += value;
  console.log(`   OK      ${formatUnits(value, 18)} CELO  ${hash}`);
}

console.log(`\nRÉSUMÉ  ${formatUnits(movedToken, decimals)} ${symbol}${sweepCelo ? ` · ${formatUnits(movedCelo, 18)} CELO` : ''} envoyés vers ${dest}`);
if (!armed) console.log(`\n   Rien n'a été envoyé. CONFIRM=${CONFIRM_PHRASE} pour exécuter.\n`);
else console.log('');
