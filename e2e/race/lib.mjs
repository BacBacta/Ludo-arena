/**
 * Race Week simulation bench — the full real-money journey on a LOCAL stack:
 * hardhat chain + real contracts (MockUSDT, LudoEscrow, RacePass) + the real
 * server (CHAIN=localhost, staking + Race Week armed) + protocol bots.
 *
 * RaceBot extends the audit WireBot with everything a real Race Week player
 * does: SIWE wallet proof, gas seed, on-chain RacePass mint, claim, the
 * client-shaped stake lock (approve + join on the escrow), and rematch. Each
 * bot binds a DISTINCT loopback source address so the same-IP anti-collusion
 * gate (correct in prod) doesn't refuse the single-host bench.
 */
import { WireBot, sha256, sleep } from '../lib/common.mjs';
import { createPublicClient, createWalletClient, defineChain, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RPC = 'http://127.0.0.1:8545';
export const TOS_VERSION = '2026-07-01';

export const chain = defineChain({
  id: 31_337,
  name: 'localhost',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

export function deployments() {
  return JSON.parse(readFileSync(join(ROOT, 'packages', 'contracts', 'deployments.json'), 'utf8')).localhost;
}

// hardhat's deterministic dev accounts: #0 = deployer/arbiter/treasury, #1 = faucet.
export const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const FAUCET_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
// Race HOUSE BOT wallet — hardhat account #3 (0x90F7…b906), DISTINCT from the
// deployer/arbiter/treasury (#0) and faucet (#1) so balance-delta assertions
// never alias. The server signs the bot's 1c stake from this key.
export const HOUSE_BOT_PK = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
export const HOUSE_BOT_ADDR = privateKeyToAccount(HOUSE_BOT_PK).address;

const ERC20_ABI = [
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];
const ESCROW_ABI = [
  { type: 'function', name: 'join', stateMutability: 'nonpayable', inputs: [{ name: 'gameId', type: 'bytes32' }, { name: 'token', type: 'address' }, { name: 'stake', type: 'uint96' }, { name: 'fairnessCommit', type: 'bytes32' }], outputs: [] },
];
const RACEPASS_ABI = [
  { type: 'function', name: 'setMintOpen', stateMutability: 'nonpayable', inputs: [{ name: 'open', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [], outputs: [{ type: 'uint256' }] },
];

export const publicClient = createPublicClient({ chain, transport: http(RPC) });
export const walletFor = (pk) => createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(RPC) });

let DECIMALS = null;
export async function tokenDecimals(dep = deployments()) {
  if (DECIMALS === null) DECIMALS = await publicClient.readContract({ address: dep.stablecoin, abi: ERC20_ABI, functionName: 'decimals' });
  return DECIMALS;
}
export async function centsToUnits(cents) {
  return (BigInt(cents) * 10n ** BigInt(await tokenDecimals())) / 100n;
}
export async function balanceCents(addr) {
  const [bal, d] = [await publicClient.readContract({ address: deployments().stablecoin, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] }), await tokenDecimals()];
  return Number((bal * 100n) / 10n ** BigInt(d));
}
/** Exact token units — the money-conservation assertions work at this
 *  granularity (integer cents would hide sub-cent rake/dust discrepancies,
 *  which is exactly how the 9%-rake-on-the-race-tier bug stayed invisible). */
export function balanceUnits(addr) {
  return publicClient.readContract({ address: deployments().stablecoin, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] });
}

/** Chain bootstrap after deploy: open the Pass mint, fund the faucet wallet, and
 *  (for the house-bot sim) fund the house-bot wallet with cUSD + native gas. The
 *  house bot is funded from the DEPLOYER mint, NOT the RACE_FAUCET wallet — its
 *  stakes must never draw the player-subsidy faucet. */
export async function armChain({ faucetUsdCents = 3000, houseBotUsdCents = 200 } = {}) {
  const dep = deployments();
  const deployer = walletFor(DEPLOYER_PK);
  const faucetAddr = privateKeyToAccount(FAUCET_PK).address;
  await deployer.writeContract({ address: dep.racePass, abi: RACEPASS_ABI, functionName: 'setMintOpen', args: [true] });
  await deployer.writeContract({ address: dep.stablecoin, abi: ERC20_ABI, functionName: 'mint', args: [faucetAddr, await centsToUnits(faucetUsdCents)] });
  // House-bot wallet: cUSD for many 1c stakes + native ETH for gas (FEE_IN_STABLE
  // is unset on hardhat, so gas is paid in ETH, not cUSD — forgetting this makes
  // the bot's approve/join silently fail and the match aborts on stake-lock).
  await deployer.writeContract({ address: dep.stablecoin, abi: ERC20_ABI, functionName: 'mint', args: [HOUSE_BOT_ADDR, await centsToUnits(houseBotUsdCents)] });
  await publicClient.request({ method: 'hardhat_setBalance', params: [HOUSE_BOT_ADDR, `0x${parseEther('1').toString(16)}`] });
  return { dep, faucetAddr, houseBotAddr: HOUSE_BOT_ADDR };
}

export const walletProofMessage = (nonce) => `Ludo Arena — verify wallet ownership.\nNonce: ${nonce}`;

let nextLoopback = 2;

/** A full Race Week player: burner wallet + protocol bot on a distinct source IP. */
export class RaceBot extends WireBot {
  constructor(name, opts = {}) {
    const ip = opts.ip ?? `127.0.0.${nextLoopback++}`;
    super(name, { ...opts, wsOpts: { localAddress: ip } });
    this.ip = ip;
    this.pk = opts.pk ?? generatePrivateKey();
    this.account = privateKeyToAccount(this.pk);
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(RPC) });
    this.fingerprint = opts.fingerprint ?? randomBytes(16).toString('hex');
    this.mintTx = null;
  }

  /** Gas for the burner (localhost stand-in for Celo's pay-gas-in-cUSD). */
  async fuel(eth = '1') {
    await publicClient.request({ method: 'hardhat_setBalance', params: [this.account.address, `0x${parseEther(eth).toString(16)}`] });
  }

  /** hello with wallet + consent + fingerprint, then SIWE-prove if asked. */
  async open(extra = {}) {
    await this.connect({ wallet: this.account.address, consent: { tosVersion: TOS_VERSION, age18: true }, fingerprint: this.fingerprint, ...extra });
    if (this.hello.walletNonce) {
      const signature = await this.account.signMessage({ message: walletProofMessage(this.hello.walletNonce) });
      const mark = this.mark();
      this.send({ t: 'wallet.prove', signature });
      await this.awaitFrom(mark, (m) => m.t === 'friends.update' || (m.t === 'error' && /wallet/i.test(m.message ?? '')), 8000, 'prove ack').catch(() => null);
    }
    return this;
  }

  /** Ask the gas seed; resolves the race.seeded (or error) reply. */
  async seed() {
    const mark = this.mark();
    this.send({ t: 'race.seed' });
    return this.awaitFrom(mark, (m) => m.t === 'race.seeded' || m.t === 'error', 20000, 'race.seeded');
  }

  /** Mint the RacePass on-chain (burner signs; gas from fuel()). */
  async mintPass() {
    this.mintTx = await this.wallet.writeContract({ address: deployments().racePass, abi: RACEPASS_ABI, functionName: 'mint' });
    await publicClient.waitForTransactionReceipt({ hash: this.mintTx });
    return this.mintTx;
  }

  /** Claim the event grant with the mint tx proof. */
  async claim() {
    const mark = this.mark();
    this.send({ t: 'race.claim', passTxHash: this.mintTx });
    return this.awaitFrom(mark, (m) => m.t === 'race.claimed' || m.t === 'error', 20000, 'race.claimed');
  }

  /** The client-shaped stake lock: approve + join on the escrow, exactly the
   *  tuple apps/web/src/lib/escrow.ts sends (gameId left-padded to bytes32). */
  async lockStake({ gameId, stakeCents, fairnessCommit } = this.match) {
    const dep = deployments();
    const units = await centsToUnits(stakeCents ?? this.match.stakeCents);
    const gameId32 = `0x${(gameId ?? this.match.gameId).padStart(64, '0')}`;
    const commit32 = `0x${(fairnessCommit ?? this.match.fairnessCommit)}`;
    const a = await this.wallet.writeContract({ address: dep.stablecoin, abi: ERC20_ABI, functionName: 'approve', args: [dep.escrow, units] });
    await publicClient.waitForTransactionReceipt({ hash: a });
    const j = await this.wallet.writeContract({ address: dep.escrow, abi: ESCROW_ABI, functionName: 'join', args: [gameId32, dep.stablecoin, units, commit32] });
    await publicClient.waitForTransactionReceipt({ hash: j });
    return j;
  }

  /** Fresh entropy for a REMATCH (a new game must re-commit, never reuse). */
  rearmEntropy() {
    this.entropy = randomBytes(32).toString('hex');
    return sha256(this.entropy);
  }

  /** Ask for a rematch (fresh commit) — server pairs when both have asked. */
  requestRematch() {
    this.match = null;
    this.over = null;
    this.state = null;
    this.send({ t: 'game.rematch', entropyCommit: this.rearmEntropy() });
  }

  onchainBalanceCents() {
    return balanceCents(this.account.address);
  }
}

/** Drive one staked game start-to-finish for an already-matched pair.
 *  MARKS everywhere: a whole-history wait once matched game 1's stale
 *  game.state/over during game 2 — the bots then "finished" instantly while
 *  the real game ran on with two absent players (auto-play to forfeit), and
 *  every downstream assertion read the wrong world. */
export async function playStakedGame(a, b, { maxMs = 300_000 } = {}) {
  const ma = a.mark();
  const mb = b.mark();
  a.over = null;
  b.over = null;
  const t0 = Date.now();
  await Promise.all([a.lockStake(), b.lockStake()]);
  const tLocked = Date.now();
  await Promise.all([
    a.awaitFrom(ma, (m) => m.t === 'game.state', 150_000, 'game.state (locks verified)'),
    b.awaitFrom(mb, (m) => m.t === 'game.state', 150_000, 'game.state (locks verified)'),
  ]);
  // Match-start latency telemetry: how long paired players stare at the
  // "locking your stake" screen. locks = approve(+receipt)+join(+receipt);
  // start = server lock-poll detection + depositor check + broadcast.
  console.log(`  · stake locks ${tLocked - t0}ms · locks→game.state ${Date.now() - tLocked}ms`);
  const [overA, overB] = await Promise.all([
    a.playUntilOver({ maxMs }),
    b.playUntilOver({ maxMs }),
  ]);
  return { overA, overB };
}

/** Drive one staked game where the opponent is the SERVER-SIDE house bot: ONLY
 *  the human locks (approve+join); the server locks the bot's 1c from the house
 *  wallet and drives its seat. Waits for game.state (which proves BOTH the human
 *  lock AND the server-side bot lock landed and the escrow went Active), then
 *  plays the human to game.over. Returns the human's over payload. */
export async function playStakedVsHouse(human, { maxMs = 300_000 } = {}) {
  const m = human.mark();
  human.over = null;
  await human.lockStake();
  await human.awaitFrom(m, (x) => x.t === 'game.state', 150_000, 'game.state (human lock + server bot lock verified)');
  return human.playUntilOver({ maxMs });
}

export { sleep, sha256 };
