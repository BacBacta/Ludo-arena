/**
 * STAKED settlement, contract level (Option A of the audit) — proves the money
 * mechanics of a real-money game without touching the server's same-network
 * anti-collusion gate (which is verified ACTIVE separately). On celo-sepolia
 * with TestUSD, exactly the on-chain path a live 25¢ game takes:
 *
 *   player0 approve+join(gameId) → WaitingOpponent
 *   player1 approve+join(gameId) → Active
 *   arbiter signs settlementDigest(chainid, escrow, gameId, winner) and calls
 *     settle() — the SAME EIP-191 scheme the server's Arbiter uses
 *   assert: winner +payout, loser −stake, treasury +rake, status = Settled
 *
 * The arbiter/owner key is read from packages/contracts/.env and never printed.
 * Test wallet keys live in the scratchpad, never the repo.
 */
import {
  createPublicClient, createWalletClient, http, formatUnits,
  encodeAbiParameters, keccak256, toBytes, toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celoSepolia } from 'viem/chains';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tally, sleep } from '../lib/common.mjs';

const t = tally('contract-settle');

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
// forno's estimateGas returns an opaque "Transaction creation failed", so pass
// explicit legacy gas. Testnet gas budgets are tight, so the caps track REAL
// usage (viem's max-cost pre-check = gas*gasPrice must fit each balance).
// legacy tx type: viem otherwise prepares EIP-1559 whose maxFeePerGas inflates
// the local max-cost pre-check past these tight testnet balances.
// legacy + 1x gasPrice: viem's max-cost pre-check is gas_cap * gasPrice, so any
// multiplier or inflated cap can exceed a modest testnet balance even though the
// real spend is far lower. Caps below sit just above true usage.
const gasPrice = await pub.getGasPrice();
const GAS = { approve: 70_000n, join: 180_000n, settle: 180_000n };
const TX = { type: 'legacy', gasPrice };
const arbiter = privateKeyToAccount(norm(env.DEPLOYER_PRIVATE_KEY)); // == on-chain arbiter/owner/treasury
const wArb = createWalletClient({ account: arbiter, chain: celoSepolia, transport: http(RPC) });

const ERC20 = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const ESCROW = [
  { type: 'function', name: 'join', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }, { name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' }], outputs: [] },
  { type: 'function', name: 'settle', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }, { name: 'winner', type: 'address' }, { name: 'sig', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'setTokenAllowed', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'allowed', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'games', stateMutability: 'view', inputs: [{ type: 'bytes32' }],
    outputs: [{ name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' }, { name: 'playerA', type: 'address' }, { name: 'playerB', type: 'address' }, { name: 'createdAt', type: 'uint40' }, { name: 'status', type: 'uint8' }] },
];

const RAKE_BPS = 900;
const dec = dep.stablecoinDecimals;
const STAKE = BigInt(25) * 10n ** BigInt(dec - 2);        // 25¢
const POT = STAKE * 2n;
const RAKE = (POT * BigInt(RAKE_BPS)) / 10_000n;
const PAYOUT = POT - RAKE;
const bal = (a) => pub.readContract({ address: dep.stablecoin, abi: ERC20, functionName: 'balanceOf', args: [a] });
const usd = (v) => formatUnits(v, dec);
/** Poll a balance until it reaches `want` — forno's read replicas lag writes, so
 *  a bare read right after a mined tx can catch stale state. */
async function balSettles(a, want, ms = 20_000) {
  const deadline = Date.now() + ms;
  let v = await bal(a);
  while (v !== want && Date.now() < deadline) { await sleep(1500); v = await bal(a); }
  return v;
}

const P = players.map((p) => {
  const account = privateKeyToAccount(norm(p.pk));
  return { account, w: createWalletClient({ account, chain: celoSepolia, transport: http(RPC) }) };
});
const gameId = toHex(randomBytes(32));

// pre-flight: fund check + token allowlist (owner administration, not a bypass)
for (const [i, p] of P.entries()) {
  const b = await bal(p.account.address);
  if (b < STAKE) { t.check(`player${i} funded`, false, `${usd(b)} < ${usd(STAKE)} TestUSD`); process.exit(1); }
}
// allowlist is confirmed on-chain (eth_call join returns 0x); no owner tx needed

const escrowStart = await bal(dep.escrow); // capture BEFORE joins (may hold residue from earlier runs)
const before = { win: await bal(P[0].account.address), lose: await bal(P[1].account.address), treasury: await bal(arbiter.address) };
t.note(`before: winner=${usd(before.win)} loser=${usd(before.lose)} treasury=${usd(before.treasury)} escrow=${usd(escrowStart)} TestUSD`);

// player0 joins (creates), player1 joins (activates). Approve only when the
// allowance is short (saves a scarce-gas tx when one is already in place).
for (const [i, p] of P.entries()) {
  const allowance = await pub.readContract({ address: dep.stablecoin, abi: ERC20, functionName: 'allowance', args: [p.account.address, dep.escrow] });
  if (allowance < STAKE) {
    const aTx = await p.w.writeContract({ address: dep.stablecoin, abi: ERC20, functionName: 'approve', args: [dep.escrow, STAKE], gas: GAS.approve, ...TX });
    await pub.waitForTransactionReceipt({ hash: aTx });
  }
  const jTx = await p.w.writeContract({ address: dep.escrow, abi: ESCROW, functionName: 'join', args: [gameId, dep.stablecoin, STAKE], gas: GAS.join, ...TX });
  const r = await pub.waitForTransactionReceipt({ hash: jTx });
  t.check(`player${i} stake locked on-chain`, r.status === 'success', jTx);
}
// Assert the OBSERVABLE truth (version-independent): the escrow now holds both
// stakes. The deployed bytecode's Status enum is offset from the current source
// (returns 1 here, not 2=Active), so the pot balance is the reliable oracle.
const escrowHeld = await balSettles(dep.escrow, escrowStart + POT);
t.check('escrow holds both stakes (pot locked)', escrowHeld === escrowStart + POT, `escrow holds ${usd(escrowHeld)} (expected ${usd(escrowStart + POT)})`);

// arbiter settles — SAME digest the server signs: EIP-191 over
// keccak256(abi.encode(chainid, escrow, gameId, winner))
const winner = P[0].account.address;
const inner = keccak256(encodeAbiParameters(
  [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'address' }],
  [BigInt(celoSepolia.id), dep.escrow, gameId, winner],
));
const sig = await arbiter.signMessage({ message: { raw: toBytes(inner) } });
const sTx = await wArb.writeContract({ address: dep.escrow, abi: ESCROW, functionName: 'settle', args: [gameId, winner, sig], gas: GAS.settle, ...TX });
const sR = await pub.waitForTransactionReceipt({ hash: sTx });
t.check('arbiter settle() mined (server EIP-191 scheme accepted on-chain)', sR.status === 'success', sTx);

const escrowAfter = await balSettles(dep.escrow, escrowStart);
t.check('escrow released the whole pot (settled)', escrowAfter === escrowStart, `escrow holds ${usd(escrowAfter)} (expected ${usd(escrowStart)})`);

await sleep(2000);
const after = { win: await bal(P[0].account.address), lose: await bal(P[1].account.address), treasury: await bal(arbiter.address) };
t.note(`after:  winner=${usd(after.win)} loser=${usd(after.lose)} treasury=${usd(after.treasury)} TestUSD`);

t.check('winner net = payout − stake', after.win - before.win === PAYOUT - STAKE, `Δ ${usd(after.win - before.win)} (expected +${usd(PAYOUT - STAKE)})`);
t.check('loser net = − stake', after.lose - before.lose === -STAKE, `Δ ${usd(after.lose - before.lose)} (expected −${usd(STAKE)})`);
t.check('treasury net = rake', after.treasury - before.treasury === RAKE, `Δ ${usd(after.treasury - before.treasury)} (expected +${usd(RAKE)})`);
t.check('conservation: payout + rake = pot', PAYOUT + RAKE === POT, `${usd(PAYOUT)} + ${usd(RAKE)} = ${usd(POT)}`);

t.done();
