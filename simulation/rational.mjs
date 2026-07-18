/**
 * Rational bot simulation over the REAL WebSocket layer (Phase 4, core mission).
 * Two bots pair on a FREE private table and play a full game through the server
 * protocol (game.roll / game.move) with VARIED strategies. After every
 * server-applied state the structural invariants are checked; a violation (or a
 * crash / zombie) is recorded with the game's seed + full dice+move sequence for
 * deterministic replay (see replay.mjs).
 *
 * Usage: node simulation/rational.mjs [GAMES=2000] [CONCURRENCY=24]
 *   SRV=ws://localhost:8787 (default). Accelerated: no artificial move delay.
 */
import { WireBot } from '../e2e/lib/common.mjs';
import { checkState, checkCapture, checkMove } from './invariants.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const FINISHED = 56;

/** Deterministic PRNG (mulberry32) so a game's "random" choices replay identically. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Move strategies: given (state, seat) → a token from state.legal. Varied so the
 *  sim exercises many rule paths (exits, captures, finishes, blocks). */
export const STRATEGIES = {
  first: (s) => s.legal[0],
  last: (s) => s.legal[s.legal.length - 1],
  advanced: (s, seat) => s.legal.reduce((b, t) => (s.positions[seat][t] > s.positions[seat][b] ? t : b), s.legal[0]),
  laggard: (s, seat) => s.legal.reduce((b, t) => (s.positions[seat][t] < s.positions[seat][b] ? t : b), s.legal[0]),
  random: (s, seat, rand) => s.legal[Math.floor(rand() * s.legal.length)],
  exiter: (s, seat) => {
    const base = s.legal.find((t) => s.positions[seat][t] === -1);
    return base !== undefined ? base : s.legal.reduce((b, t) => (s.positions[seat][t] > s.positions[seat][b] ? t : b), s.legal[0]);
  },
};
const STRAT_NAMES = Object.keys(STRATEGIES);

/** Run ONE full 2p rational game over real WS. Returns a record (violation/crash/
 *  zombie or clean) plus the deterministic replay data. */
export async function playRationalGame(idx, stratA, stratB) {
  const seed = (idx * 2654435761) >>> 0;
  const rand = rng(seed);
  const rec = { idx, stratA, stratB, seed, entropies: {}, dice: [], moves: [], rolls: 0, violation: null, crash: null, zombie: false, over: false, winner: null };

  const host = new WireBot(`R${idx}a`);
  const guest = new WireBot(`R${idx}b`);
  const bots = [host, guest];
  const strat = [STRATEGIES[stratA], STRATEGIES[stratB]];

  let prevState = null;
  const lastDie = [null, null]; // most recent die per seat (for move-delta checks)

  // Invariant check on any authoritative state we observe (host stream is enough;
  // both see the same server-authoritative state).
  const fail = (reason, state) => { if (!rec.violation) rec.violation = { reason, state, after: rec.moves.length }; };
  const checkAndRecord = (state, moverSeat, token, capture) => {
    if (rec.violation) return;
    const v = checkState(state, 2, prevState);
    if (v) return fail(v, state);
    if (moverSeat !== undefined) {
      const mv = checkMove(prevState, state, moverSeat, token, lastDie[moverSeat]);
      if (mv) return fail(mv, state);
      const cv = checkCapture(prevState, state, moverSeat, capture);
      if (cv) return fail(cv, state);
    }
    prevState = state;
  };

  try {
    await host.connect();
    rec.entropies.a = host.entropy;
    host.send({ t: 'table.create', stake: 0 });
    const created = await host.await((m) => m.t === 'table.created', 8000, 'table.created');
    await guest.connect();
    rec.entropies.b = guest.entropy;
    guest.send({ t: 'table.join', code: created.code });
    await Promise.all([
      host.await((m) => m.t === 'match.found', 10000, 'host match'),
      guest.await((m) => m.t === 'match.found', 10000, 'guest match'),
    ]);

    // drive each bot: roll on its turn, then play its strategy's token.
    for (const bot of bots) {
      const seat = bot.match.seat;
      const act = () => {
        if (bot.over || bot.closed || rec.violation) return;
        const s = bot.state;
        if (!s || s.turn !== seat) return;
        if (s.phase === 'awaiting-roll') bot.send({ t: 'game.roll' });
        else if (s.phase === 'awaiting-move' && s.legal?.length) {
          const token = strat[seat](s, seat, rand);
          rec.moves.push({ seat, token });
          bot.send({ t: 'game.move', token });
        }
      };
      const prev = bot.onMessage;
      bot.onMessage = (m) => {
        prev?.(m);
        // Record, track the die AND check invariants on ONE stream (the host).
        // Both sockets receive the same authoritative broadcasts independently, so
        // anything shared (rec.dice, lastDie) must be written from a SINGLE stream:
        // the guest's copy of an older frame can land after the host's newer one and
        // clobber it, which made checkMove compare a move against a stale die.
        if (bot === host) {
          if (m.t === 'game.dice') { rec.dice.push({ index: m.index, value: m.value, seat: m.seat }); lastDie[m.seat] = m.value; }
          if (m.t === 'game.state') checkAndRecord(m.state);
          if (m.t === 'game.moved') checkAndRecord(m.state, m.seat, m.token, m.capture);
          if (m.t === 'game.over') { rec.over = true; rec.winner = m.winner; rec.reveal = m.fairnessReveal; rec.finalPositions = prevState?.positions; }
        }
        if (m.t === 'game.turn' || m.t === 'game.state' || m.t === 'game.moved') void act();
      };
      void act();
    }

    // wait for game over (accelerated); a stall = zombie.
    const deadline = Date.now() + 60_000;
    while (!host.over && !rec.violation && Date.now() < deadline) await new Promise((r) => setTimeout(r, 40));
    rec.rolls = rec.dice.length;
    if (!host.over && !rec.violation) rec.zombie = true;
  } catch (e) {
    rec.crash = String(e?.message || e);
  } finally {
    host.close();
    guest.close();
  }
  return rec;
}

async function main() {
  const GAMES = Number(process.argv[2] || process.env.GAMES || 2000);
  const CONC = Number(process.argv[3] || process.env.CONCURRENCY || 24);
  const outDir = new URL('./out', import.meta.url).pathname;
  mkdirSync(outDir, { recursive: true });

  const summary = { games: 0, violations: 0, crashes: 0, zombies: 0, completed: 0, byStrategy: {}, failures: [] };
  let next = 0;
  const t0 = Date.now();

  async function worker() {
    while (next < GAMES) {
      const i = next++;
      const stratA = STRAT_NAMES[i % STRAT_NAMES.length];
      const stratB = STRAT_NAMES[(i * 3 + 1) % STRAT_NAMES.length];
      const rec = await playRationalGame(i, stratA, stratB);
      summary.games++;
      const key = `${stratA}/${stratB}`;
      summary.byStrategy[key] = (summary.byStrategy[key] || 0) + 1;
      if (rec.violation) summary.violations++;
      if (rec.crash) summary.crashes++;
      if (rec.zombie) summary.zombies++;
      if (rec.over) summary.completed++;
      if (rec.violation || rec.crash || rec.zombie) {
        // persist the FULL record for deterministic replay + regression conversion.
        const { idx } = rec;
        writeFileSync(`${outDir}/fail-${idx}.json`, JSON.stringify(rec, null, 1));
        summary.failures.push({ idx, violation: rec.violation?.reason, crash: rec.crash, zombie: rec.zombie, stratA, stratB });
      }
      if (summary.games % 250 === 0) {
        const rate = (summary.games / ((Date.now() - t0) / 1000)).toFixed(1);
        console.log(`[rational] ${summary.games}/${GAMES} · completed ${summary.completed} · viol ${summary.violations} · crash ${summary.crashes} · zombie ${summary.zombies} · ${rate}/s`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));

  summary.elapsedS = Math.round((Date.now() - t0) / 1000);
  writeFileSync(`${outDir}/rational-summary.json`, JSON.stringify(summary, null, 2));
  console.log('\n[rational] DONE', JSON.stringify({ games: summary.games, completed: summary.completed, violations: summary.violations, crashes: summary.crashes, zombies: summary.zombies, elapsedS: summary.elapsedS }));
  process.exit(summary.violations || summary.crashes ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
