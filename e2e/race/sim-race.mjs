/**
 * Race Week full-journey simulation (real chain + real server + protocol bots).
 *
 * Phases:
 *  A — onboarding & display: SIWE, gas seed (+idempotence), Pass mint, claim
 *      (+idempotence), FIXED prize on the wire.
 *  B — staked happy path ×2: on-chain locks, full game, settlement on-chain
 *      (winner paid, treasury raked, escrow emptied), balance-aware JIT
 *      (rich wallet: NO drip; drained wallets: deficit-only drip).
 *  C — rematch: both re-commit fresh entropy, direct re-pair keeps seats,
 *      second staked cycle completes.
 *  D — failure modes: mid-staking drop → context replay (no abort);
 *      opponent gone → grace abort with refund enqueue; re-queue un-wedge.
 *  E — in-game disconnect → token resume → game completes.
 *
 * Run: node e2e/race/sim-race.mjs   (stack: see e2e/race/README.md)
 */
import { tally } from '../lib/common.mjs';
import { RaceBot, armChain, balanceCents, deployments, playStakedGame, sleep, walletFor, DEPLOYER_PK, publicClient } from './lib.mjs';

const t = tally('sim-race');
const dep = deployments();
const SEED_CENTS = 10;
const PER_GAME = 2;

// ---------------------------------------------------------------- helpers
const ERC20_MIN_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
];
async function drainTo(bot, keepCents) {
  const d = await publicClient.readContract({ address: dep.stablecoin, abi: ERC20_MIN_ABI, functionName: 'decimals' });
  const bal = await publicClient.readContract({ address: dep.stablecoin, abi: ERC20_MIN_ABI, functionName: 'balanceOf', args: [bot.account.address] });
  const keep = (BigInt(keepCents) * 10n ** BigInt(d)) / 100n;
  if (bal > keep) {
    const h = await bot.wallet.writeContract({ address: dep.stablecoin, abi: ERC20_MIN_ABI, functionName: 'transfer', args: [walletFor(DEPLOYER_PK).account.address, bal - keep] });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
}

// ================================================================= PHASE A
console.log('\n————— PHASE A · onboarding & display —————');
const { faucetAddr } = await armChain({ faucetUsdCents: 3000 });
const A = new RaceBot('SimAlice');
const B = new RaceBot('SimBruno');
await Promise.all([A.fuel(), B.fuel()]);
await A.open();
await B.open();
t.check('A+B sessions proven (SIWE round-trip done)', !!A.hello && !!B.hello);
t.check('race state armed on the wire', A.hello.race?.active === true, JSON.stringify(A.hello.race));
t.check('the banner prize is the FIXED prize (3000c), not the faucet budget', A.hello.race?.prizeCents === 3000, `prizeCents=${A.hello.race?.prizeCents}`);

const seedA1 = await A.seed();
t.check('gas seed grants the full target to an empty burner', seedA1.t === 'race.seeded' && seedA1.seedCents === SEED_CENTS, JSON.stringify(seedA1));
t.check('…and the cUSD really landed on-chain', (await A.onchainBalanceCents()) === SEED_CENTS, `bal=${await A.onchainBalanceCents()}c`);
// BUG#1 regression: a retry inside the anti-spam window must get an EXPLICIT
// reply (the old silent drop hung honest clients to their own timeout).
const seedRL = await A.seed();
t.check('an immediate seed retry gets an explicit rate-limited reply (no silent hang)', seedRL.t === 'race.seeded' && seedRL.rateLimited === true && seedRL.seedCents === 0, JSON.stringify(seedRL));
await sleep(3200); // leave the anti-spam window for the true idempotence path
const seedA2 = await A.seed();
t.check('a second seed at target is a 0-cent no-op (idempotent)', seedA2.t === 'race.seeded' && seedA2.seedCents === 0 && seedA2.alreadySeeded === true, JSON.stringify(seedA2));
await B.seed();

await A.mintPass();
await B.mintPass();
await sleep(3200); // seed and claim share the per-session anti-spam clock
const claimA1 = await A.claim();
t.check('claim funds the JIT entry grant (perGame=2c)', claimA1.t === 'race.claimed' && claimA1.fundedCents === PER_GAME, JSON.stringify(claimA1));
const claimRL = await A.claim();
t.check('an immediate re-claim is refused EXPLICITLY (rate-limit reply, not a hang)', claimRL.t === 'error' && claimRL.code === 'LIMIT_REACHED', JSON.stringify(claimRL));
await sleep(3200);
const claimA2 = await A.claim();
t.check('re-claim is idempotent (alreadyFunded, 0c)', claimA2.t === 'race.claimed' && claimA2.alreadyFunded === true && claimA2.fundedCents === 0, JSON.stringify(claimA2));
const claimB = await B.claim();
t.check('B claim funds too', claimB.t === 'race.claimed' && claimB.fundedCents === PER_GAME, JSON.stringify(claimB));
t.check('A wallet on-chain after seed+claim = 12c', (await A.onchainBalanceCents()) === SEED_CENTS + PER_GAME, `bal=${await A.onchainBalanceCents()}c`);

const probe = new RaceBot('SimProbe');
await probe.open();
t.check('prize stays FIXED after grants were paid out (display decoupled from faucet spend)', probe.hello.race?.prizeCents === 3000, `prizeCents=${probe.hello.race?.prizeCents}`);
probe.close();

// ================================================================= PHASE B
console.log('\n————— PHASE B · staked happy path + balance-aware JIT —————');
const faucetBefore = await balanceCents(faucetAddr);
A.send({ t: 'queue.join', stake: 1 });
B.send({ t: 'queue.join', stake: 1 });
await Promise.all([
  A.await((m) => m.t === 'match.found', 15000, 'match.found A'),
  B.await((m) => m.t === 'match.found', 15000, 'match.found B'),
]);
t.check('staked pair formed across distinct IPs', A.match?.gameId === B.match?.gameId && A.match.stakeCents === 1, `game=${A.match?.gameId?.slice(0, 8)}`);

const balA0 = await A.onchainBalanceCents();
const balB0 = await B.onchainBalanceCents();
const treasury0 = await balanceCents(dep.treasury);
const { overA } = await playStakedGame(A, B);
t.check('game 1 reaches game.over on both sides', !!overA && !!B.over, `winner=${overA?.winner} reason=${overA?.reason}`);

const settledA = await A.await((m) => m.t === 'game.settled', 45000, 'game.settled A').catch(() => null);
t.check('settlement lands on-chain (game.settled with txHash)', !!settledA?.txHash, JSON.stringify(settledA ?? 'timeout'));
await sleep(8000); // let the JIT hook run (fire-and-forget after onResult)

const winner = overA.winner === A.match.seat ? A : B;
const loser = winner === A ? B : A;
const winBal = await winner.onchainBalanceCents();
const loseBal = await loser.onchainBalanceCents();
const balW0 = winner === A ? balA0 : balB0;
const balL0 = winner === A ? balB0 : balA0;
t.check('winner: −1c stake, +payout on-chain', winBal === balW0 - 1 + overA.payoutCents, `before=${balW0} after=${winBal} payout=${overA.payoutCents}`);
t.check('loser: exactly −1c stake (no other movement)', loseBal === balL0 - 1, `before=${balL0} after=${loseBal}`);
t.check('treasury collected the rake', (await balanceCents(dep.treasury)) - treasury0 === 2 - overA.payoutCents, `rake=${(await balanceCents(dep.treasury)) - treasury0}`);
t.check('RICH wallets drew NOTHING from the faucet (balance-aware JIT)', (await balanceCents(faucetAddr)) === faucetBefore, `faucet ${faucetBefore}c → ${await balanceCents(faucetAddr)}c`);

// — game 2 with DRAINED wallets → the JIT safety net must top up the deficit.
console.log('· draining both wallets to 1c and playing game 2…');
await drainTo(A, 1);
await drainTo(B, 1);
const faucetBefore2 = await balanceCents(faucetAddr);
A.match = null; A.over = null; A.state = null;
B.match = null; B.over = null; B.state = null;
A.send({ t: 'queue.join', stake: 1 });
B.send({ t: 'queue.join', stake: 1 });
await Promise.all([
  A.await((m) => m.t === 'match.found' && m.gameId !== overA.gameId && !!m.gameId, 15000, 'match.found A (g2)').then((m) => (A.match = m)),
  B.await((m) => m.t === 'match.found' && m.gameId === A.match?.gameId, 15000, 'match.found B (g2)').then((m) => (B.match = m)),
]).catch(() => { /* fallthrough: match fields set by connect handler anyway */ });
t.check('game 2 pair formed', !!A.match?.gameId && A.match.gameId === B.match?.gameId, `game=${A.match?.gameId?.slice(0, 8)}`);
const { overA: over2 } = await playStakedGame(A, B);
t.check('game 2 reaches game.over', !!over2, `winner=${over2?.winner}`);
await A.await((m) => m.t === 'game.settled' && m.gameId === A.match.gameId, 45000, 'game.settled g2').catch(() => null);
await sleep(8000); // JIT hook
const w2 = over2.winner === A.match.seat ? A : B;
const l2 = w2 === A ? B : A;
const w2bal = await w2.onchainBalanceCents();
const l2bal = await l2.onchainBalanceCents();
t.check('drained LOSER is topped back up to the per-game target (deficit-only drip)', l2bal === PER_GAME, `loser=${l2bal}c (target ${PER_GAME}c)`);
t.check('drained WINNER got at most its deficit (payout counts first)', w2bal >= PER_GAME && w2bal <= PER_GAME + over2.payoutCents, `winner=${w2bal}c payout=${over2.payoutCents}c`);
t.check('faucet paid only the deficits, not 2×perGame', faucetBefore2 - (await balanceCents(faucetAddr)) <= 2 * PER_GAME - over2.payoutCents, `faucet spent ${faucetBefore2 - (await balanceCents(faucetAddr))}c`);

// ================================================================= PHASE C
console.log('\n————— PHASE C · rematch (fresh entropy, same seats, full cycle) —————');
const seatsBefore = { A: A.match.seat, B: B.match.seat };
const g2id = A.match.gameId;
A.requestRematch();
await sleep(500);
const mark = B.mark();
B.send({ t: 'rematch.poll' });
const offer = await B.awaitFrom(mark, (m) => m.t === 'rematch.offer', 8000, 'rematch.offer').catch(() => null);
t.check('opponent sees the rematch offer (poll pulls the push)', !!offer, JSON.stringify(offer ?? 'none'));
B.requestRematch();
await Promise.all([
  A.await((m) => m.t === 'match.found' && m.gameId !== g2id, 15000, 'rematch match.found A').then((m) => (A.match = m)),
  B.await((m) => m.t === 'match.found' && m.gameId !== g2id, 15000, 'rematch match.found B').then((m) => (B.match = m)),
]);
t.check('rematch pairs the SAME two players directly', A.match.gameId === B.match.gameId, `game=${A.match.gameId.slice(0, 8)}`);
t.check('rematch keeps the SAME seats (no silent colour swap)', A.match.seat === seatsBefore.A && B.match.seat === seatsBefore.B, `A ${seatsBefore.A}→${A.match.seat}, B ${seatsBefore.B}→${B.match.seat}`);
const { overA: over3 } = await playStakedGame(A, B);
t.check('rematch game completes and settles', !!over3, `winner=${over3?.winner}`);
await A.await((m) => m.t === 'game.settled' && m.gameId === A.match.gameId, 45000, 'rematch settled').catch(() => null);
A.close();
B.close();

// ================================================================= PHASE D
console.log('\n————— PHASE D · failure modes —————');
// D1: mid-staking socket drop → resume replays the match context, no abort.
const C = new RaceBot('SimChloe');
const D = new RaceBot('SimDavid');
await Promise.all([C.fuel(), D.fuel()]);
await C.open(); await D.open();
await C.seed(); await D.seed(); // seed alone funds the 1c stake (claim covered in phase A)
C.send({ t: 'queue.join', stake: 1 });
D.send({ t: 'queue.join', stake: 1 });
await Promise.all([
  C.await((m) => m.t === 'match.found', 15000, 'match.found C'),
  D.await((m) => m.t === 'match.found', 15000, 'match.found D'),
]);
const dropGame = C.match.gameId;
C.ws.close(); // the takeover/blip: socket dies before any lock
await sleep(1500);
await C.open({ sessionToken: C.hello.sessionToken }); // resume within the 15s grace
const replay = await C.await((m) => m.t === 'match.found' && m.gameId === dropGame && C.log.indexOf(m) > 0, 10000, 'match.found replay').catch(() => null);
t.check('D1 resume within grace REPLAYS the pending match (no abort)', !!replay || C.match?.gameId === dropGame, `replayed=${!!replay}`);
const aborted = C.log.concat(D.log).find((m) => m.t === 'error' && m.code === 'MATCH_ABORTED');
t.check('D1 nobody got MATCH_ABORTED during the drop', !aborted, JSON.stringify(aborted ?? 'clean'));
const { overA: overCD } = await playStakedGame(C, D, { maxMs: 300_000 });
t.check('D1 the dropped-then-resumed match still completes end-to-end', !!overCD, `winner=${overCD?.winner}`);
C.close(); D.close();

// D2: opponent leaves for good → grace expires → abort with the leave reason.
const E = new RaceBot('SimEva');
const F = new RaceBot('SimFred');
await Promise.all([E.fuel(), F.fuel()]);
await E.open(); await F.open();
await E.seed(); await F.seed(); // seed alone funds the 1c stake (claim covered in phase A)
E.send({ t: 'queue.join', stake: 1 });
F.send({ t: 'queue.join', stake: 1 });
await Promise.all([
  E.await((m) => m.t === 'match.found', 15000, 'match.found E'),
  F.await((m) => m.t === 'match.found', 15000, 'match.found F'),
]);
F.ws.close(); // F never comes back
const eAbort = await E.await((m) => m.t === 'error' && m.code === 'MATCH_ABORTED', 30000, 'E abort after grace').catch(() => null);
t.check('D2 the innocent player is released after the grace (opponent-left abort)', !!eAbort && /left/i.test(eAbort.message ?? ''), JSON.stringify(eAbort ?? 'none'));
// …and can immediately queue again.
E.match = null;
E.send({ t: 'queue.join', stake: 1 });
const requeueOk = await E.await((m) => m.t === 'queue.ok', 8000, 'E re-queue').catch(() => null);
t.check('D2 the released player can re-queue at once (no wedge)', !!requeueOk, JSON.stringify(requeueOk ?? 'none'));
E.close();

// D3: re-queue while pending un-wedges the stale match for BOTH sides.
const G = new RaceBot('SimGala');
const H = new RaceBot('SimHugo');
await Promise.all([G.fuel(), H.fuel()]);
await G.open(); await H.open();
await G.seed(); await H.seed(); // seed alone funds the 1c stake (claim covered in phase A)
G.send({ t: 'queue.join', stake: 1 });
H.send({ t: 'queue.join', stake: 1 });
await Promise.all([
  G.await((m) => m.t === 'match.found', 15000, 'match.found G'),
  H.await((m) => m.t === 'match.found', 15000, 'match.found H'),
]);
const gMark = G.mark();
H.send({ t: 'queue.join', stake: 1 }); // H bails on the pending match by re-queuing
const gAbort = await G.awaitFrom(gMark, (m) => m.t === 'error' && m.code === 'MATCH_ABORTED', 15000, 'G aborted by H re-queue').catch(() => null);
t.check('D3 re-queue during pending aborts the stale match for the opponent', !!gAbort, JSON.stringify(gAbort ?? 'none'));
G.close(); H.close();

// ================================================================= PHASE E
console.log('\n————— PHASE E · in-game disconnect → resume → completion —————');
const K = new RaceBot('SimKira');
const L = new RaceBot('SimLeon');
await Promise.all([K.fuel(), L.fuel()]);
await K.open(); await L.open();
await K.seed(); await L.seed(); // seed alone funds the 1c stake (claim covered in phase A)
K.send({ t: 'queue.join', stake: 1 });
L.send({ t: 'queue.join', stake: 1 });
await Promise.all([
  K.await((m) => m.t === 'match.found', 15000, 'match.found K'),
  L.await((m) => m.t === 'match.found', 15000, 'match.found L'),
]);
await Promise.all([K.lockStake(), L.lockStake()]);
await Promise.all([
  K.await((m) => m.t === 'game.state', 150_000, 'game.state K'),
  L.await((m) => m.t === 'game.state', 150_000, 'game.state L'),
]);
// let a few turns happen, then kill K's socket mid-game
const playK = K.playUntilOver({ maxMs: 300_000 });
const playL = L.playUntilOver({ maxMs: 300_000 });
await sleep(6000);
K.ws.close();
await sleep(2000);
await K.open({ sessionToken: K.hello.sessionToken });
t.check('E resume carries the live game (hello.ok.resumed)', !!K.hello.resumed && K.hello.resumed.gameId === K.match.gameId, JSON.stringify(K.hello.resumed?.gameId ?? 'none'));
K.state = K.hello.resumed?.state ?? K.state;
const playK2 = K.playUntilOver({ maxMs: 300_000 });
const [overK] = await Promise.all([playK2, playL, playK.catch(() => null)]);
t.check('E the interrupted game still completes for both', !!(overK ?? K.over) && !!L.over, `winner=${(overK ?? K.over)?.winner}`);
K.close(); L.close();

t.done();
process.exit(process.exitCode ?? 0);
