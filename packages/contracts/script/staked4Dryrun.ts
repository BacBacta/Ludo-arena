/**
 * Staked 4-player entry — DRY RUN.
 *
 * `LudoEscrowN` has never received a `join` on mainnet, so the listing dossier
 * has no on-chain proof for the 4-player journey (docs/listing/MINIPAY_SUBMISSION.md
 * §2). Producing one needs four funded stakers, which is real money — so this
 * script validates every step that comes BEFORE the money, and stops there.
 *
 * What it actually checks, in order:
 *   1. each seat's USD₮ and native balance against what the entry costs;
 *   2. the SIWE handshake — hello → walletNonce → sign → wallet.prove — which is
 *      the step that used to fail (the 4p queue join raced ahead of it, #189);
 *   3. the staked gate itself, by having ONE seat ask to join the queue and
 *      reading the server's answer. `queue.ok` means every server-side condition
 *      passed: settler armed, consent, wallet proven, durable settlement, geo,
 *      daily limits.
 *
 * WHY ONLY ONE SEAT JOINS THE QUEUE. Four seats would fill a table. If a real
 * player were queuing at that moment they would be seated with us, deposit real
 * money, and then wait for stakes that never come — the server does refund that
 * (MAX_LOCK_POLLS tears the table down), but they would have paid gas and lost
 * the time. A single seat cannot form a table, so it cannot trap anyone; it
 * still gets the full gate verdict. It leaves the queue immediately afterwards.
 *
 * NO KEYS AND NO FUNDS NEEDED to run it: with no SEAT_KEYS it mints four
 * throwaway accounts. They will report a zero balance, which is the point — the
 * protocol path is exercised, and the balance table tells you exactly how much
 * to fund before the real run.
 *
 * This script never sends a transaction. The depositing run (approve + join on
 * LudoEscrowN, then playing the game out so the server settles) is deliberately
 * NOT implemented here — it moves real money and deserves its own reviewed
 * change rather than a flag on a dry-run tool.
 *
 * Usage:
 *   NETWORK=celo npm run staked4-dryrun -w packages/contracts
 *   SEAT_KEYS=0x…,0x…,0x…,0x… STAKE_CENTS=25 …   (your own funded seats)
 *   SRV=ws://localhost:8787 …                     (a local server instead of prod)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, formatUnits, getAddress, http, type Address, type Chain, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { WebSocket } from 'ws';
import { TOS_VERSION, walletProofMessage } from '../../shared/src/protocol.js';

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

const NETWORKS: Record<string, { chain: Chain; rpc: string; srv: string }> = {
  celo: {
    chain: defineChain({
      id: 42_220, name: 'Celo',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: { default: { http: ['https://forno.celo.org'] } },
    }),
    rpc: 'https://forno.celo.org',
    srv: 'wss://ludo-arena.fly.dev',
  },
  'celo-sepolia': {
    chain: defineChain({
      id: 11_142_220, name: 'Celo Sepolia',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } },
    }),
    rpc: 'https://forno.celo-sepolia.celo-testnet.org',
    srv: 'wss://ludo-arena.fly.dev',
  },
};

const networkName = env('NETWORK') ?? 'celo';
const preset = NETWORKS[networkName];
if (!preset) {
  console.error(`staked4-dryrun supports: ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}
if (env('DRY_RUN') === 'false') {
  console.error(
    'staked4-dryrun never sends a transaction. The depositing run (approve + join on\n' +
      'LudoEscrowN, then playing the table out) is not implemented here on purpose — it\n' +
      'moves real money and belongs in its own reviewed change.',
  );
  process.exit(1);
}

const SEATS = 4;
const stakeCents = Number(env('STAKE_CENTS') ?? '25');
if (!Number.isInteger(stakeCents) || stakeCents <= 0) {
  console.error('STAKE_CENTS must be a positive integer (25 = the smallest visible tier).');
  process.exit(1);
}
const srv = env('SRV') ?? preset.srv;

const deployments = JSON.parse(readFileSync(join(ROOT, 'deployments.json'), 'utf8')) as Record<string, Record<string, unknown>>;
const dep = deployments[networkName];
if (!dep?.escrowN) {
  console.error(`No escrowN in deployments.json['${networkName}'].`);
  process.exit(1);
}
const token = getAddress(dep.stablecoin as string);
const escrowN = getAddress(dep.escrowN as string);

const pc = createPublicClient({ chain: preset.chain, transport: http(env('CELO_RPC') ?? preset.rpc) });
const ERC20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

// ---------------------------------------------------------------- seats

const rawKeys = env('SEAT_KEYS')?.split(',').map((k) => k.trim()).filter(Boolean) ?? [];
if (rawKeys.length && rawKeys.length !== SEATS) {
  console.error(`SEAT_KEYS must list exactly ${SEATS} keys (got ${rawKeys.length}).`);
  process.exit(1);
}
const ephemeral = rawKeys.length === 0;
const accounts = (ephemeral ? Array.from({ length: SEATS }, () => generatePrivateKey()) : rawKeys.map((k) => (k.startsWith('0x') ? k : `0x${k}`) as Hex))
  .map((k) => privateKeyToAccount(k as Hex));

console.log(`[dryrun] réseau=${networkName}  serveur=${srv}  mise=${stakeCents}c/siège`);
console.log(`[dryrun] escrowN=${escrowN}`);
console.log(ephemeral ? '[dryrun] SEAT_KEYS absent → 4 comptes jetables générés (solde nul attendu)\n' : '[dryrun] 4 sièges fournis via SEAT_KEYS\n');

// ---------------------------------------------------------------- 1. balances

const [symbol, decimals] = await Promise.all([
  pc.readContract({ address: token, abi: ERC20, functionName: 'symbol' }),
  pc.readContract({ address: token, abi: ERC20, functionName: 'decimals' }),
]);
const need = BigInt(stakeCents) * 10n ** BigInt(Number(decimals) - 2);

console.log(`1. SOLDES — il faut ${formatUnits(need, Number(decimals))} ${symbol} par siège, plus le gas`);
let funded = 0;
for (const [i, a] of accounts.entries()) {
  const [bal, native] = await Promise.all([
    pc.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [a.address] }) as Promise<bigint>,
    pc.getBalance({ address: a.address }),
  ]);
  const ok = bal >= need;
  if (ok) funded++;
  console.log(
    `   ${ok ? 'OK     ' : 'INSUFF.'} siège ${i + 1} ${a.address}` +
      `  ${formatUnits(bal, Number(decimals))} ${symbol} · ${formatUnits(native, 18)} CELO`,
  );
}
console.log(`   → ${funded}/${SEATS} sièges financés\n`);

// ---------------------------------------------------------------- 2 + 3. protocol

interface SeatResult {
  address: Address;
  helloOk: boolean;
  nonceIssued: boolean;
  proofSent: boolean;
  error?: string;
}

/** Run one seat through hello → SIWE. `askQueue` additionally asks to join the
 *  staked queue and resolves on the server's verdict. */
function runSeat(account: (typeof accounts)[number], askQueue: boolean): Promise<SeatResult & { verdict?: string }> {
  return new Promise((resolve) => {
    const out: SeatResult & { verdict?: string } = { address: account.address, helloOk: false, nonceIssued: false, proofSent: false };
    const ws = new WebSocket(srv);
    const finish = (): void => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(out);
    };
    const timer = setTimeout(() => {
      out.error ??= 'timeout';
      finish();
    }, 20_000);

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          t: 'hello',
          entropyCommit: '0'.repeat(64),
          wallet: account.address,
          fingerprint: `dryrun-${account.address.slice(2, 10)}`,
          consent: { tosVersion: TOS_VERSION, age18: true },
          miniPay: false,
        }),
      );
    });
    ws.on('message', (d) => {
      let m: { t: string; walletNonce?: string; message?: string; position?: number };
      try {
        m = JSON.parse(String(d));
      } catch {
        return;
      }
      if (m.t === 'hello.ok') {
        out.helloOk = true;
        out.nonceIssued = !!m.walletNonce;
        if (!m.walletNonce) {
          // Already proven, or the server did not ask — nothing to sign.
          if (!askQueue) {
            clearTimeout(timer);
            finish();
          } else ws.send(JSON.stringify({ t: 'queue.join4', stakeCents }));
          return;
        }
        void account.signMessage({ message: walletProofMessage(m.walletNonce) }).then((signature) => {
          ws.send(JSON.stringify({ t: 'wallet.prove', signature }));
          out.proofSent = true;
          // Same ordering the client uses since #189: prove first, ask second.
          if (askQueue) ws.send(JSON.stringify({ t: 'queue.join4', stakeCents }));
          else {
            clearTimeout(timer);
            finish();
          }
        });
        return;
      }
      if (m.t === 'queue.ok') {
        out.verdict = `queue.ok (position ${m.position}) — tous les gardes misés sont passés`;
        clearTimeout(timer);
        finish(); // leave at once: one seat alone can never form a table
        return;
      }
      if (m.t === 'error') {
        out.verdict = `refus : "${m.message}"`;
        out.error = m.message;
        clearTimeout(timer);
        finish();
      }
    });
    ws.on('error', (e: Error) => {
      out.error = e.message;
      clearTimeout(timer);
      finish();
    });
  });
}

console.log('2. PREUVE DE PORTEFEUILLE (SIWE) — le pas qui échouait avant #189');
const proofs = await Promise.all(accounts.map((a) => runSeat(a, false)));
for (const [i, p] of proofs.entries()) {
  const state = p.error ? `ERREUR ${p.error}` : p.proofSent ? 'signée + envoyée' : p.nonceIssued ? 'nonce reçu, non signé' : 'aucun nonce demandé';
  console.log(`   ${p.proofSent || (!p.error && !p.nonceIssued) ? 'OK     ' : 'ECHEC  '} siège ${i + 1} ${p.address}  ${state}`);
}
const proven = proofs.filter((p) => p.proofSent && !p.error).length;
console.log(`   → ${proven}/${SEATS} sièges prouvés\n`);

console.log('3. GARDE MISÉ — un seul siège interroge la file, puis se retire');
const probeSeat = accounts[0];
if (!probeSeat) {
  console.error('aucun siège à sonder — SEAT_KEYS est vide ET la génération a échoué.');
  process.exit(1);
}
const gate = await runSeat(probeSeat, true);
console.log(`   ${gate.verdict ?? `pas de verdict (${gate.error ?? 'silence'})`}\n`);

// ---------------------------------------------------------------- verdict

const gateOk = gate.verdict?.startsWith('queue.ok') ?? false;
console.log('RÉSUMÉ');
console.log(`   soldes    : ${funded}/${SEATS} sièges financés`);
console.log(`   preuve    : ${proven}/${SEATS} sièges prouvés`);
console.log(`   garde     : ${gateOk ? 'franchi' : 'bloqué'}`);
if (gateOk && funded === SEATS) {
  console.log('\n   Tout est prêt pour une vraie partie. Le dépôt on-chain reste à écrire —');
  console.log('   il déplace de l\'argent réel et fait l\'objet d\'un changement séparé.');
} else if (gateOk) {
  console.log(`\n   Le parcours protocole est bon ; il manque les fonds. Envoie au moins`);
  console.log(`   ${formatUnits(need, Number(decimals))} ${symbol} + un peu de CELO à chacun des ${SEATS - funded} siège(s) non financé(s).`);
} else {
  console.log('\n   Le garde refuse : lis le message ci-dessus, il nomme la condition qui bloque');
  console.log('   (settler armé, consentement, preuve, durabilité du règlement, géo, limites).');
}
