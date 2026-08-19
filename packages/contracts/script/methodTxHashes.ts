/**
 * READ-ONLY evidence collector for the MiniPay listing submission: finds a real
 * mainnet transaction hash for EACH user-facing method of our deployed
 * contracts (stake, settlement, cosmetic purchase, Race Pass mint).
 *
 * Why this exists: `deployments.json` only records the DEPLOYMENT tx of each
 * contract. The listing form asks for proof that each user journey actually
 * happened on-chain, which is a different question — and one nobody could
 * answer without hand-scrolling the explorer.
 *
 * Sends NO transaction and needs NO key: it reads the public Blockscout
 * etherscan-compatible `txlist` endpoint and groups the results by the 4-byte
 * selector in the calldata, mapping each selector to its Solidity signature
 * from the table below (kept in sync with `src/*.sol`).
 *
 * For every method it reports the FIRST and the LATEST successful call, because
 * the two answer different reviewer questions ("has this ever worked?" and "is
 * it still live?"). Methods with no call at all are listed explicitly — a
 * user-facing method that has never run on mainnet is itself a finding.
 *
 * Usage:
 *   NETWORK=celo npm run method-tx-hashes -w packages/contracts
 *   NETWORK=celo METHOD_TX_JSON=1 npm run method-tx-hashes -w packages/contracts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAddress, toFunctionSelector, type Address } from 'viem';

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

const NETWORKS: Record<string, { blockscout: string; explorer: string }> = {
  'celo-sepolia': { blockscout: 'https://celo-sepolia.blockscout.com', explorer: 'https://celo-sepolia.blockscout.com/tx/' },
  celo: { blockscout: 'https://celo.blockscout.com', explorer: 'https://celoscan.io/tx/' },
};

const networkName = env('NETWORK') ?? 'celo';
const preset = NETWORKS[networkName];
if (!preset) {
  console.error(`method-tx-hashes: set NETWORK to one of: ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}
const BLOCKSCOUT = env('BLOCKSCOUT_URL') ?? preset.blockscout;

type Dep = { escrow?: Address; escrowN?: Address; cosmeticsStore?: Address; racePass?: Address };
const deployments = JSON.parse(readFileSync(join(ROOT, 'deployments.json'), 'utf8')) as Record<string, Dep>;
const dep = deployments[networkName];
if (!dep) {
  console.error(`method-tx-hashes: no deployment block for '${networkName}' in deployments.json.`);
  process.exit(1);
}

/**
 * The methods a MiniPay reviewer can reach, per contract. `journey` is the
 * player-visible action the reviewer is being asked to verify; methods without
 * one are owner/ops calls, reported separately so they never get mistaken for
 * evidence of a player journey.
 */
type MethodDef = { sig: string; journey?: string };
type ContractDef = { label: string; addr: Address | undefined; methods: MethodDef[] };

const CONTRACTS: ContractDef[] = [
  {
    label: 'LudoEscrow (1v1)',
    addr: dep.escrow,
    methods: [
      { sig: 'join(bytes32,address,uint96,bytes32)', journey: 'placer une mise (1v1)' },
      { sig: 'settle(bytes32,address,string,string,string,bytes)', journey: 'règlement du gagnant (1v1)' },
      { sig: 'settleBatch(bytes32[],address[],bytes[])', journey: 'règlement groupé' },
      { sig: 'refundExpired(bytes32)', journey: 'remboursement d’une partie expirée' },
      { sig: 'refundActive(bytes32)', journey: 'remboursement d’une partie active' },
      { sig: 'withdraw(address)' },
      { sig: 'voidGame(bytes32)' },
      { sig: 'setTokenAllowed(address,bool)' },
      { sig: 'setTierRakeBps(address,uint96,uint16)' },
      { sig: 'setRakeBps(uint256)' },
      { sig: 'transferOwnership(address)' },
    ],
  },
  {
    label: 'LudoEscrowN (multijoueur)',
    addr: dep.escrowN,
    methods: [
      { sig: 'join(bytes32,address,uint96,uint8,bytes32)', journey: 'placer une mise (table 4 joueurs)' },
      { sig: 'settle(bytes32,address,string,string[],bytes)', journey: 'règlement du gagnant (4 joueurs)' },
      { sig: 'settleBatch(bytes32[],address[],bytes[])', journey: 'règlement groupé' },
      { sig: 'refundExpired(bytes32)', journey: 'remboursement d’une partie expirée' },
      { sig: 'refundActive(bytes32)', journey: 'remboursement d’une partie active' },
      { sig: 'withdraw(address)' },
      { sig: 'voidGame(bytes32)' },
      { sig: 'setTokenAllowed(address,bool)' },
      { sig: 'setTierRakeBps(address,uint96,uint16)' },
      { sig: 'setRakeBps(uint256)' },
      { sig: 'transferOwnership(address)' },
    ],
  },
  {
    label: 'CosmeticsStore',
    addr: dep.cosmeticsStore,
    methods: [
      { sig: 'buy(bytes32)', journey: 'achat d’un cosmétique' },
      { sig: 'setPrice(bytes32,uint256)' },
      { sig: 'setPrices(bytes32[],uint256[])' },
      { sig: 'setToken(address)' },
      { sig: 'transferOwnership(address)' },
    ],
  },
  {
    label: 'RacePass',
    addr: dep.racePass,
    methods: [
      { sig: 'mint()', journey: 'mint du Race Pass' },
      { sig: 'setMintOpen(bool)' },
      { sig: 'setTokenURI(string)' },
      { sig: 'transferOwnership(address)' },
    ],
  },
];

const CAP = 10_000; // etherscan-compat txlist page cap

type Tx = { hash: string; input: string; isError?: string; txreceipt_status?: string; timeStamp?: string; from?: string };

/** Every top-level transaction sent TO `addr`, oldest first. */
async function txlist(addr: Address): Promise<Tx[] | null> {
  try {
    const url = `${BLOCKSCOUT}/api?module=account&action=txlist&address=${addr}&startblock=0&endblock=99999999&page=1&offset=${CAP}&sort=asc`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const j = (await res.json()) as { status?: string; message?: string; result?: unknown };
    if (Array.isArray(j.result)) return j.result as Tx[];
    // An empty (but valid) address is a real zero, not a probe failure.
    if (j.status === '0' && typeof j.message === 'string' && /no transactions/i.test(j.message)) return [];
    return null;
  } catch {
    return null;
  }
}

/** A reverted call is not evidence that a journey works — only count successes. */
const succeeded = (t: Tx): boolean => t.isError !== '1' && t.txreceipt_status !== '0';

const iso = (t: Tx): string => {
  const s = Number(t.timeStamp);
  return Number.isFinite(s) && s > 0 ? new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ') : '?';
};

type Found = { sig: string; journey?: string; count: number; first?: Tx; last?: Tx };

const report: Array<{ label: string; addr: Address; total: number; found: Found[] }> = [];
const unreachable: string[] = [];

for (const c of CONTRACTS) {
  if (!c.addr || !isAddress(c.addr)) continue;
  const txs = await txlist(c.addr);
  if (txs === null) {
    unreachable.push(c.label);
    continue;
  }
  // selector → method, built from the signatures above (never from the chain,
  // so an unknown selector stays visibly unknown instead of being guessed).
  const bySelector = new Map<string, MethodDef>();
  for (const m of c.methods) bySelector.set(toFunctionSelector(`function ${m.sig}`), m);

  const acc = new Map<string, Found>();
  for (const t of txs) {
    if (!succeeded(t)) continue;
    const sel = (t.input ?? '').slice(0, 10).toLowerCase();
    const m = bySelector.get(sel);
    if (!m) continue;
    const cur = acc.get(m.sig) ?? { sig: m.sig, journey: m.journey, count: 0 };
    cur.count += 1;
    cur.first ??= t; // txlist is sorted ascending
    cur.last = t;
    acc.set(m.sig, cur);
  }
  const found = c.methods.map((m) => acc.get(m.sig) ?? { sig: m.sig, journey: m.journey, count: 0 });
  report.push({ label: c.label, addr: c.addr, total: txs.length, found });
}

if (env('METHOD_TX_JSON')) {
  console.log(
    JSON.stringify(
      {
        network: networkName,
        explorer: preset.explorer,
        contracts: report.map((r) => ({
          label: r.label,
          address: r.addr,
          totalTxs: r.total,
          methods: r.found.map((f) => ({
            method: f.sig,
            journey: f.journey ?? null,
            successfulCalls: f.count,
            firstTx: f.first?.hash ?? null,
            firstAt: f.first ? iso(f.first) : null,
            latestTx: f.last?.hash ?? null,
            latestAt: f.last ? iso(f.last) : null,
          })),
        })),
        unreachable,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`\nnetwork=${networkName}  explorer=${preset.explorer}\n`);
  console.log('Hashes de transaction par méthode utilisateur (dossier de listing MiniPay).');
  console.log('Seuls les appels RÉUSSIS comptent — un revert ne prouve aucun parcours.\n');
  for (const r of report) {
    console.log(`${r.label}  ${r.addr}   (${r.total} tx entrantes)`);
    const journeys = r.found.filter((f) => f.journey);
    const ops = r.found.filter((f) => !f.journey);
    const line = (f: Found, pad: number): void => {
      const name = `${f.sig.split('(')[0]}`.padEnd(pad);
      if (f.count === 0) {
        console.log(`  MANQUANT  ${name} — aucun appel réussi sur ${networkName}`);
        return;
      }
      console.log(`  OK        ${name} — ${f.count} appel(s)`);
      console.log(`              1er     ${f.first!.hash}  (${iso(f.first!)})`);
      if (f.last && f.last.hash !== f.first!.hash) console.log(`              dernier ${f.last.hash}  (${iso(f.last)})`);
    };
    const pad = Math.max(...r.found.map((f) => f.sig.split('(')[0]!.length));
    if (journeys.length) {
      console.log('  — parcours joueur —');
      for (const f of journeys) line(f, pad);
    }
    if (ops.length) {
      console.log('  — owner / ops —');
      for (const f of ops) line(f, pad);
    }
    console.log('');
  }
  const missing = report.flatMap((r) => r.found.filter((f) => f.journey && f.count === 0).map((f) => `${r.label}:${f.sig.split('(')[0]}`));
  if (missing.length) console.log(`⚠  parcours joueur SANS preuve on-chain : ${missing.join(', ')}`);
  else console.log('Tous les parcours joueur ont au moins une transaction réussie.');
  if (unreachable.length) console.log(`⚠  explorateur injoignable pour : ${unreachable.join(', ')} — relancer.`);
}
