/**
 * Wire-level regression: R1, R2, R3, R4, R13, R23 + turn-clock auto-play +
 * illegal/duplicate/spam input hardening + M2 (public free queue) full game.
 * See docs/QA-GAME-AUDIT-PROMPT.md §6.
 */
import { WireBot, privatePair, sleep, tally } from './lib/common.mjs';

const t = tally('wire-regression');

// ---------- M2: public free matchmaking, full game to game.over (covers R1+R2)
{
  const a = new WireBot('AuditQueueA');
  const b = new WireBot('AuditQueueB');
  await a.connect();
  a.send({ t: 'queue.join', stake: 0 });
  await sleep(400);
  await b.connect();
  b.send({ t: 'queue.join', stake: 0 });
  await Promise.all([
    a.await((m) => m.t === 'match.found', 15000, 'match.found A'),
    b.await((m) => m.t === 'match.found', 15000, 'match.found B'),
  ]);
  t.check('M2 matchmaking pairs two free players', a.match && b.match && a.match.seat !== b.match.seat);

  const [overA] = await Promise.all([a.playUntilOver(), b.playUntilOver()]);
  t.check('M2 full game reaches game.over', !!overA, overA ? `winner seat ${overA.winner} by ${overA.reason}` : 'no game.over');

  // Fairness is independently verifiable: the seed revealed at game over must
  // hash to the commit published BEFORE the game, and my own revealed entropy
  // must be one of the bound inputs (the dice-derivation math has unit tests).
  const { createHash: ch } = await import('node:crypto');
  const reveal = overA?.fairnessReveal;
  const commitOk = reveal && ch('sha256').update(reveal.serverSeed).digest('hex') === a.match.fairnessCommit;
  const entropyBound = reveal?.entropies?.includes(a.entropy);
  t.check('fairness commit verifies against the revealed seed', !!commitOk);
  t.check('my revealed entropy is bound into the dice', !!entropyBound);

  // R1 — every dice is followed by a playable continuation (<1.5s): moved (forced),
  // state (multi-choice), or turn (no legal move). A missing state = frozen roller.
  const gaps = [];
  for (const bot of [a, b]) {
    for (let i = 0; i < bot.log.length; i++) {
      if (bot.log[i].t !== 'game.dice') continue;
      const nxt = bot.log.slice(i + 1).find((m) => ['game.moved', 'game.state', 'game.turn', 'game.over'].includes(m.t));
      if (nxt) gaps.push(nxt.at - bot.log[i].at);
    }
  }
  t.check('R1/R2 every roll continues the game', gaps.length > 10 && Math.max(...gaps) < 1500, `${gaps.length} rolls, max gap ${Math.max(...gaps)}ms`);

  // R2 specifically — a dice→turn sequence with NO move in between (no legal move)
  // must still leave the next player able to roll (their dice follows).
  let noMoveTurns = 0, recovered = 0;
  const log = a.log;
  for (let i = 0; i < log.length; i++) {
    if (log[i].t !== 'game.dice') continue;
    const rest = log.slice(i + 1);
    const nxt = rest.find((m) => ['game.moved', 'game.turn'].includes(m.t));
    if (nxt?.t !== 'game.turn') continue;
    noMoveTurns++;
    if (rest.find((m) => m.t === 'game.dice' || m.t === 'game.over')) recovered++;
  }
  t.check('R2 no-legal-move rolls hand over cleanly', noMoveTurns === 0 || recovered === noMoveTurns, `${recovered}/${noMoveTurns} recovered`);

  // R3 — rematch with FRESH entropy commit must start game 2 (both re-reveal).
  // Index marks, not timestamps (a local reply can land in the same millisecond).
  const { createHash, randomBytes } = await import('node:crypto');
  const marks = { a: a.mark(), b: b.mark() };
  for (const bot of [a, b]) {
    bot.match = null;
    bot.entropy = randomBytes(32).toString('hex');
    bot.send({ t: 'game.rematch', entropyCommit: createHash('sha256').update(bot.entropy).digest('hex') });
  }
  const g2 = await Promise.all([
    a.awaitFrom(marks.a, (m) => m.t === 'match.found', 15000, 'rematch match.found A').catch(() => null),
    b.awaitFrom(marks.b, (m) => m.t === 'match.found', 15000, 'rematch match.found B').catch(() => null),
  ]);
  const g2state = g2[0] && (await a.awaitFrom(marks.a, (m) => m.t === 'game.state', 10000, 'game 2 state').catch(() => null));
  if (!(g2[0] && g2[1] && g2state)) {
    // diagnostic dump: exactly what each side saw after game 1 ended
    for (const [tag, bot, from] of [['A', a, marks.a], ['B', b, marks.b]]) {
      t.note(`R3 FAIL ${tag} post-over traffic: ${bot.log.slice(from).map((m) => m.t + (m.message ? `(${m.message})` : '')).join(', ') || '(nothing)'}`);
    }
  }
  t.check('R3 rematch starts a second game', !!g2[0] && !!g2[1] && !!g2state);

  // resign path cleans up game 2 (end-of-game by resign is itself under test)
  if (g2state) {
    const resignMark = b.mark();
    a.send({ t: 'game.resign' });
    const over2 = await b.awaitFrom(resignMark, (m) => m.t === 'game.over', 8000, 'resign game.over').catch(() => null);
    t.check('resign ends the game for both', over2?.reason === 'resign', `reason=${over2?.reason}`);
  }
  a.close(); b.close();
}

// ---------- R4 + R13: private rematch never leaks publicly; seats are kept
{
  const { a: host, b: guest } = await privatePair('AuditPrivH', 'AuditPrivG');
  const seats1 = { host: host.match.seat, guest: guest.match.seat };
  await Promise.all([host.playUntilOver(), guest.playUntilOver()]);
  t.check('M5 private full game reaches game.over', !!host.over, host.over ? `winner ${host.over.winner}` : '');

  const { createHash, randomBytes } = await import('node:crypto');
  const hMark = host.mark(), gMark = guest.mark();
  // stranger sits in the public free queue the whole time
  const stranger = new WireBot('AuditStranger');
  await stranger.connect();
  stranger.send({ t: 'queue.join', stake: 0 });
  await sleep(300);
  // guest asks for the private rematch FIRST (old leak: could match the stranger)
  guest.entropy = randomBytes(32).toString('hex');
  guest.send({ t: 'game.rematch', entropyCommit: createHash('sha256').update(guest.entropy).digest('hex') });
  await sleep(5000);
  t.check('R4 private rematch never matches a stranger', !stranger.log.some((m) => m.t === 'match.found') && !guest.log.slice(gMark).some((m) => m.t === 'match.found'));

  // host rematches LAST → old bug swapped seats (last clicker became seat 0)
  host.match = null; guest.match = null;
  host.entropy = randomBytes(32).toString('hex');
  host.send({ t: 'game.rematch', entropyCommit: createHash('sha256').update(host.entropy).digest('hex') });
  const rems = await Promise.all([
    host.awaitFrom(hMark, (m) => m.t === 'match.found', 12000, 'private rematch host').catch(() => null),
    guest.awaitFrom(gMark, (m) => m.t === 'match.found', 12000, 'private rematch guest').catch(() => null),
  ]);
  t.check('R13 rematch keeps the same seats', rems[0]?.seat === seats1.host && rems[1]?.seat === seats1.guest,
    `g1 ${seats1.host}/${seats1.guest} → g2 ${rems[0]?.seat}/${rems[1]?.seat}`);
  host.send({ t: 'game.resign' });
  await sleep(500);
  host.close(); guest.close(); stranger.close();
}

// ---------- R23: free game starts even when one side never reveals (≤ ~7s)
{
  const host = new WireBot('AuditRevealH');
  await host.connect();
  host.send({ t: 'table.create', stake: 0 });
  const created = await host.await((m) => m.t === 'table.created', 8000, 'table.created');
  const mute = new WireBot('AuditRevealMute', { autoReveal: false }); // never reveals
  await mute.connect();
  mute.send({ t: 'table.join', code: created.code });
  await host.await((m) => m.t === 'match.found', 10000, 'match.found');
  const started = await host.await((m) => m.t === 'game.state', 9000, 'game.state despite missing reveal').catch(() => null);
  t.check('R23 free game starts within the reveal-timeout grace', !!started);
  host.send({ t: 'game.resign' });
  await sleep(400);
  host.close(); mute.close();
}

// ---------- Turn clock: idle player is auto-played (game.auto), game continues
{
  const { a, b } = await privatePair('AuditClockA', 'AuditClockB');
  // nobody plays: whoever holds the turn gets auto-played by the 15s clock
  const auto = await a.await((m) => m.t === 'game.auto', 25000, 'game.auto').catch(() => null);
  t.check('clock auto-plays an idle turn (game.auto)', !!auto, auto ? `seat ${auto.seat} count ${auto.count}/${auto.max}` : '');
  // and the game is still playable afterwards: finish it
  const [over] = await Promise.all([a.playUntilOver({ maxMs: 200_000 }), b.playUntilOver({ maxMs: 200_000 })]);
  t.check('game continues and completes after an auto-play', !!over);
  a.close(); b.close();
}

// ---------- Input hardening: illegal, duplicate, out-of-turn, spam
{
  const { a, b } = await privatePair('AuditChaosA', 'AuditChaosB');
  // the turn holder is only knowable once the opening state arrives
  await Promise.all([
    a.await((m) => m.t === 'game.state', 8000, 'opening state A'),
    b.await((m) => m.t === 'game.state', 8000, 'opening state B'),
  ]);
  const me = a.state.turn === a.match.seat ? a : b;
  const other = me === a ? b : a;

  // out-of-turn roll FIRST, while the turn provably belongs to `me` (waiting
  // 900ms+ would let the server auto-move and hand the turn over, making the
  // "illegal" roll legal — that raced in the full-suite run)
  const oppDiceBefore = other.log.filter((m) => m.t === 'game.dice' && m.seat === other.match.seat).length;
  other.send({ t: 'game.roll' });
  await sleep(500);
  const oppDiceAfter = other.log.filter((m) => m.t === 'game.dice' && m.seat === other.match.seat).length;
  t.check('out-of-turn roll is ignored', oppDiceAfter === oppDiceBefore);

  // illegal move while awaiting-roll → must be ignored, session intact
  me.send({ t: 'game.move', token: 99 });
  await sleep(300);
  // duplicate roll: two game.roll back-to-back → exactly ONE dice for this turn
  const diceBefore = me.log.filter((m) => m.t === 'game.dice').length;
  me.send({ t: 'game.roll' });
  me.send({ t: 'game.roll' });
  await sleep(1200);
  const diceAfter = me.log.filter((m) => m.t === 'game.dice').length;
  t.check('duplicate game.roll yields exactly one dice', diceAfter - diceBefore === 1, `${diceAfter - diceBefore} dice`);

  // emote spam → throttled server-side, socket stays alive (ping answers)
  for (let i = 0; i < 20; i++) me.send({ t: 'emote', id: 'laugh' });
  me.send({ t: 'ping' });
  const pong = await me.await((m) => m.t === 'pong', 5000, 'pong after spam').catch(() => null);
  t.check('socket alive after emote spam (throttle, no kill)', !!pong);

  // duplicate queue join is refused while in a game
  me.send({ t: 'queue.join', stake: 0 });
  const err = await me.await((m) => m.t === 'error' && /already/i.test(m.message ?? ''), 4000, 'queue-while-in-game error').catch(() => null);
  t.check('queue.join while in a game is refused cleanly', !!err, err?.message);

  // and the game is still perfectly playable end-to-end after all of that
  const [over] = await Promise.all([a.playUntilOver({ maxMs: 200_000 }), b.playUntilOver({ maxMs: 200_000 })]);
  t.check('game completes after the chaos barrage', !!over);
  a.close(); b.close();
}

t.done();
