/**
 * M9 refund-all safety net (audit risk 2), contract level. LudoEscrowN's
 * refund-when-a-table-doesn't-fill is the money-safety invariant behind the free
 * 4-player staked mode: if fewer than `seatCount` players join before the join
 * timeout, EVERY depositor must get their stake back — nobody's money is stuck.
 *
 * The server orchestration (SettlementQueue4.refundUnfilled) is already
 * unit-tested; the deployed contract's refund path was not yet exercised.
 * Here two of four seats join a 4-seat game, the join window lapses, and
 * refundUnfilled() (permissionless) must make BOTH depositors whole.
 *
 * On celo-sepolia with TestUSD, escrowN 0x8d7a…. Test wallet keys stay in the
 * scratchpad; the owner/arbiter key stays in the gitignored .env.
 */
import { createPublicClient, createWalletClient, http, formatUnits, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celoSepolia } from 'viem/chains';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tally, sleep } from '../lib/common.mjs';

const t = tally('refund-unfilled');

const env = Object.fromEntries(
  readFileSync(new URL('../../packages/contracts/.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const RPC = env.CELO_SEPOLIA_RPC || 'https://forno.celo-sepolia.celo-testnet.org';
const dep = JSON.parse(readFileSync(new URL('../../apps/web/src/deployments.json', import.meta.url), 'utf8'))['celo-sepolia'];
const { players } = JSON.parse(readFileSync('/tmp/claude-1000/-workspaces-Ludo-arena/00d95733-8211-42be-a067-2b4e08916f8a/scratchpad/test-wallets.json', 'utf8'));

const pub = createPublicClient({ chain: celoSepolia, transport: http(RPC) });
const norm = (k) => (k.startsWith('0x') ? k : `0x${k}`);
const gasPrice = await pub.getGasPrice();
const TX = { type: 'legacy', gasPrice };
const escrowN = dep.escrowN;

const ERC20 = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const ESCROWN = [
  { type: 'function', name: 'join', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }, { name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' }, { name: 'seatCount', type: 'uint8' }], outputs: [] },
  { type: 'function', name: 'refundUnfilled', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }], outputs: [] },
  // deployed bytecode's games() getter returns 6 fields (no trailing rakeBps) —
  // a 7-output ABI overruns the 192-byte return, so decode only the 6 present.
  { type: 'function', name: 'games', stateMutability: 'view', inputs: [{ type: 'bytes32' }],
    outputs: [{ name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' }, { name: 'seatCount', type: 'uint8' }, { name: 'joined', type: 'uint8' }, { name: 'createdAt', type: 'uint40' }, { name: 'status', type: 'uint8' }] },
];

const dec = dep.stablecoinDecimals;
const STAKE = BigInt(25) * 10n ** BigInt(dec - 2);
const usd = (v) => formatUnits(v, dec);
const bal = (a) => pub.readContract({ address: dep.stablecoin, abi: ERC20, functionName: 'balanceOf', args: [a] });
async function balSettles(a, want, ms = 25_000) {
  const deadline = Date.now() + ms;
  let v = await bal(a);
  while (v !== want && Date.now() < deadline) { await sleep(1500); v = await bal(a); }
  return v;
}

const P = players.slice(0, 2).map((p) => {
  const account = privateKeyToAccount(norm(p.pk));
  return { account, w: createWalletClient({ account, chain: celoSepolia, transport: http(RPC) }) };
});
const gameId = toHex(randomBytes(32));
const SEAT_COUNT = 4; // a 4-seat table that only 2 players will join → never fills

const before = [await bal(P[0].account.address), await bal(P[1].account.address)];
const escrowBefore = await bal(escrowN);
t.note(`before: p0=${usd(before[0])} p1=${usd(before[1])} escrowN=${usd(escrowBefore)} TestUSD`);

// two of four seats join → the game stays in Filling
for (const [i, p] of P.entries()) {
  const allowance = await pub.readContract({ address: dep.stablecoin, abi: ERC20, functionName: 'allowance', args: [p.account.address, escrowN] });
  if (allowance < STAKE) {
    const aTx = await p.w.writeContract({ address: dep.stablecoin, abi: ERC20, functionName: 'approve', args: [escrowN, STAKE], gas: 70_000n, ...TX });
    await pub.waitForTransactionReceipt({ hash: aTx });
  }
  const jTx = await p.w.writeContract({ address: escrowN, abi: ESCROWN, functionName: 'join', args: [gameId, dep.stablecoin, STAKE, SEAT_COUNT], gas: 200_000n, ...TX });
  const r = await pub.waitForTransactionReceipt({ hash: jTx });
  t.check(`seat ${i} joined the 4-seat table`, r.status === 'success', jTx);
}
const held = await balSettles(escrowN, escrowBefore + 2n * STAKE);
t.check('escrowN holds both partial stakes (table not full)', held === escrowBefore + 2n * STAKE, `holds ${usd(held)} (expected ${usd(escrowBefore + 2n * STAKE)})`);

const g = await pub.readContract({ address: escrowN, abi: ESCROWN, functionName: 'games', args: [gameId] });
t.check('table is still Filling (2 of 4 joined)', Number(g[3]) === 2 && Number(g[2]) === SEAT_COUNT, `joined=${g[3]}/${g[2]}, status=${g[5]}`);

// wait out the JOIN_TIMEOUT (120s on-chain), then anyone can refund all seats
const createdAt = Number(g[4]);
const JOIN_TIMEOUT = 120;
let waitS = createdAt + JOIN_TIMEOUT - Math.floor(Date.now() / 1000) + 5;
if (waitS > 0) { t.note(`waiting ${waitS}s for the join window to lapse…`); await sleep(waitS * 1000); }

const rTx = await P[0].w.writeContract({ address: escrowN, abi: ESCROWN, functionName: 'refundUnfilled', args: [gameId], gas: 220_000n, ...TX });
const rR = await pub.waitForTransactionReceipt({ hash: rTx });
t.check('refundUnfilled() mined', rR.status === 'success', rTx);

const escrowAfter = await balSettles(escrowN, escrowBefore);
t.check('escrowN released every stake (back to baseline)', escrowAfter === escrowBefore, `holds ${usd(escrowAfter)} (expected ${usd(escrowBefore)})`);

await sleep(2000);
const after = [await bal(P[0].account.address), await bal(P[1].account.address)];
t.note(`after:  p0=${usd(after[0])} p1=${usd(after[1])} TestUSD`);
t.check('every depositor made whole (net zero after refund)', after[0] === before[0] && after[1] === before[1],
  `Δp0 ${usd(after[0] - before[0])}, Δp1 ${usd(after[1] - before[1])}`);

t.done();
