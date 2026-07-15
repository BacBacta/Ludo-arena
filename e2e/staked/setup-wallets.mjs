// Fund two throwaway test wallets on celo-sepolia: gas from the deployer key
// (read from packages/contracts/.env, NEVER printed) + open-faucet TestUSD mint.
// Writes the two TEST private keys to the scratchpad only (never the repo).
import { createWalletClient, createPublicClient, http, parseEther, formatEther, formatUnits } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { celoAlfajores } from 'viem/chains';
import { readFileSync, writeFileSync } from 'node:fs';
import * as chains from 'viem/chains';

const env = Object.fromEntries(
  readFileSync('/workspaces/Ludo-arena/packages/contracts/.env', 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const RPC = env.CELO_SEPOLIA_RPC || 'https://forno.celo-sepolia.celo-testnet.org';
const chain = chains.celoSepolia ?? { ...celoAlfajores, id: 11142220, name: 'celo-sepolia' };
const pub = createPublicClient({ chain, transport: http(RPC) });

const deployer = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY.startsWith('0x') ? env.DEPLOYER_PRIVATE_KEY : `0x${env.DEPLOYER_PRIVATE_KEY}`);
console.log(`deployer address: ${deployer.address} (arbiter/treasury on-chain: 0x947Fa33C5A2157Bc3618Cc7B66a32A3A4b14951B)`);
console.log(`deployer gas: ${formatEther(await pub.getBalance({ address: deployer.address }))} CELO`);

const dep = JSON.parse(readFileSync('/workspaces/Ludo-arena/apps/web/src/deployments.json', 'utf8'))['celo-sepolia'];
const TOKEN = dep.stablecoin;
const MINT_ABI = [{ type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }];
const BAL_ABI = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];

const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });
const players = [generatePrivateKey(), generatePrivateKey()].map((pk) => ({ pk, account: privateKeyToAccount(pk) }));

for (const [i, p] of players.entries()) {
  const gasTx = await wallet.sendTransaction({ to: p.account.address, value: parseEther('0.008') });
  await pub.waitForTransactionReceipt({ hash: gasTx });
  const mintTx = await wallet.writeContract({ address: TOKEN, abi: MINT_ABI, functionName: 'mint', args: [p.account.address, 10_000_000n] }); // 10 TestUSD (6 dec)
  await pub.waitForTransactionReceipt({ hash: mintTx });
  const gas = formatEther(await pub.getBalance({ address: p.account.address }));
  const usd = formatUnits(await pub.readContract({ address: TOKEN, abi: BAL_ABI, functionName: 'balanceOf', args: [p.account.address] }), 6);
  console.log(`player${i}: ${p.account.address} — ${gas} CELO gas, ${usd} TestUSD`);
}
writeFileSync('/tmp/claude-1000/-workspaces-Ludo-arena/00d95733-8211-42be-a067-2b4e08916f8a/scratchpad/test-wallets.json',
  JSON.stringify({ players: players.map((p) => ({ pk: p.pk, address: p.account.address })) }));
console.log('test keys written to scratchpad (outside the repo)');
