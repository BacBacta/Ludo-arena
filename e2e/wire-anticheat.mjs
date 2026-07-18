/**
 * Phase 7 — explicit anti-cheat tests. A MODIFIED client tries the three cheats
 * the brief calls out; the server must defeat all of them:
 *   1. See / choose / predict the dice ahead of time.
 *   2. Play FOR ANOTHER seat.
 *   3. Declare its own victory.
 *
 * Run against a local server: SRV='ws://localhost:8787/?qa=simkey' node e2e/wire-anticheat.mjs
 */
import { WireBot, tally } from './lib/common.mjs';

const t = tally('wire-anticheat');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pair(tag) {
  const a = new WireBot(`${tag}A`);
  const b = new WireBot(`${tag}B`);
  await a.connect();
  a.send({ t: 'table.create', stake: 0 });
  const created = await a.await((m) => m.t === 'table.created', 8000, 'created');
  await b.connect();
  b.send({ t: 'table.join', code: created.code });
  await Promise.all([a.await((m) => m.t === 'match.found', 10000), b.await((m) => m.t === 'match.found', 10000)]);
  await sleep(300);
  return { a, b };
}
const mine = (bot) => bot.state && bot.state.turn === bot.match.seat;

async function main() {
  // ============ 1. DICE cannot be seen ahead, chosen, or predicted ============
  {
    const { a, b } = await pair('dice');
    // (a) the server seed that determines EVERY die is NOT revealed until game.over
    //     — so a client cannot compute future rolls. Play a while and check no
    //     fairnessReveal / serverSeed appears before the game ends.
    const mover = mine(a) ? a : b;
    const values = [];
    const prev = mover.onMessage;
    mover.onMessage = (m) => { prev?.(m); if (m.t === 'game.dice' && m.seat === mover.match.seat) values.push(m.value); };
    // (b) try to CHOOSE the die: send game.roll WITH a value:6 every time.
    for (let i = 0; i < 30 && !a.over && !b.over; i++) {
      for (const bot of [a, b]) {
        if (!mine(bot)) continue;
        const s = bot.state;
        if (s.phase === 'awaiting-roll') bot.send({ t: 'game.roll', value: 6, die: 6 }); // injected fields
        else if (s.phase === 'awaiting-move' && s.legal?.length) bot.send({ t: 'game.move', token: s.legal[0] });
      }
      await sleep(90);
    }
    const revealBeforeOver = mover.log.some((m, i) => (m.fairnessReveal || m.serverSeed) && m.t !== 'game.over' && !mover.log.slice(0, i).some((x) => x.t === 'game.over'));
    t.check('server seed / fairnessReveal never sent before game.over (dice unpredictable)', !revealBeforeOver);
    // injecting value:6 did NOT force sixes — the server ignores it and rolls its own
    const sixRate = values.length ? values.filter((v) => v === 6).length / values.length : 0;
    t.check('client cannot CHOOSE the die (value:6 injection ignored; rolls stay ~uniform)', values.length >= 8 && sixRate < 0.6, `n=${values.length} sixRate=${sixRate.toFixed(2)}`);
    a.close(); b.close();
  }

  // ============ 2. Cannot play FOR ANOTHER seat ============
  {
    const { a, b } = await pair('seat');
    const mover = mine(a) ? a : b;
    const waiter = mover === a ? b : a;
    // the waiter (NOT on turn) tries to roll AND move — there is no seat field to
    // spoof, the server derives the seat from the session, so it's simply not their turn.
    const from = waiter.mark();
    waiter.send({ t: 'game.roll' });
    waiter.send({ t: 'game.move', token: 0 });
    // even try to move the OPPONENT's actual legal token by index
    if (mover.state?.legal?.length) waiter.send({ t: 'game.move', token: mover.state.legal[0] });
    await sleep(250);
    const err = waiter.log.slice(from).some((m) => m.t === 'error' && (m.code === 'NOT_YOUR_TURN' || m.code === 'BAD_STATE'));
    const leaked = waiter.log.slice(from).some((m) => m.t === 'game.dice' || m.t === 'game.moved');
    t.check('acting for the opponent is rejected (NOT_YOUR_TURN), no dice/move applied', err && !leaked, `err=${err} leaked=${leaked}`);

    // resigning only ends the sender's OWN seat: the waiter resigns → the waiter
    // loses, never the mover (a client cannot resign someone else).
    const { a: c, b: d } = await pair('seat2');
    const loser = c; // c deliberately resigns
    c.send({ t: 'game.resign' });
    const over = await c.await((m) => m.t === 'game.over', 8000).catch(() => null);
    const winner = over?.winner;
    t.check('game.resign forfeits only the SENDER (winner is the opponent seat)', winner !== undefined && winner === d.match.seat, `winner=${winner} sender-seat=${loser.match.seat}`);
    a.close(); b.close(); c.close(); d.close();
  }

  // ============ 3. Cannot DECLARE victory ============
  {
    const { a, b } = await pair('win');
    const from = a.mark();
    // forge server→client frames as if they were client messages: a fake win.
    a.send({ t: 'game.over', winner: a.match.seat, payoutCents: 999999, rakeCents: 0 });
    a.send({ t: 'game.state', state: { positions: [[56, 56], [-1, -1]], turn: a.match.seat, dice: null, legal: [], rollCount: 0, sixStreak: 0, phase: 'over', winner: a.match.seat } });
    a.send({ t: 'game.moved', seat: a.match.seat, token: 0, capture: false, state: {} });
    await sleep(300);
    // parseClientMsg rejects these (they are not ClientMsg types) → BAD_MESSAGE,
    // and crucially NO real game.over with our seat as winner is produced.
    const badMsg = a.log.slice(from).some((m) => m.t === 'error' && m.code === 'BAD_MESSAGE');
    const forgedWin = a.log.slice(from).some((m) => m.t === 'game.over');
    t.check('forged game.over / game.state / game.moved are rejected (BAD_MESSAGE)', badMsg, `badMsg=${badMsg}`);
    t.check('client CANNOT declare victory (no game.over produced from a forged frame)', !forgedWin);
    // the real game is untouched — still playable
    const alive = a.state && a.state.phase !== 'over';
    t.check('the real game is unaffected by the forged-victory attempt', alive);
    a.close(); b.close();
  }

  const bad = t.done();
}

void main();
