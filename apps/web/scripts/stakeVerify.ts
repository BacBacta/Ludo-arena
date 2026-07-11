/**
 * E3.2 acceptance: exercise the web's stakeInEscrow() against the LIVE
 * LudoEscrow on Celo Sepolia — proving the client calldata (bytes32 gameId,
 * token, uint96 stake, approve) is accepted on-chain by the real deployment.
 * Uses the funded deployer key (packages/contracts/.env); pays gas in native
 * CELO (the MiniPay feeCurrency path is unavailable headlessly).
 *
 * Run: npm run stake-verify -w apps/web
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celoSepolia } from '../src/lib/chains.ts';
import { ESCROW_ABI, gameIdToBytes32, stakeInEscrow } from '../src/lib/escrow.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONTRACTS = join(ROOT, 'packages', 'contracts');
try {
  process.loadEnvFile(join(CONTRACTS, '.env'));
} catch {
  /* rely on ambient env */
}

const raw = process.env.DEPLOYER_PRIVATE_KEY;
if (!raw) throw new Error('DEPLOYER_PRIVATE_KEY missing (packages/contracts/.env)');
const account = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex);

const deployments = JSON.parse(readFileSync(join(CONTRACTS, 'deployments.json'), 'utf8')) as Record<
  string,
  { chainId: number; escrow: Address; stablecoin: Address }
>;
const dep = deployments['celo-sepolia'];
if (!dep) throw new Error('celo-sepolia deployment missing — run npm run deploy first');

const transport = http();
const publicClient = createPublicClient({ chain: celoSepolia, transport }) as unknown as PublicClient;
const walletClient = createWalletClient({ account, chain: celoSepolia, transport }) as unknown as WalletClient;

const MINT_ABI = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
] as const;

function assert(cond: boolean, label: string): void {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
  console.log('  ✓', label);
}

const stakeCents = 25;
// unique per run so the game slot is fresh (16 random bytes → 32 hex chars)
const bytes = new Uint8Array(16);
crypto.getRandomValues(bytes);
const gameId = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const gameId32 = gameIdToBytes32(gameId);

console.log(`[stake-verify] chain=celo-sepolia escrow=${dep.escrow} player=${account.address}`);
console.log(`[stake-verify] gameId=${gameId} → ${gameId32}`);

// open-faucet TestUSD: mint enough to cover the stake
const mintHash = await walletClient.writeContract({
  account, chain: celoSepolia, address: dep.stablecoin, abi: MINT_ABI, functionName: 'mint', args: [account.address, parseEther('1')],
});
await publicClient.waitForTransactionReceipt({ hash: mintHash });
console.log('[stake-verify] minted 1 tUSD');

const receipt = await stakeInEscrow({
  walletClient,
  publicClient,
  account: account.address,
  escrow: dep.escrow,
  token: dep.stablecoin,
  gameId,
  stakeCents,
  onStatus: (s) => console.log('  status:', s),
});
console.log(`[stake-verify] joined (approveTx=${receipt.approveTx ?? 'n/a'} joinTx=${receipt.joinTx})`);

const game = await publicClient.readContract({ address: dep.escrow, abi: ESCROW_ABI, functionName: 'games', args: [gameId32] });
const [token, stake, playerA, , , status] = game;
assert(token.toLowerCase() === dep.stablecoin.toLowerCase(), 'game token = stake token');
assert(stake === receipt.stake, 'game stake = 0.25 tUSD in base units');
assert(playerA.toLowerCase() === account.address.toLowerCase(), 'playerA = staker');
assert(status === 1, 'game status = WaitingOpponent');

console.log('STAKE-VERIFY OK — web stakeInEscrow() accepted by the live Celo Sepolia escrow.');
process.exit(0);
