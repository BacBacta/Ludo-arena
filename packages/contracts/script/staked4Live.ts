/**
 * Staked 4-player entry — THE REAL ONE. This script SENDS TRANSACTIONS and
 * MOVES REAL MONEY. It is the only script in the repo that does, from a key.
 *
 * It exists to close the last hole in the listing dossier: `LudoEscrowN` has
 * never received a `join` on mainnet, so the 4-player journey has no on-chain
 * evidence (docs/listing/MINIPAY_SUBMISSION.md §2). Producing that evidence
 * needs four funded stakers playing a real game — there is no shortcut, because
 * bots have no funds and QA sessions are excluded from staked queues.
 *
 * What it does, in order:
 *   1. preflight, all read-only — chain id, the escrow the SERVER settles
 *      against vs. the one we are about to pay, token allowlist, per-seat
 *      balances. Any mismatch aborts before a single transaction;
 *   2. four sockets: hello (with a real entropy commit) → SIWE proof →
 *      queue.join4 at the same stake;
 *   3. THE BARRIER — it waits until all four sockets report the SAME gameId
 *      before anyone pays. See "the stranger" below;
 *   4. approve(exact stake) + join(gameId, token, stake, 4, commit) per seat,
 *      in parallel, then each seat reveals its entropy;
 *   5. plays the game out (roll, then the first legal move) until game.over4,
 *      and prints the arbiter's settle() hash when it lands.
 *
 * THE STRANGER. The server fills a staked table with whoever is queuing. If a
 * real player is matched with us, one of our four seats is left out and the
 * gameIds diverge — step 3 sees that and aborts WITHOUT staking. The stranger
 * may already have deposited; they are refunded by `refundUnfilled` once
 * JOIN_TIMEOUT (120 s) elapses, out of pocket only for gas. That residue is
 * unavoidable and it is the cheap side of the trade: staking anyway would seat
 * them in a table that can never start. Run this off-peak.
 *
 * IF IT DIES MID-RUN, THE MONEY IS NOT LOST. A table that never fills is
 * refundable by ANYONE after 120 s, and an Active game that never settles after
 * 24 h likewise (ACTIVE_TIMEOUT, the lost-key valve). This script exposes the
 * first as a rescue mode:
 *
 *   NETWORK=celo RESCUE=<gameId> npm run staked4-live -w packages/contracts
 *
 * SEATS. Same phrase as `seat-addresses` (packages/contracts/.seat-mnemonic or
 * SEAT_MNEMONIC), or four explicit SEAT_KEYS. Nothing is ever printed but
 * addresses.
 *
 * Usage — it REFUSES to spend unless you say so explicitly:
 *
 *   NETWORK=celo npm run staked4-live -w packages/contracts          # plan only
 *   NETWORK=celo CONFIRM=oui-depense-vraiment npm run staked4-live -w packages/contracts
 */
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  pad,
  stringToHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem';
import { mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { WebSocket } from 'ws';
import { TOS_VERSION, walletProofMessage } from '../../shared/src/protocol.js';

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
/** Wall-clock origin, so every line can say WHEN it happened relative to the run.
 *  The server cancels a matched table 120 s after `match.found4`; without stamps
 *  a failed run cannot tell you which step ate the budget — which is exactly the
 *  hole the second mainnet run left. */
const T0 = Date.now();
const at = (): string => `t+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const CONFIRM_PHRASE = 'oui-depense-vraiment';
const JOIN_TIMEOUT_S = 120; // LudoEscrowN.JOIN_TIMEOUT
const ACTIVE_TIMEOUT_S = 24 * 3600; // LudoEscrowN.ACTIVE_TIMEOUT — the lost-key valve

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
  console.error(`staked4-live supports: ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}

const stakeCents = Number(env('STAKE_CENTS') ?? '25');
if (!Number.isInteger(stakeCents) || stakeCents <= 0) {
  console.error('STAKE_CENTS must be a positive integer (25 = the smallest visible tier).');
  process.exit(1);
}
const srv = env('SRV') ?? preset.srv;
const armed = env('CONFIRM') === CONFIRM_PHRASE;

// ---------------------------------------------------------------- seats

/** Four accounts, from SEAT_KEYS or from the same phrase `seat-addresses` uses. */
function loadSeats(): PrivateKeyAccount[] {
  const rawKeys = env('SEAT_KEYS')?.split(',').map((k) => k.trim()).filter(Boolean) ?? [];
  if (rawKeys.length) {
    if (rawKeys.length !== SEATS) {
      console.error(`SEAT_KEYS must list exactly ${SEATS} keys (got ${rawKeys.length}).`);
      process.exit(1);
    }
    return rawKeys.map((k) => privateKeyToAccount((k.startsWith('0x') ? k : `0x${k}`) as Hex));
  }
  let phrase = env('SEAT_MNEMONIC');
  if (!phrase) {
    try {
      phrase = readFileSync(join(ROOT, '.seat-mnemonic'), 'utf8').trim();
    } catch {
      console.error(
        'staked4-live: no seats. Run `npm run seat-addresses -w packages/contracts` first, or\n' +
          'pass SEAT_MNEMONIC / SEAT_KEYS.',
      );
      process.exit(1);
    }
  }
  try {
    // mnemonicToAccount keeps the key in the account object; we never print it.
    return Array.from({ length: SEATS }, (_, i) => {
      const hd = mnemonicToAccount(phrase, { addressIndex: i }).getHdKey();
      if (!hd.privateKey) throw new Error('no private key');
      return privateKeyToAccount(`0x${Buffer.from(hd.privateKey).toString('hex')}` as Hex);
    });
  } catch {
    console.error('staked4-live: the seat phrase is not a valid BIP-39 mnemonic.');
    process.exit(1);
  }
}

const accounts = loadSeats();

// ---------------------------------------------------------------- chain

const deployments = JSON.parse(readFileSync(join(ROOT, 'deployments.json'), 'utf8')) as Record<
  string,
  { stablecoin: Address; stablecoinDecimals?: number; escrowN?: Address }
>;
const dep = deployments[networkName];
if (!dep?.escrowN) {
  console.error(`staked4-live: no escrowN in deployments.json['${networkName}'].`);
  process.exit(1);
}
const token = getAddress(dep.stablecoin);
const escrowN = getAddress(dep.escrowN);

const pc: PublicClient = createPublicClient({ chain: preset.chain, transport: http(env('CELO_RPC') ?? preset.rpc) });

const ERC20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

const ESCROW_N = [
  {
    type: 'function', name: 'join', stateMutability: 'nonpayable',
    inputs: [
      { name: 'gameId', type: 'bytes32' }, { name: 'token', type: 'address' },
      { name: 'stake', type: 'uint96' }, { name: 'seatCount', type: 'uint8' },
      { name: 'fairnessCommit', type: 'bytes32' },
    ],
    outputs: [],
  },
  { type: 'function', name: 'seatsOf', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'allowedToken', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  {
    type: 'function', name: 'games', stateMutability: 'view', inputs: [{ type: 'bytes32' }],
    outputs: [
      { name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' }, { name: 'seatCount', type: 'uint8' },
      { name: 'joined', type: 'uint8' }, { name: 'createdAt', type: 'uint40' }, { name: 'status', type: 'uint8' },
      { name: 'rakeBps', type: 'uint16' }, { name: 'fairnessCommit', type: 'bytes32' },
    ],
  },
  { type: 'function', name: 'refundUnfilled', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'refundActive', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32' }], outputs: [] },
] as const;

/** The gameId is a HEX string, LEFT-padded into bytes32 — byte-for-byte what
 *  apps/web/src/lib/escrow.ts and apps/server/src/settlement.ts both do.
 *
 *  This was wrong here, and it cost two mainnet pots. Encoding the id as ASCII
 *  right-padded produces a completely different key:
 *    hex,  left-padded : 0x00000000000000000000000000000000 20af47f2…
 *    ASCII, right-padded: 0x3230616634376632…
 *  The joins landed under the second, the server watches the first — so it saw an
 *  empty escrow, timed out every table, and its arbiter never had anything to
 *  settle. Every symptom we chased for two days came from this one line. */
const gameIdToBytes32 = (id: string): Hex => {
  const hex = id.startsWith('0x') ? id.slice(2) : id;
  if (!/^[0-9a-fA-F]{1,64}$/.test(hex)) throw new Error(`gameId is not hex: ${id}`);
  return pad(`0x${hex}` as Hex, { size: 32 });
};
const commitToBytes32 = (c: string): Hex => pad(`0x${c.replace(/^0x/, '')}` as Hex, { size: 32, dir: 'left' });

// ---------------------------------------------------------------- rescue mode

/** The key this script USED to write, before the encoding bug above was found.
 *  Two mainnet pots are sitting under it, so rescue has to be able to look there
 *  — a fix that made its own stranded funds unreachable would be no fix. */
const legacyGameIdToBytes32 = (id: string): Hex => pad(stringToHex(id), { size: 32, dir: 'right' });

const rescue = env('RESCUE');
if (rescue) {
  // Try the correct key first, fall back to the legacy one if the escrow is
  // empty there. Status 0 (None) means "no game at this key", never "no funds".
  let gameId32 = gameIdToBytes32(rescue);
  let g = (await pc.readContract({ address: escrowN, abi: ESCROW_N, functionName: 'games', args: [gameId32] })) as readonly unknown[];
  if (Number(g[5]) === 0) {
    const legacy = legacyGameIdToBytes32(rescue);
    const gl = (await pc.readContract({ address: escrowN, abi: ESCROW_N, functionName: 'games', args: [legacy] })) as readonly unknown[];
    if (Number(gl[5]) !== 0) {
      console.log('[rescue] rien sous la clé correcte — fonds trouvés sous l\'ancien encodage (clé héritée)');
      gameId32 = legacy;
      g = gl;
    }
  }
  const status = Number(g[5]);
  const createdAt = Number(g[4]);
  const age = Math.floor(Date.now() / 1000) - createdAt;
  console.log(`[rescue] ${rescue}  status=${status} (1=Filling 2=Active) joined=${String(g[3])}/${String(g[2])}  age=${age}s`);

  // Two permissionless valves, one per status. Filling → refundUnfilled after
  // JOIN_TIMEOUT. Active → refundActive after ACTIVE_TIMEOUT: the escrow filled
  // but the game never started, and the arbiter's voidGame — the fast path — did
  // not fire. That happened on mainnet (backlog B4P.1): the server drops its own
  // refund job when the deposits land a moment after it gave up, so the 24 h valve
  // is the only way back. Neither call needs a privileged key.
  const plan =
    status === 1
      ? { fn: 'refundUnfilled' as const, readyAt: JOIN_TIMEOUT_S }
      : status === 2
        ? { fn: 'refundActive' as const, readyAt: ACTIVE_TIMEOUT_S }
        : null;
  if (!plan) {
    console.error('[rescue] nothing to recover: the table is neither Filling nor Active (already settled or refunded).');
    process.exit(1);
  }
  if (age < plan.readyAt) {
    const wait = plan.readyAt - age;
    console.error(`[rescue] ${plan.fn} unlocks in ${wait}s (${Math.ceil(wait / 60)} min).`);
    process.exit(1);
  }
  if (!armed) {
    console.log(`[rescue] ${plan.fn} is ready. Re-run with CONFIRM=${CONFIRM_PHRASE} to send it.`);
    process.exit(0);
  }
  const wc = createWalletClient({ account: accounts[0]!, chain: preset.chain, transport: http(env('CELO_RPC') ?? preset.rpc) });
  const hash = await wc.writeContract({ address: escrowN, abi: ESCROW_N, functionName: plan.fn, args: [gameId32] });
  const r = await pc.waitForTransactionReceipt({ hash });
  console.log(`[rescue] ${plan.fn} ${r.status}  ${hash}`);
  process.exit(r.status === 'success' ? 0 : 1);
}

// ---------------------------------------------------------------- 1. preflight

console.log(`\n[live] réseau=${networkName}  serveur=${srv}  mise=${stakeCents}c/siège`);
console.log(`[live] escrowN=${escrowN}  token=${token}`);
console.log(armed ? '[live] ARMÉ — des transactions réelles vont partir\n' : `[live] plan seul (ni transaction ni mise en file). CONFIRM=${CONFIRM_PHRASE} pour armer\n`);

const [chainId, symbol, decimals, allowed] = await Promise.all([
  pc.getChainId(),
  pc.readContract({ address: token, abi: ERC20, functionName: 'symbol' }) as Promise<string>,
  pc.readContract({ address: token, abi: ERC20, functionName: 'decimals' }) as Promise<number>,
  pc.readContract({ address: escrowN, abi: ESCROW_N, functionName: 'allowedToken', args: [token] }) as Promise<boolean>,
]);
const stake = BigInt(stakeCents) * 10n ** BigInt(Number(decimals) - 2);

console.log('1. PRÉVOL (lecture seule)');
const fail = (label: string, detail: string): never => {
  console.error(`   ECHEC   ${label} — ${detail}`);
  process.exit(1);
};
if (chainId !== preset.chain.id) fail('chaîne', `le RPC répond chainId=${chainId}, attendu ${preset.chain.id}`);
console.log(`   OK      chaîne ${chainId}`);
if (!allowed) fail('allowlist', `${symbol} n'est pas autorisé sur LudoEscrowN — un join révertirait TokenNotAllowed`);
console.log(`   OK      ${symbol} autorisé sur l'escrow`);
console.log(`   ·       mise = ${formatUnits(stake, Number(decimals))} ${symbol} par siège`);

let short = 0;
for (const [i, a] of accounts.entries()) {
  const [bal, native] = await Promise.all([
    pc.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [a.address] }) as Promise<bigint>,
    pc.getBalance({ address: a.address }),
  ]);
  const ok = bal >= stake && native > 0n;
  if (!ok) short++;
  console.log(
    `   ${ok ? 'OK     ' : 'INSUFF.'} siège ${i + 1} ${a.address}  ${formatUnits(bal, Number(decimals))} ${symbol} · ${formatUnits(native, 18)} CELO`,
  );
}
if (short) fail('soldes', `${short} siège(s) sous la mise ou sans CELO pour le gas`);
console.log('');

// ---------------------------------------------------------------- sockets

interface Seat {
  account: PrivateKeyAccount;
  ws: WebSocket;
  entropy: string;
  gameId?: string;
  seatIndex?: number;
  fairnessCommit?: string;
  proven: boolean;
  error?: string;
  /** Last action sent, and when — see `act()`. */
  lastKey?: string;
  lastAt?: number;
}

const seats: Seat[] = accounts.map((account) => ({
  account,
  ws: null as unknown as WebSocket,
  // 32 bytes hex = 64 chars, inside the server's 16..128 length window.
  entropy: randomBytes(32).toString('hex'),
  proven: false,
}));
const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const send = (s: Seat, m: unknown): void => s.ws.send(JSON.stringify(m));

/** Send a play action at most once per turn state.
 *
 *  The server announces the same turn twice — `game.turn4`, then the `game.state4`
 *  that carries it — and a state is re-sent on every seat's move. Acting on each
 *  would post duplicate rolls, which the server answers with `error`; during play
 *  that would abort a run whose money is already locked and whose game is fine.
 *  Two seconds is far longer than the gap between those echoes and far shorter
 *  than a real turn. */
function act(s: Seat, kind: 'roll' | 'move', token?: number): void {
  const key = kind === 'roll' ? 'roll' : `move:${token}`;
  const now = Date.now();
  if (s.lastKey === key && s.lastAt !== undefined && now - s.lastAt < 2000) return;
  s.lastKey = key;
  s.lastAt = now;
  send(s, kind === 'roll' ? { t: 'game.roll' } : { t: 'game.move', token });
}

/** Which stage we are in — an `error` before the money moves is fatal (nothing is
 *  at stake yet, so stopping is free); after it, the stakes are locked and the
 *  right move is to keep playing and let the timeout decide. */
let stage: 'queue' | 'deposit' | 'play' = 'queue';
let lateError: string | undefined;

/** Resolves once every seat has a gameId, or rejects on the first hard error. */
let onMatched: (() => void) | undefined;
let onMatchFailed: ((why: string) => void) | undefined;
let gameOver: (() => void) | undefined;

const evidence: { seat: number; approve?: Hex; join?: Hex }[] = [];
/** approve hashes from the pre-approval step, folded into the evidence table. */
const approvals = new Map<number, Hex>();
let settleTx: string | undefined;
let winnerSeat: number | undefined;

function wire(s: Seat, i: number): void {
  s.ws = new WebSocket(srv);
  s.ws.on('open', () => {
    send(s, {
      t: 'hello',
      entropyCommit: sha256Hex(s.entropy),
      wallet: s.account.address,
      fingerprint: `live4-${s.account.address.slice(2, 10)}`,
      consent: { tosVersion: TOS_VERSION, age18: true },
      miniPay: false,
    });
  });
  s.ws.on('message', (d) => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(String(d)) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (m.t) {
      case 'hello.ok': {
        // The escrow the SERVER settles against must be the one we are paying.
        // A drift here (redeploy, stale config) sends four stakes into a contract
        // the arbiter will never settle — the exact failure the client's
        // settlementGuard exists to prevent.
        const contracts = m.contracts as { chainId?: number; escrowN?: string } | undefined;
        const advertised = contracts?.escrowN?.toLowerCase();
        if (advertised && advertised !== escrowN.toLowerCase()) {
          onMatchFailed?.(`le serveur règle sur ${advertised}, nous paierions ${escrowN.toLowerCase()}`);
          return;
        }
        const nonce = m.walletNonce as string | undefined;
        if (!nonce) {
          s.proven = true; // already proven for this wallet
          send(s, { t: 'queue.join4', stakeCents });
          return;
        }
        void s.account.signMessage({ message: walletProofMessage(nonce) }).then((signature) => {
          send(s, { t: 'wallet.prove', signature });
          s.proven = true;
          // prove first, ask second — the ordering the client uses since #189.
          send(s, { t: 'queue.join4', stakeCents });
        });
        return;
      }
      case 'match.found4': {
        s.gameId = m.gameId as string;
        s.seatIndex = m.seat as number;
        s.fairnessCommit = m.fairnessCommit as string;
        // Reveal NOW, exactly like the real client (apps/web/src/lib/remote4.ts):
        // the server starts the table only once the escrow is Active AND all four
        // entropies are in, and it gives up 120 s after the match. Revealing after
        // the deposits — as this script first did — puts the reveal behind four
        // on-chain round-trips and blows that window even when every stake lands.
        send(s, { t: 'game.entropy', entropy: s.entropy });
        console.log(`   ·       ${at()} siège ${i + 1} apparié (table ${s.gameId.slice(0, 8)}…), entropie révélée`);
        if (seats.every((x) => x.gameId)) onMatched?.();
        return;
      }
      case 'game.turn4': {
        if (m.seat === s.seatIndex) act(s, 'roll');
        return;
      }
      case 'game.state4':
      case 'game.moved4': {
        const st = m.state as { turn: number; phase: string; legal: number[] } | undefined;
        if (!st || st.turn !== s.seatIndex) return;
        if (st.phase === 'awaiting-roll') act(s, 'roll');
        else if (st.phase === 'awaiting-move' && st.legal.length) act(s, 'move', st.legal[0]!);
        return;
      }
      case 'game.over4': {
        if (winnerSeat === undefined) {
          winnerSeat = m.winner as number;
          console.log(`\n   partie terminée — siège gagnant ${winnerSeat}, payout ${String(m.payoutCents)}c, rake ${String(m.rakeCents)}c`);
        }
        return;
      }
      case 'game.settled4': {
        if (!settleTx) {
          settleTx = m.txHash as string;
          gameOver?.();
        }
        return;
      }
      case 'game.refunded4': {
        onMatchFailed?.(`table remboursée on-chain (${String(m.txHash)})`);
        return;
      }
      case 'error': {
        s.error = String(m.message);
        const why = `siège ${i + 1} : "${s.error}"`;
        if (stage !== 'queue') {
          // Money is already locked. A rejected action is not a reason to walk
          // away from a game that may still finish — record it and play on.
          lateError ??= why;
          console.log(`   ·       ${at()} ${why}`);
          return;
        }
        onMatchFailed?.(why);
        return;
      }
      default:
        return;
    }
  });
  s.ws.on('error', (e: Error) => onMatchFailed?.(`socket siège ${i + 1} : ${e.message}`));
}

const closeAll = (): void => {
  for (const s of seats) {
    try {
      s.ws?.close();
    } catch {
      /* already closed */
    }
  }
};

if (!armed) {
  console.log('2..5. NON EXÉCUTÉ — le plan s\'arrête ici.');
  console.log(`   Ce qui partirait : 4 × approve(${formatUnits(stake, Number(decimals))} ${symbol}) puis 4 × join sur ${escrowN},`);
  console.log('   soit 8 transactions, puis la partie jouée jusqu\'au règlement par l\'arbitre.');
  console.log(`\n   Pour l'exécuter : CONFIRM=${CONFIRM_PHRASE}\n`);
  process.exit(0);
}

/**
 * Block until the approve is visible to the node that will price the join.
 *
 * A mined receipt does NOT mean the next read sees the write. Public Celo RPCs
 * are load balancers over many nodes: the receipt can come from one that is a
 * block ahead of the one that answers the following `eth_estimateGas`. That node
 * still sees allowance = 0, prices `join` against it, and the call reverts
 * `TransferFailed` (0x90b8ec18) during ESTIMATION — no transaction is ever sent,
 * so nothing shows on-chain and the seat is simply absent from the table.
 *
 * This bit us on the first mainnet run: seats 3 and 4 approved fine, then both
 * died on the estimate while seats 1 and 2 got in, leaving a half-filled table
 * to refund. Confirming the allowance through the same read path the estimate
 * uses closes the gap.
 */
async function waitForAllowance(owner: Address): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const seen = (await pc.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [owner, escrowN] })) as bigint;
    if (seen >= stake) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`approve mined but the allowance never became visible for ${owner} — RPC lag`);
}

const rpcUrl = env('CELO_RPC') ?? preset.rpc;

// -------------------------------------------------------- 2. allowances, up front

/**
 * Approve BEFORE queuing, not between the match and the deposit.
 *
 * The server gives a matched table 120 s to become Active with all four entropies
 * in, then cancels it. An `approve` inside that window costs a full transaction
 * round-trip per seat and — as the second mainnet run showed — is what pushes four
 * otherwise-successful joins past the deadline: every stake landed, and the table
 * had already been torn down. The approval is not part of the game, so it has no
 * business being on the clock.
 */
console.log('2. AUTORISATIONS — hors de la fenêtre chronométrée du serveur');
for (const [i, s] of seats.entries()) {
  const allowance = (await pc.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [s.account.address, escrowN] })) as bigint;
  if (allowance >= stake) {
    console.log(`   ·       siège ${i + 1} déjà autorisé`);
    continue;
  }
  // Exact amount, never unlimited: these seats are throwaway, but an infinite
  // allowance outliving the test is a standing liability for no benefit.
  const wc = createWalletClient({ account: s.account, chain: preset.chain, transport: http(rpcUrl) });
  const hash = await wc.writeContract({ address: token, abi: ERC20, functionName: 'approve', args: [escrowN, stake] });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') {
    console.error(`   ECHEC   siège ${i + 1} approve reverted (${hash})`);
    process.exit(1);
  }
  await waitForAllowance(s.account.address);
  approvals.set(i, hash);
  console.log(`   OK      siège ${i + 1} approve ${hash}`);
}
console.log('');

// ---------------------------------------------------------------- 3 + 4. queue

console.log(`3. FILE MISÉE — quatre sièges rejoignent la même table (${at()})`);
seats.forEach(wire);

const matched = await new Promise<{ ok: true } | { ok: false; why: string }>((resolve) => {
  const timer = setTimeout(() => resolve({ ok: false, why: 'aucune table formée en 90 s' }), 90_000);
  onMatched = () => {
    clearTimeout(timer);
    resolve({ ok: true });
  };
  onMatchFailed = (why) => {
    clearTimeout(timer);
    resolve({ ok: false, why });
  };
});
onMatched = undefined;

if (!matched.ok) {
  closeAll();
  console.error(`   ECHEC   ${matched.why}`);
  console.error('   Aucune transaction n\'a été envoyée : rien à rembourser.');
  process.exit(1);
}

// THE BARRIER. Four sockets each hold a gameId; if they are not the SAME one, a
// stranger took a seat and one of ours is elsewhere. Abort before paying.
const gameId = seats[0]!.gameId!;
const commit = seats[0]!.fairnessCommit!;
if (!seats.every((s) => s.gameId === gameId)) {
  closeAll();
  console.error('   ECHEC   les quatre sièges ne sont pas sur la même table (un joueur réel s\'est intercalé).');
  console.error('   Aucune transaction n\'a été envoyée. Relance hors heures de pointe.');
  process.exit(1);
}
if (!seats.every((s) => s.fairnessCommit === commit)) {
  closeAll();
  console.error('   ECHEC   commit d\'équité divergent entre les sièges — join révèrterait CommitMismatch.');
  process.exit(1);
}
console.log(`   OK      ${at()} table ${gameId} — les 4 sièges y sont (indices ${seats.map((s) => s.seatIndex).join(',')})`);
console.log(`   ·       commit d'équité ${commit.slice(0, 16)}…\n`);
stage = 'deposit';

// ---------------------------------------------------------------- 4. money

console.log(`4. DÉPÔT — join seul, ${SEATS} sièges en parallèle (fenêtre de ${JOIN_TIMEOUT_S}s)`);
const gameId32 = gameIdToBytes32(gameId);
const commit32 = commitToBytes32(commit);

const deposits = await Promise.allSettled(
  seats.map(async (s, i) => {
    const wc = createWalletClient({ account: s.account, chain: preset.chain, transport: http(rpcUrl) });
    const row: { seat: number; approve?: Hex; join?: Hex } = { seat: i + 1, approve: approvals.get(i) };
    evidence.push(row);

    // Idempotence: a seat already seated (a retried run, a lost receipt) must not
    // pay twice — join would revert AlreadyJoined and burn gas for nothing.
    const already = (await pc.readContract({ address: escrowN, abi: ESCROW_N, functionName: 'seatsOf', args: [gameId32] })) as readonly Address[];
    if (already.some((p) => p.toLowerCase() === s.account.address.toLowerCase())) {
      console.log(`   ·       siège ${i + 1} déjà assis, rien à payer`);
      return row;
    }

    // One retry: `waitForAllowance` narrows the read-after-write window but cannot
    // pin the estimate to a particular node, so a straggler can still price the
    // join against a stale state. A second attempt a moment later costs nothing
    // when the first succeeded and saves the whole table when it did not.
    for (let attempt = 0; ; attempt++) {
      try {
        row.join = await wc.writeContract({
          address: escrowN, abi: ESCROW_N, functionName: 'join',
          args: [gameId32, token, stake, SEATS, commit32],
        });
        break;
      } catch (e) {
        if (attempt >= 1) throw e;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    const rj = await pc.waitForTransactionReceipt({ hash: row.join! });
    if (rj.status !== 'success') throw new Error(`join reverted (${row.join})`);
    console.log(`   OK      ${at()} siège ${i + 1} déposé  join=${row.join}`);
    return row;
  }),
);

const failed = deposits.filter((d) => d.status === 'rejected');
if (failed.length) {
  for (const f of failed) console.error(`   ECHEC   ${(f as PromiseRejectedResult).reason}`);
  closeAll();
  console.error(
    `\n   ${SEATS - failed.length}/${SEATS} sièges ont payé. La table ne partira pas.\n` +
      `   Les mises déposées sont récupérables dans ${JOIN_TIMEOUT_S}s :\n` +
      `     NETWORK=${networkName} RESCUE=${gameId} CONFIRM=${CONFIRM_PHRASE} npm run staked4-live -w packages/contracts`,
  );
  process.exit(1);
}
console.log(`   → ${at()} ${SEATS}/${SEATS} mises verrouillées\n`);

// When did the escrow actually reach Active? The server starts the table only
// once it sees that AND all four reveals, and it stops looking 120 s after the
// match. Recording the moment separates "our deposits were late" from "the
// server did not act on a table that was ready in time" — the second run could
// not tell those apart.
{
  const g = (await pc.readContract({ address: escrowN, abi: ESCROW_N, functionName: 'games', args: [gameId32] })) as readonly unknown[];
  console.log(`   ·       ${at()} escrow statut=${String(g[5])} (2=Active) joined=${String(g[3])}/${String(g[2])}`);
}

// The entropies were revealed the moment the table was announced (see the
// `match.found4` handler) — the server needs them and the Active escrow together,
// within 120 s of the match.
console.log('5. PARTIE — jeu automatique jusqu\'au règlement');
stage = 'play';

const played = await new Promise<{ ok: true } | { ok: false; why: string }>((resolve) => {
  const timer = setTimeout(() => resolve({ ok: false, why: 'aucun règlement en 10 min' }), 600_000);
  gameOver = () => {
    clearTimeout(timer);
    resolve({ ok: true });
  };
  onMatchFailed = (why) => {
    clearTimeout(timer);
    resolve({ ok: false, why });
  };
});
closeAll();

// ---------------------------------------------------------------- evidence

console.log('\nPREUVE ON-CHAIN');
for (const row of evidence.sort((a, b) => a.seat - b.seat)) {
  if (row.approve) console.log(`   siège ${row.seat} approve  ${row.approve}`);
  console.log(`   siège ${row.seat} join     ${row.join ?? '(déjà assis)'}`);
}
if (settleTx) console.log(`   settle           ${settleTx}   (siège gagnant ${winnerSeat})`);

if (!played.ok) {
  console.error(`\n   La partie ne s'est pas réglée : ${played.why}`);
  if (lateError) console.error(`   Premier refus serveur pendant la partie : ${lateError}`);
  console.error(
    '   Les mises ne sont pas perdues : une partie Active non réglée est remboursable\n' +
      '   par n\'importe qui après 24 h (LudoEscrowN.refundActive).',
  );
  process.exit(1);
}

console.log(`\n   Le parcours 4 joueurs misé a enfin une trace mainnet. Reporte le hash de join`);
console.log('   dans docs/listing/MINIPAY_SUBMISSION.md §2, puis rapatrie ce qui reste sur les sièges.\n');
