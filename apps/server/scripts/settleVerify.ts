/**
 * E3.3 acceptance: full arbiter settlement against the LIVE Celo Sepolia
 * escrow, using the server's own Arbiter class (the exact signing/submit path).
 * Two accounts stake, then the arbiter signs (gameId, winner) and submits
 * settle(); asserts the winner is paid pot - rake and reports the elapsed
 * time (AC target: payout < 5 s after game.over).
 *
 * Run: DEPLOYER_PRIVATE_KEY must be the arbiter (deployer) key. `npm run settle-verify -w apps/server`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { setTimeout as sleep } from 'node:timers/promises';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Arbiter, gameIdToBytes32 } from '../src/settlement.js';

const celoSepolia = defineChain({
  id: 11_142_220,
  name: 'Celo Sepolia',
  nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
  rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } },
  testnet: true,
});

const CONTRACTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'contracts');
try {
  process.loadEnvFile(join(CONTRACTS, '.env'));
} catch {
  /* ambient env */
}

const raw = process.env.DEPLOYER_PRIVATE_KEY;
if (!raw) throw new Error('DEPLOYER_PRIVATE_KEY missing (packages/contracts/.env)');
const deployerPk = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
const deployer = privateKeyToAccount(deployerPk);

const deployments = JSON.parse(readFileSync(join(CONTRACTS, 'deployments.json'), 'utf8')) as Record<
  string,
  { chainId: number; escrow: Address; stablecoin: Address }
>;
const dep = deployments['celo-sepolia'];
if (!dep) throw new Error('celo-sepolia deployment missing');

const transport = http();
const publicClient = createPublicClient({ chain: celoSepolia, transport });

const ERC20 = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
const ESCROW_JOIN = [
  { type: 'function', name: 'join', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }, { name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' }], outputs: [] },
] as const;

function assert(cond: boolean, label: string): void {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
  console.log('  ✓', label);
}

const balanceOf = (who: Address): Promise<bigint> =>
  publicClient.readContract({ address: dep.stablecoin, abi: ERC20, functionName: 'balanceOf', args: [who] }) as Promise<bigint>;

const wallet = (pk: Hex) => createWalletClient({ account: privateKeyToAccount(pk), chain: celoSepolia, transport });
const send = async (pk: Hex, address: Address, abi: Abi, functionName: string, args: unknown[]): Promise<void> => {
  const hash = await wallet(pk).writeContract({ account: privateKeyToAccount(pk), chain: celoSepolia, address, abi, functionName, args } as never);
  const r = await publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
};

const stake = parseEther('0.25'); // 25 cents, 18 decimals
const player2Pk = generatePrivateKey();
const player2 = privateKeyToAccount(player2Pk);
const bytes = new Uint8Array(16);
crypto.getRandomValues(bytes);
const gameId = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

console.log(`[settle-verify] escrow=${dep.escrow} arbiter=${deployer.address}`);
console.log(`[settle-verify] playerA=${deployer.address} playerB=${player2.address}`);
console.log(`[settle-verify] gameId=${gameId} → ${gameIdToBytes32(gameId)}`);

// fund player2 with a little CELO for gas
console.log('[settle-verify] funding player2 with gas…');
const fundHash = await wallet(deployerPk).sendTransaction({ account: deployer, chain: celoSepolia, to: player2.address, value: parseEther('0.02') });
await publicClient.waitForTransactionReceipt({ hash: fundHash });

console.log('[settle-verify] both players stake (mint + approve + join)…');
for (const pk of [deployerPk, player2Pk]) {
  const addr = privateKeyToAccount(pk).address;
  await send(pk, dep.stablecoin, ERC20, 'mint', [addr, stake]);
  await send(pk, dep.stablecoin, ERC20, 'approve', [dep.escrow, stake]);
  await send(pk, dep.escrow, ESCROW_JOIN, 'join', [gameIdToBytes32(gameId), dep.stablecoin, stake]);
}
assert((await balanceOf(dep.escrow)) >= stake * 2n, 'pot locked in escrow');

// ---- the E3.3 path: arbiter signs + submits settle ----
const arbiter = new Arbiter(deployerPk, celoSepolia, dep.escrow);
const winnerBefore = await balanceOf(player2.address);

const t0 = Date.now();
const txHash = await arbiter.submitSettle(gameId, player2.address);
const elapsedMs = Date.now() - t0;

console.log(`[settle-verify] settled in tx ${txHash} (${elapsedMs} ms)`);
// pot 0.5, rake 9% = 0.045, payout = 0.455. Public RPC is load-balanced, so a
// read right after mining may hit a lagging node — poll until it reflects.
const payout = parseEther('0.455');
let winnerAfter = winnerBefore;
for (let i = 0; i < 15 && winnerAfter - winnerBefore !== payout; i++) {
  await sleep(1_000);
  winnerAfter = await balanceOf(player2.address);
}
assert(winnerAfter - winnerBefore === payout, 'winner paid pot - 9% rake (0.455 tUSD)');
console.log(
  elapsedMs < 5_000
    ? `[settle-verify] payout landed in ${elapsedMs} ms (< 5 s AC ✓)`
    : `[settle-verify] payout took ${elapsedMs} ms (testnet block/RPC latency; AC target 5 s)`,
);

console.log('SETTLE-VERIFY OK — arbiter settlement pays the winner on the live Celo Sepolia escrow.');
process.exit(0);
