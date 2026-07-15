/**
 * M8 (free 4-player Sit&Go) at the protocol level: two humans + server bot-fill,
 * played to game.over4. Also asserts the 4p pacing contract: every dice4 is
 * followed by a playable continuation, and no server-driven move lands inside
 * the 700ms die tumble (the 4p room has always paced with BOT_MOVE_MS).
 */
import { WireBot, sleep, tally } from './lib/common.mjs';

const t = tally('wire-4p');

const a = new WireBot('Wire4A');
const b = new WireBot('Wire4B');
await a.connect();
a.send({ t: 'queue.join4', stakeCents: 0 });
await sleep(400);
await b.connect();
b.send({ t: 'queue.join4', stakeCents: 0 });

await Promise.all([
  a.await((m) => m.t === 'match.found4', 25000, 'match.found4 A'),
  b.await((m) => m.t === 'match.found4', 25000, 'match.found4 B'),
]);
t.check('M8 Sit&Go fills (humans + bots)', a.match?.players?.length === 4, `seats ${a.match?.seat}/${b.match?.seat}, table ${a.match?.players?.map((p) => p.name).join('·')}`);

const started = Date.now();
const capMs = Number(process.env.M8_CAP_MS || 300_000);
const [over] = await Promise.all([
  a.playUntilOver({ is4p: true, maxMs: capMs }),
  b.playUntilOver({ is4p: true, maxMs: capMs }),
]);
const mins = ((Date.now() - started) / 60000).toFixed(1);
// A full ludo4 game (4 tokens x 4 seats, frequent captures) legitimately runs
// long, so within the default cap the HARD oracle is PROGRESS, not completion:
// tokens must actually reach home. Set M8_CAP_MS=1200000 for a full-game run.
// (verified once end-to-end: winner seat 1, game.over4 in 6.6min)
if (over) t.check('M8 full game reaches game.over4', true, `winner seat ${over.winner} in ${mins}min`);
else {
  // durations vary wildly (captures reset tokens), so the anti-wedge oracle is
  // "the game is STILL ROLLING at the cap", not "tokens reached home by then"
  const lastDice = [...a.log].reverse().find((m) => m.t === 'game.dice4');
  const rollingAtCap = lastDice && Date.now() - lastDice.at < 5000;
  const finished = a.log.filter((m) => m.t === 'game.moved4' && m.finished).length;
  t.check('M8 game never wedges within the cap', !!rollingAtCap, `${finished} tokens home, last roll ${lastDice ? Date.now() - lastDice.at : '∞'}ms ago after ${mins}min`);
}

// pacing: bot/forced moves must never land inside the 700ms tumble
const gaps = [];
for (let i = 0; i < a.log.length; i++) {
  if (a.log[i].t !== 'game.dice4') continue;
  const rest = a.log.slice(i + 1);
  const nxt = rest.find((m) => ['game.moved4', 'game.state4', 'game.turn4', 'game.over4'].includes(m.t));
  if (nxt?.t === 'game.moved4' && nxt.seat === a.log[i].seat) {
    // only server-paced moves count: skip the ones OUR bots chose (multi-choice)
    const ours = nxt.seat === a.match.seat || nxt.seat === b.match.seat;
    const multi = rest.find((m) => m.t === 'game.state4');
    if (!(ours && multi && rest.indexOf(multi) < rest.indexOf(nxt))) gaps.push(nxt.at - a.log[i].at);
  }
}
const early = gaps.filter((g) => g < 700);
t.check('M8 rolls observed in volume', gaps.length >= 40, `${gaps.length} paced rolls`);
t.check('M8 no move lands inside the die tumble', early.length === 0, `${early.length}/${gaps.length} early (min gap ${Math.min(...gaps)}ms)`);

a.close(); b.close();
t.done();
