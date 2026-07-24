/**
 * Race HOUSE BOT verification (standalone — isolates the money path from the
 * A–E human-vs-human journey so the bot's fast fallback / intercept can't
 * perturb those phases). Proves the real player-vs-server-bot lifecycle:
 * a fully-claimed human queues ALONE on the Race tier, the fallback sweep
 * summons the house bot, the human locks 1c and plays while the SERVER locks
 * the bot's 1c (approve+escrow.join) and drives its seat, the game settles
 * on-chain, and four integrity checks hold.
 *
 * Requires the stack from e2e/race/README.md, with the server ALSO armed:
 *   RACE_HOUSE_BOT_ENABLED=true RACE_HOUSE_BOT_PRIVATE_KEY=<hardhat #3>
 *   RACE_BOT_FALLBACK_MS=2500 RACE_COLLUSION_PAIR_CAP=0 BOT_THINK_MS=0 DIE_SETTLE_MS=0
 *
 * Run: node e2e/race/sim-housebot.mjs
 */
import pg from 'pg';
import { tally } from '../lib/common.mjs';
import { RaceBot, armChain, balanceUnits, sleep, playStakedVsHouse, HOUSE_BOT_ADDR } from './lib.mjs';

const t = tally('sim-housebot');
const { faucetAddr } = await armChain({ faucetUsdCents: 3000 });

console.log('\n————— house bot · real player vs SERVER-SIDE bot —————');
const H = new RaceBot('SimHouseFoe');
await H.fuel();
await H.open();
await H.seed();
await H.mintPass();
await sleep(3200); // shared seed/claim anti-spam clock
const claimed = await H.claim();
t.check('human is a CLAIMED participant (makes the zero-score check meaningful)', claimed?.t === 'race.claimed', claimed?.t);

const faucetBefore = await balanceUnits(faucetAddr);
const botBefore = await balanceUnits(HOUSE_BOT_ADDR);

const mk = H.mark();
H.send({ t: 'queue.join', stake: 1 });
// No human opponent → the fallback sweep summons the bot (RACE_BOT_FALLBACK_MS).
const found = await H.awaitFrom(mk, (m) => m.t === 'match.found', 30_000, 'match.found vs house bot (summon hook)');
t.check('house-bot match found for a lone Race seeker', !!found && !!H.match?.gameId, `gameId=${H.match?.gameId}`);
const over = await playStakedVsHouse(H, { maxMs: 180_000 });
t.check('house-bot game reached game.over for the human', !!(over ?? H.over), `winner=${(over ?? H.over)?.winner}`);
const settled = await H.await((m) => m.t === 'game.settled' && m.gameId === H.match.gameId, 90_000).catch(() => null);
t.check('house-bot game settled on-chain', !!settled, settled ? 'settled' : 'no game.settled');

// (1) integrity tag — the same Postgres the server wrote to.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const { rows } = await pool.query('SELECT is_house_bot FROM games WHERE id = $1', [H.match.gameId]);
  t.check('game is tagged is_house_bot in the DB', rows[0]?.is_house_bot === true, JSON.stringify(rows[0] ?? null));
} finally {
  await pool.end();
}

// (2) scored ZERO for the human (fully claimed → would otherwise score).
const mk2 = H.mark();
H.send({ t: 'race.leaderboard' });
const board = await H.awaitFrom(mk2, (m) => m.t === 'race.board', 8_000, 'race.board');
t.check('house-bot game scored ZERO for the human', board?.myPoints === 0 && board?.myRank === 0, `pts=${board?.myPoints} rank=${board?.myRank}`);

// (3) faucet NOT drawn (past the JIT window); bot staked from its OWN wallet.
await sleep(8_000);
const faucetAfter = await balanceUnits(faucetAddr);
t.check('faucet UNCHANGED by the house-bot game', faucetAfter === faucetBefore, `before=${faucetBefore} after=${faucetAfter}`);
const botAfter = await balanceUnits(HOUSE_BOT_ADDR);
t.check('bot staked from its OWN wallet (balance moved)', botAfter !== botBefore, `before=${botBefore} after=${botAfter}`);
t.check('bot wallet != faucet wallet', HOUSE_BOT_ADDR.toLowerCase() !== faucetAddr.toLowerCase(), `${HOUSE_BOT_ADDR} vs ${faucetAddr}`);
H.close();

t.done();
process.exit(process.exitCode ?? 0);
