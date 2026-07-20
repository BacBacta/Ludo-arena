/** Prints the deployer address and its balance on the configured NETWORK (.env). */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, formatEther, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  // rely on the ambient environment
}

const RPCS: Record<string, { id: number; rpc: string }> = {
  localhost: { id: 31_337, rpc: 'http://127.0.0.1:8545' },
  sepolia: { id: 11_155_111, rpc: process.env.SEPOLIA_RPC || 'https://ethereum-sepolia-rpc.publicnode.com' },
  'celo-sepolia': { id: 11_142_220, rpc: process.env.CELO_SEPOLIA_RPC || 'https://forno.celo-sepolia.celo-testnet.org' },
  alfajores: { id: 44_787, rpc: process.env.ALFAJORES_RPC || 'https://alfajores-forno.celo-testnet.org' },
  celo: { id: 42_220, rpc: process.env.CELO_RPC || 'https://forno.celo.org' }, // mainnet (real money)
};

const network = process.env.NETWORK ?? 'celo-sepolia';
const net = RPCS[network];
if (!net) throw new Error(`unknown NETWORK '${network}'`);
const raw = process.env.DEPLOYER_PRIVATE_KEY;
if (!raw) throw new Error('DEPLOYER_PRIVATE_KEY missing in .env');
const pk = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex;
const account = privateKeyToAccount(pk);

const chain = defineChain({
  id: net.id,
  name: network,
  nativeCurrency: { name: 'native', symbol: 'NATIVE', decimals: 18 },
  rpcUrls: { default: { http: [net.rpc] } },
});
const client = createPublicClient({ chain, transport: http(net.rpc) });
const [balance, chainId] = await Promise.all([
  client.getBalance({ address: account.address }),
  client.getChainId(),
]);
console.log(`network:  ${network} (chainId ${chainId})`);
console.log(`deployer: ${account.address}`);
console.log(`balance:  ${formatEther(balance)}`);
