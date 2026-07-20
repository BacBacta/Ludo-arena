/**
 * Deploys LudoEscrow (and TestUSD when no stablecoin is configured) and
 * records the addresses in deployments.json (BACKLOG E3.1).
 *
 * Usage:
 *   NETWORK=localhost npm run deploy -w packages/contracts
 *   NETWORK=sepolia DEPLOYER_PRIVATE_KEY=0x… npm run deploy -w packages/contracts
 *
 * Env (see .env.example): DEPLOYER_PRIVATE_KEY, ARBITER_ADDRESS,
 * TREASURY_ADDRESS, RAKE_BPS (default 900), STABLECOIN (skip TestUSD).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  toBytes,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compileAll } from './compile.js';
import { PREMIUM_COSMETICS, SEASON_PREMIUM } from '../../shared/src/protocol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  // no .env file: rely on the ambient environment
}

/** .env template lines like `ARBITER_ADDRESS=` yield '' — treat empty as unset. */
function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== '' ? v : undefined;
}

// Hardhat/anvil default account #0 — local development only.
const LOCAL_DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

interface NetworkPreset {
  chain: Chain;
  rpcEnv: string;
  defaultRpc: string;
  /** Real stablecoin when the chain has one; otherwise TestUSD is deployed. */
  stablecoin?: Address;
}

const NETWORKS: Record<string, NetworkPreset> = {
  localhost: {
    chain: defineChain({
      id: 31_337,
      name: 'localhost',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
    }),
    rpcEnv: 'LOCAL_RPC',
    defaultRpc: 'http://127.0.0.1:8545',
  },
  sepolia: {
    chain: defineChain({
      id: 11_155_111,
      name: 'Ethereum Sepolia',
      nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://ethereum-sepolia-rpc.publicnode.com'] } },
      blockExplorers: { default: { name: 'Etherscan', url: 'https://sepolia.etherscan.io' } },
    }),
    rpcEnv: 'SEPOLIA_RPC',
    defaultRpc: 'https://ethereum-sepolia-rpc.publicnode.com',
  },
  'celo-sepolia': {
    chain: defineChain({
      id: 11_142_220,
      name: 'Celo Sepolia',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: { default: { http: ['https://forno.celo-sepolia.celo-testnet.org'] } },
      blockExplorers: { default: { name: 'Blockscout', url: 'https://celo-sepolia.blockscout.com' } },
    }),
    rpcEnv: 'CELO_SEPOLIA_RPC',
    defaultRpc: 'https://forno.celo-sepolia.celo-testnet.org',
  },
  alfajores: {
    chain: defineChain({
      id: 44_787,
      name: 'Celo Alfajores',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: { default: { http: ['https://alfajores-forno.celo-testnet.org'] } },
      blockExplorers: { default: { name: 'Celoscan', url: 'https://alfajores.celoscan.io' } },
    }),
    rpcEnv: 'ALFAJORES_RPC',
    defaultRpc: 'https://alfajores-forno.celo-testnet.org',
    stablecoin: '0x874069Fa1Eb16D44d622F2e0Ca25eeA172369bC1', // cUSD
  },
  // Celo MAINNET (real money). `stablecoin` is pinned to the canonical cUSD so a
  // mainnet deploy NEVER falls back to deploying a MockUSDT — it settles in real
  // cUSD. Deploying here needs a funded DEPLOYER_PRIVATE_KEY (CELO for gas) and,
  // for staked play, the real-money launch gates in docs/DEPLOY.md (R-COMP-2).
  celo: {
    chain: defineChain({
      id: 42_220,
      name: 'Celo',
      nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: { default: { http: ['https://forno.celo.org'] } },
      blockExplorers: { default: { name: 'Celoscan', url: 'https://celoscan.io' } },
    }),
    rpcEnv: 'CELO_RPC',
    defaultRpc: 'https://forno.celo.org',
    stablecoin: '0x765DE816845861e75A25fCA122bb6898B8B1282a', // cUSD (18 decimals)
  },
};

const networkName = env('NETWORK') ?? 'localhost';
const preset = NETWORKS[networkName];
if (!preset) {
  console.error(`Unknown NETWORK '${networkName}'. Options: ${Object.keys(NETWORKS).join(', ')}`);
  process.exit(1);
}

const rawPk = env('DEPLOYER_PRIVATE_KEY') ?? (networkName === 'localhost' ? LOCAL_DEV_KEY : '');
if (!rawPk) {
  console.error('DEPLOYER_PRIVATE_KEY is required for public networks (fund it on a faucet first).');
  process.exit(1);
}
const pk = (rawPk.startsWith('0x') ? rawPk : `0x${rawPk}`) as Hex;

const account = privateKeyToAccount(pk);
const rpc = env(preset.rpcEnv) ?? preset.defaultRpc;
const publicClient = createPublicClient({ chain: preset.chain, transport: http(rpc) });
const walletClient = createWalletClient({ account, chain: preset.chain, transport: http(rpc) });

const arbiter = (env('ARBITER_ADDRESS') ?? account.address) as Address;
const treasury = (env('TREASURY_ADDRESS') ?? account.address) as Address;
const rakeBps = BigInt(env('RAKE_BPS') ?? '900');

console.log(`[deploy] network=${networkName} chainId=${preset.chain.id} rpc=${rpc}`);
console.log(`[deploy] deployer=${account.address} arbiter=${arbiter} treasury=${treasury} rakeBps=${rakeBps}`);

const { LudoEscrow, LudoEscrowN, CosmeticsStore, MockUSDT, RacePass } = compileAll();

async function deployContract(label: string, abi: Abi, bytecode: Hex, args: unknown[]): Promise<{ address: Address; txHash: Hex }> {
  const txHash = await walletClient.deployContract({ abi, bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`${label}: deployment failed (tx ${txHash})`);
  }
  console.log(`[deploy] ${label} → ${receipt.contractAddress} (tx ${txHash})`);
  return { address: receipt.contractAddress, txHash };
}

let stablecoin = (env('STABLECOIN') ?? preset.stablecoin) as Address | undefined;
let stablecoinTx: Hex | undefined;
if (!stablecoin) {
  // Testnet faucet token: a 6-decimal MockUSDT so the flow exercises real USDT
  // decimals (not TestUSD's 18). Override with STABLECOIN for a real token.
  const deployed = await deployContract('MockUSDT', MockUSDT.abi, MockUSDT.bytecode, []);
  stablecoin = deployed.address;
  stablecoinTx = deployed.txHash;
}

// Read the stablecoin's own decimals so cosmetic prices (below) are correct for
// any token — 6 for USDT, 18 for cUSD/TestUSD. Never assume.
const ERC20_DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;
const stablecoinDecimals = Number(
  await publicClient.readContract({ address: stablecoin, abi: ERC20_DECIMALS_ABI, functionName: 'decimals' }),
);

const escrow = await deployContract('LudoEscrow', LudoEscrow.abi, LudoEscrow.bytecode, [
  arbiter,
  treasury,
  rakeBps,
]);

// N-player escrow (LudoEscrowN) for staked 4-player games — same arbiter/treasury/rake.
const escrowN = await deployContract('LudoEscrowN', LudoEscrowN.abi, LudoEscrowN.bytecode, [
  arbiter,
  treasury,
  rakeBps,
]);

// Allowlist the stablecoin on BOTH escrows so staked games can actually be joined.
// The hardened escrows reject any non-allowlisted token (keeps fee-on-transfer /
// exotic ERC20 griefers out) — WITHOUT this, every join() reverts TokenNotAllowed.
// setTokenAllowed is onlyOwner (owner defaults to treasury). If the deployer is not
// the owner we cannot send it here — warn loudly with the exact call the owner must make.
{
  const owner = (await publicClient.readContract({
    address: escrow.address,
    abi: LudoEscrow.abi,
    functionName: 'owner',
  })) as Address;
  if (owner.toLowerCase() === account.address.toLowerCase()) {
    for (const [name, addr, abi] of [
      ['LudoEscrow', escrow.address, LudoEscrow.abi],
      ['LudoEscrowN', escrowN.address, LudoEscrowN.abi],
    ] as const) {
      const tx = await walletClient.writeContract({
        account,
        chain: preset.chain,
        address: addr,
        abi,
        functionName: 'setTokenAllowed',
        args: [stablecoin as Address, true],
      });
      await publicClient.waitForTransactionReceipt({ hash: tx });
      console.log(`[deploy] ${name}: allowlisted stablecoin ${stablecoin} (tx ${tx})`);
    }
  } else {
    console.warn(
      `[deploy] ⚠ escrow owner (${owner}) != deployer (${account.address}); the owner MUST call ` +
        `setTokenAllowed(${stablecoin}, true) on both ${escrow.address} and ${escrowN.address} ` +
        `before any staked game can be joined.`,
    );
  }
}

// Degressive per-tier rake (mirrors shared RAKE_BPS_BY_STAKE — keep in step):
// the 25¢ acquisition tier carries the fixed settlement-gas overhead, the $5
// retention tier is priced to keep high-stake players. Stake amounts are the
// cash tiers converted at the stablecoin's OWN decimals. onlyOwner — skipped
// with a loud warning when the deployer isn't the owner (same as setTokenAllowed).
{
  const TIER_RAKES: Array<{ cents: number; bps: number }> = [
    { cents: 25, bps: 1000 },
    { cents: 100, bps: 800 },
    { cents: 500, bps: 600 },
  ];
  const stakeUnit = 10n ** BigInt(stablecoinDecimals - 2); // cents → base units
  const owner = (await publicClient.readContract({
    address: escrow.address,
    abi: LudoEscrow.abi,
    functionName: 'owner',
  })) as Address;
  if (owner.toLowerCase() === account.address.toLowerCase()) {
    for (const [name, addr, abi] of [
      ['LudoEscrow', escrow.address, LudoEscrow.abi],
      ['LudoEscrowN', escrowN.address, LudoEscrowN.abi],
    ] as const) {
      for (const { cents, bps } of TIER_RAKES) {
        const tx = await walletClient.writeContract({
          account,
          chain: preset.chain,
          address: addr,
          abi,
          functionName: 'setTierRakeBps',
          args: [stablecoin as Address, BigInt(cents) * stakeUnit, bps],
        });
        await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log(`[deploy] ${name}: tier rake ${cents}¢ → ${bps} bps (tx ${tx})`);
      }
    }
  } else {
    console.warn(
      `[deploy] ⚠ escrow owner (${owner}) != deployer; the owner must call setTierRakeBps ` +
        `for the ${TIER_RAKES.map((t) => `${t.cents}¢→${t.bps}bps`).join(', ')} tiers on both escrows, ` +
        `or every game settles at the flat global rake.`,
    );
  }
}

// Cosmetics store (rec 6): cUSD purchases of dice skins / board themes paid to the
// treasury — non-rake revenue. Same stablecoin; owner (catalogue/prices) = deployer.
const cosmetics = await deployContract('CosmeticsStore', CosmeticsStore.abi, CosmeticsStore.bytecode, [
  treasury,
  stablecoin,
]);

// Seed the FULL cosmetics catalogue straight from shared (type-only deps, safe
// under tsx) so the store is purchasable the moment it's deployed and listings
// can never drift from the client display. A hardcoded 2-item seed here once
// left everything after 'aurora' unlisted (fixed by script/listCosmetics.ts,
// which is also the way to sync an ALREADY-deployed store after catalogue
// additions). itemId = keccak256(bytes(id)); price = cents → base units at the
// stablecoin's OWN decimals (read above).
const COSMETIC_SEED: Array<{ id: string; cents: number }> = [
  ...PREMIUM_COSMETICS.filter((c) => c.cents > 0).map((c) => ({ id: c.id, cents: c.cents })),
  { id: SEASON_PREMIUM.itemId, cents: SEASON_PREMIUM.cents },
];
const priceUnit = 10n ** BigInt(stablecoinDecimals - 2); // cents → base units
const STORE_SEED_ABI = [
  { type: 'function', name: 'setPrices', stateMutability: 'nonpayable', inputs: [{ name: 'itemIds', type: 'bytes32[]' }, { name: 'prices', type: 'uint256[]' }], outputs: [] },
] as const;
const seedTx = await walletClient.writeContract({
  account,
  chain: preset.chain,
  address: cosmetics.address,
  abi: STORE_SEED_ABI,
  functionName: 'setPrices',
  args: [
    COSMETIC_SEED.map((c) => keccak256(toBytes(c.id))),
    COSMETIC_SEED.map((c) => BigInt(c.cents) * priceUnit),
  ],
});
await publicClient.waitForTransactionReceipt({ hash: seedTx });
console.log(`[deploy] cosmetics catalogue seeded (${COSMETIC_SEED.length} items, tx ${seedTx})`);

// read back the immutables: fail loudly if the chain state disagrees.
// Retried: load-balanced public RPCs may serve the read from a node that
// has not seen the deployment block yet.
async function readBack(functionName: string): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await publicClient.readContract({ address: escrow.address, abi: LudoEscrow.abi, functionName });
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  throw lastError;
}
const [onArbiter, onTreasury, onRake] = [
  await readBack('arbiter'),
  await readBack('treasury'),
  await readBack('rakeBps'),
];
if (
  String(onArbiter).toLowerCase() !== arbiter.toLowerCase() ||
  String(onTreasury).toLowerCase() !== treasury.toLowerCase() ||
  BigInt(onRake as bigint) !== rakeBps
) {
  throw new Error('post-deploy verification failed: on-chain config does not match');
}
console.log('[deploy] on-chain config verified (arbiter, treasury, rakeBps)');

// Race Pass (Race Week): free soulbound entry NFT. Deployed with the mint
// window CLOSED — the owner (deployer) arms it for the event with a
// setMintOpen(true) call (cast/etherscan; ops script lands with the event).
// RACE_PASS_URI = the shared metadata JSON for the pass artwork.
const racePass = await deployContract('RacePass', RacePass.abi, RacePass.bytecode, [
  env('RACE_PASS_URI') ?? 'https://www.ludoarena.xyz/race-pass.json',
]);

// merge into deployments.json keyed by network name
const deploymentsPath = join(ROOT, 'deployments.json');
const deployments: Record<string, unknown> = existsSync(deploymentsPath)
  ? (JSON.parse(readFileSync(deploymentsPath, 'utf8')) as Record<string, unknown>)
  : {};
deployments[networkName] = {
  chainId: preset.chain.id,
  escrow: escrow.address,
  escrowTx: escrow.txHash,
  escrowN: escrowN.address,
  escrowNTx: escrowN.txHash,
  cosmeticsStore: cosmetics.address,
  cosmeticsStoreTx: cosmetics.txHash,
  racePass: racePass.address,
  racePassTx: racePass.txHash,
  stablecoin,
  stablecoinDecimals,
  ...(stablecoinTx ? { stablecoinIsTestUSD: true, stablecoinTx } : {}),
  arbiter,
  treasury,
  rakeBps: Number(rakeBps),
  deployedAt: new Date().toISOString(),
};
const serialized = JSON.stringify(deployments, null, 2) + '\n';
writeFileSync(deploymentsPath, serialized);
// Keep the web's vendored copy in sync (it imports this, decoupled from the
// contracts workspace so the Vercel build stays lean).
const webCopy = join(ROOT, '..', '..', 'apps', 'web', 'src', 'deployments.json');
if (existsSync(join(ROOT, '..', '..', 'apps', 'web', 'src'))) writeFileSync(webCopy, serialized);
console.log(`[deploy] addresses saved to deployments.json + apps/web/src ('${networkName}')`);
