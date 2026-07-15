/**
 * Server settlement-emission coverage (audit risk 1) — run with tsx.
 *
 * The SettlementQueue LOGIC is already unit-tested with a MOCK arbiter
 * (apps/server/test/settlement.test.ts). This closes the one remaining seam: the
 * REAL Arbiter submitting settle() on-chain through the real queue, and onSettled
 * firing with a genuinely-mined txHash — the exact code path index.ts wires into
 * `onResult`, minus matchmaking (so the same-network anti-collusion gate is not
 * involved: enqueue() takes a gameId + winner directly).
 *
 * It also settles the enum question: my contract probe once read the deployed
 * escrow's status as 1 (looked like Active=1 vs the server's Active=2), which —
 * if real — would make the server misclassify a ready game as WaitingOpponent
 * and REFUND instead of pay. This test decides it empirically: it waits for the
 * on-chain status to reach the server's Active(2) before enqueueing; if that
 * never happens, the mismatch is real; if it settles, deployed == source.
 *
 * Needs: the funded test wallets (scratchpad) and packages/contracts/.env.
 */
import {
  createPublicClient, createWalletClient, http, formatUnits, toHex,
  encodeAbiParameters, keccak256,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celoSepolia } from 'viem/chains';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SettlementQueue, createArbiter, GameStatus } from '../../apps/server/src/settlement.js';
import { MemoryStore } from '../../apps/server/src/store/memory.js';

const pass: string[] = [];
const fail: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  (ok ? pass : fail).push(name);
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const env = Object.fromEntries(
  readFileSync(new URL('../../packages/contracts/.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
) as Record<string, string>;
const RPC = env.CELO_SEPOLIA_RPC || 'https://forno.celo-sepolia.celo-testnet.org';
const dep = JSON.parse(readFileSync(new URL('../../apps/web/src/deployments.json', import.meta.url), 'utf8'))['celo-sepolia'];
const { players } = JSON.parse(readFileSync('/tmp/claude-1000/-workspaces-Ludo-arena/00d95733-8211-42be-a067-2b4e08916f8a/scratchpad/test-wallets.json', 'utf8'));

const pub = createPublicClient({ chain: celoSepolia, transport: http(RPC) });
const norm = (k: string) => (k.startsWith('0x') ? k : `0x${k}`) as `0x${string}`;

const ERC20 = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const ESCROW = [
  { type: 'function', name: 'join', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }, { name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' }], outputs: [] },
  { type: 'function', name: 'games', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' }, { name: 'playerA', type: 'address' }, { name: 'playerB', type: 'address' }, { name: 'createdAt', type: 'uint40' }, { name: 'status', type: 'uint8' }] },
] as const;

const dec: number = dep.stablecoinDecimals;
const STAKE = BigInt(25) * 10n ** BigInt(dec - 2);
const usd = (v: bigint) => formatUnits(v, dec);
const bal = (a: string) => pub.readContract({ address: dep.stablecoin, abi: ERC20, functionName: 'balanceOf', args: [a as `0x${string}`] });

const P = players.map((p: { pk: string; address: string }) => {
  const account = privateKeyToAccount(norm(p.pk));
  return { account, w: createWalletClient({ account, chain: celoSepolia, transport: http(RPC) }) };
});
void (async () => {
  const gasPrice = await pub.getGasPrice();
  const TX = { type: 'legacy' as const, gasPrice };
  const gameId = toHex(randomBytes(32));

  // 1. build an Active game on-chain (two real joins)
  const winnerBefore = await bal(P[0].account.address);
  for (const p of P) {
    const allowance = await pub.readContract({ address: dep.stablecoin, abi: ERC20, functionName: 'allowance', args: [p.account.address, dep.escrow] });
    if (allowance < STAKE) {
      const aTx = await p.w.writeContract({ address: dep.stablecoin, abi: ERC20, functionName: 'approve', args: [dep.escrow, STAKE], gas: 70_000n, ...TX });
      await pub.waitForTransactionReceipt({ hash: aTx });
    }
    const jTx = await p.w.writeContract({ address: dep.escrow, abi: ESCROW, functionName: 'join', args: [gameId, dep.stablecoin, STAKE], gas: 180_000n, ...TX });
    await pub.waitForTransactionReceipt({ hash: jTx });
  }

  // 2. wait until the deployed contract firmly reports the server's Active(2),
  //    distinguishing forno read-lag from a real enum offset
  let onchainStatus = -1;
  const statusDeadline = Date.now() + 45_000;
  while (Date.now() < statusDeadline) {
    const g = await pub.readContract({ address: dep.escrow, abi: ESCROW, functionName: 'games', args: [gameId] });
    onchainStatus = Number(g[5]);
    if (onchainStatus === GameStatus.Active) break;
    await sleep(2000);
  }
  check(`deployed escrow reports Active(${GameStatus.Active}) for a fully-joined game`, onchainStatus === GameStatus.Active,
    `read status=${onchainStatus}${onchainStatus !== GameStatus.Active ? ' — server GameStatus enum would MISCLASSIFY this game' : ''}`);

  // 3. wire the REAL server queue exactly as index.ts does
  const arbiter = createArbiter({
    ARBITER_PRIVATE_KEY: env.DEPLOYER_PRIVATE_KEY,
    CHAIN: 'celo-sepolia',
    ESCROW_ADDRESS: dep.escrow,
    SETTLEMENT_RPC: RPC,
  } as NodeJS.ProcessEnv);
  check('real Arbiter constructed (key + escrow + chain resolved)', !!arbiter);
  if (!arbiter) { console.log(`\n[settle-queue] ${pass.length}/${pass.length + fail.length} passed`); process.exit(1); }

  let settledTx: string | null = null;
  let refundedTx: string | null = null;
  let alert: string | null = null;
  const done = new Promise<void>((resolve) => {
    const store = new MemoryStore();
    const queue = new SettlementQueue({
      store,
      arbiter,
      onSettled: (gid: string, tx: string) => { if (gid === gameId) { settledTx = tx; resolve(); } },
      onRefunded: (gid: string, tx: string) => { if (gid === gameId) { refundedTx = tx; resolve(); } },
      onAlert: (m: string) => { alert = m; resolve(); },
    });
    // 4. exactly what onResult does for a staked game
    void queue.enqueue(gameId, P[0].account.address);
  });
  await Promise.race([done, sleep(150_000)]);

  check('queue emitted game.settled (onSettled fired) — not refund/alert', !!settledTx && !refundedTx && !alert,
    settledTx ? `tx ${String(settledTx).slice(0, 12)}…` : refundedTx ? `REFUNDED instead (${String(refundedTx).slice(0, 12)}…)` : alert ? `ALERT: ${alert}` : 'nothing fired within 150s');

  if (settledTx) {
    const r = await pub.waitForTransactionReceipt({ hash: settledTx as `0x${string}` }).catch(() => null);
    check('the settle tx mined successfully', r?.status === 'success', settledTx);
    await sleep(3000);
    const winnerAfter = await bal(P[0].account.address);
    const payout = BigInt(2) * STAKE - (BigInt(2) * STAKE * 900n) / 10_000n; // pot − 9% rake
    check('winner paid via the server path (net = payout − stake)', winnerAfter - winnerBefore === payout - STAKE,
      `Δ ${usd(winnerAfter - winnerBefore)} (expected +${usd(payout - STAKE)})`);
  }

  console.log(`\n[settle-queue] ${pass.length}/${pass.length + fail.length} checks passed${fail.length ? ` — FAILURES: ${fail.join(', ')}` : ''}`);
  process.exit(fail.length ? 1 : 0);

})();
