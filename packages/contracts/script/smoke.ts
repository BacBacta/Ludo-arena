/**
 * Full-flow smoke test against a local node (npm run node -w packages/contracts):
 * deploy TestUSD + LudoEscrow, mint/approve, join x2, settle with the arbiter
 * signature, verify payout + rake; then the refundExpired path.
 * Mirrors test/LudoEscrow.t.sol so the flow stays verified while the Foundry
 * toolchain is not installed.
 */
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compileAll } from './compile.js';

// hardhat default accounts #0..#2 (local only)
const KEYS = {
  arbiter: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  alice: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  bob: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
} as const;

const chain = defineChain({
  id: 31_337,
  name: 'localhost',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
});

const transport = http('http://127.0.0.1:8545');
const publicClient = createPublicClient({ chain, transport });
const testClient = createTestClient({ chain, transport, mode: 'hardhat' });

const arbiter = privateKeyToAccount(KEYS.arbiter);
const alice = privateKeyToAccount(KEYS.alice);
const bob = privateKeyToAccount(KEYS.bob);
const wallet = (account: typeof arbiter) => createWalletClient({ account, chain, transport });

const { LudoEscrow, TestUSD } = compileAll();

function assert(cond: boolean, label: string): void {
  if (!cond) {
    console.error('FAIL:', label);
    process.exit(1);
  }
  console.log('  ✓', label);
}

async function deploy(abi: typeof LudoEscrow.abi, bytecode: Hex, args: unknown[]): Promise<Address> {
  const hash = await wallet(arbiter).deployContract({ abi, bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('deploy failed');
  return receipt.contractAddress;
}

async function call(
  account: typeof arbiter,
  address: Address,
  abi: typeof LudoEscrow.abi,
  functionName: string,
  args: unknown[],
): Promise<void> {
  const hash = await wallet(account).writeContract({ address, abi, functionName, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
}

const balanceOf = (token: Address, who: Address): Promise<bigint> =>
  publicClient.readContract({
    address: token,
    abi: TestUSD.abi,
    functionName: 'balanceOf',
    args: [who],
  }) as Promise<bigint>;

/** Matches LudoEscrow.settlementDigest: EIP-191 over keccak256(abi.encode(chainid, escrow, gameId, winner)). */
async function arbiterSignature(escrow: Address, gameId: Hex, winner: Address): Promise<Hex> {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'address' }],
      [BigInt(chain.id), escrow, gameId, winner],
    ),
  );
  return arbiter.signMessage({ message: { raw: inner } });
}

console.log('[smoke] deploying TestUSD + LudoEscrow (rake 9%)…');
const usd = await deploy(TestUSD.abi, TestUSD.bytecode, []);
const escrow = await deploy(LudoEscrow.abi, LudoEscrow.bytecode, [
  arbiter.address,
  arbiter.address, // treasury = arbiter for the smoke test
  900n,
]);

const stake = parseEther('1');
for (const player of [alice, bob]) {
  await call(player, usd, TestUSD.abi, 'mint', [player.address, parseEther('10')]);
  await call(player, usd, TestUSD.abi, 'approve', [escrow, stake * 10n]);
}

console.log('[smoke] join x2 + settle…');
const gameId = keccak256(new TextEncoder().encode('smoke-game-1'));
await call(alice, escrow, LudoEscrow.abi, 'join', [gameId, usd, stake]);
await call(bob, escrow, LudoEscrow.abi, 'join', [gameId, usd, stake]);
assert((await balanceOf(usd, escrow)) === stake * 2n, 'pot locked in escrow');

const treasuryBefore = await balanceOf(usd, arbiter.address);
const sig = await arbiterSignature(escrow, gameId, alice.address);
await call(bob, escrow, LudoEscrow.abi, 'settle', [gameId, alice.address, sig]);

assert(
  (await balanceOf(usd, alice.address)) === parseEther('10') - stake + parseEther('1.82'),
  'winner got pot - 9% rake (1.82 tUSD)',
);
assert(
  (await balanceOf(usd, arbiter.address)) - treasuryBefore === parseEther('0.18'),
  'treasury got the 0.18 tUSD rake',
);

console.log('[smoke] double settle must revert…');
let reverted = false;
try {
  await call(bob, escrow, LudoEscrow.abi, 'settle', [gameId, alice.address, sig]);
} catch {
  reverted = true;
}
assert(reverted, 'second settle reverted');

console.log('[smoke] refundExpired path…');
const gameId2 = keccak256(new TextEncoder().encode('smoke-game-2'));
await call(alice, escrow, LudoEscrow.abi, 'join', [gameId2, usd, stake]);
await testClient.increaseTime({ seconds: 121 });
await testClient.mine({ blocks: 1 });
const aliceBefore = await balanceOf(usd, alice.address);
await call(bob, escrow, LudoEscrow.abi, 'refundExpired', [gameId2]);
assert((await balanceOf(usd, alice.address)) - aliceBefore === stake, 'lonely player refunded');

console.log('SMOKE OK — join/settle/rake/refund verified against a local chain.');
process.exit(0);
