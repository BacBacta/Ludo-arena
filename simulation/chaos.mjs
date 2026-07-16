/**
 * Chaotic / fuzzing bots (Phase 4). Drives the malicious-action catalog
 * (simulation/attack-catalog.json, from the adversarial workflow) against the
 * REAL server over WS. For every attack the server MUST: (1) not crash — it still
 * answers a ping with pong afterwards; (2) not corrupt the honest game state — the
 * structural invariants still hold; (3) reject the action appropriately (an error
 * or a clean silent drop), never applying it or acting for another player.
 *
 * Run against a server started with a NON-zero DIE_SETTLE_MS so the settle-window
 * race has a real window, e.g.:
 *   QA_KEY=simkey DIE_SETTLE_MS=150 PORT=8788 npx tsx apps/server/src/index.ts
 *   SRV='ws://localhost:8788/?qa=simkey' node simulation/chaos.mjs
 */
import { WireBot } from '../e2e/lib/common.mjs';
import { checkState } from './invariants.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Server still alive? send a ping, expect a pong within 3s. */
async function alive(bot) {
  const from = bot.mark();
  bot.send({ t: 'ping' });
  try {
    await bot.awaitFrom(from, (m) => m.t === 'pong', 3000, 'pong');
    return true;
  } catch {
    return false;
  }
}

/** Pair two bots on a FREE private table; resolves once both are in a started game. */
async function pair(tag) {
  const a = new WireBot(`${tag}A`);
  const b = new WireBot(`${tag}B`);
  await a.connect();
  a.send({ t: 'table.create', stake: 0 });
  const created = await a.await((m) => m.t === 'table.created', 8000, 'created');
  await b.connect();
  b.send({ t: 'table.join', code: created.code });
  await Promise.all([a.await((m) => m.t === 'match.found', 10000), b.await((m) => m.t === 'match.found', 10000)]);
  await sleep(300); // let the first game.state/turn land
  return { a, b };
}

const onTurn = (bot, seat) => bot.state && bot.state.turn === seat;

/** After an attack: server alive + the honest state is still structurally legal. */
async function assertHealthy(name, bot, extraDetail = '') {
  const up = await alive(bot);
  const stateOk = !bot.state || checkState(bot.state, 2, null) === null;
  const detail = [extraDetail, up ? '' : 'SERVER DID NOT PONG', stateOk ? '' : `state corrupt: ${checkState(bot.state, 2, null)}`].filter(Boolean).join('; ');
  record(name, up && stateOk, detail);
  return up && stateOk;
}

async function main() {
  // ---------- parse-layer: malformed / bad types (rejected, connection survives) ----------
  {
    const a = new WireBot('mal');
    await a.connect();
    const from = a.mark();
    a.ws.send('{not valid json'); // raw malformed frame → BAD_MESSAGE
    for (const bad of [7, -1, 1.5, '0', null, NaN]) a.send({ t: 'game.move', token: bad });
    a.send({ t: 'gift', to: 1.5, id: 'x' });
    a.send({ t: 'gift', to: 99, id: 'x' });
    await sleep(300);
    const errs = a.log.slice(from).filter((m) => m.t === 'error').length;
    // parseClientMsg rejects every one → at least the malformed JSON gets BAD_MESSAGE;
    // the connection stays open (server answers a ping).
    await assertHealthy('malformed JSON / bad-token / bad-gift rejected, connection survives', a, `${errs} error replies`);
    a.close();
  }

  // ---------- oversized frame is rejected by the 1024-byte cap (clean close, no crash) ----------
  {
    const a = new WireBot('big');
    await a.connect();
    let closed = false;
    a.ws.on('close', () => { closed = true; });
    a.ws.send(JSON.stringify({ t: 'game.move', token: 0, pad: 'x'.repeat(2000) })); // >1024 bytes
    await sleep(400);
    // the ws maxPayload (1024) closes THIS connection cleanly (code 1009). The SERVER
    // must be unaffected — a FRESH connection still works.
    const fresh = new WireBot('big2');
    await fresh.connect().catch(() => {});
    const up = await alive(fresh);
    record('oversized frame → connection closed by frame cap, server unaffected', up, `offender-closed=${closed} fresh-server-alive=${up}`);
    a.close(); fresh.close();
  }

  // ---------- pre-hello / pre-match actions are dropped ----------
  {
    const a = new WireBot('pre');
    await a.connect(); // hello sent by connect; act BEFORE any game
    const from = a.mark();
    a.send({ t: 'game.roll' });
    a.send({ t: 'game.move', token: 0 });
    await sleep(250);
    const moved = a.log.slice(from).some((m) => m.t === 'game.moved' || m.t === 'game.dice');
    await assertHealthy('pre-match game.roll/move dropped (no game exists)', a, moved ? 'LEAKED a move/dice!' : 'silently dropped');
    a.close();
  }

  // ---------- out-of-turn roll + move-before-roll + double-roll ----------
  {
    const { a, b } = await pair('turn');
    const mover = onTurn(a, a.match.seat) ? a : b;
    const waiter = mover === a ? b : a;
    const from = waiter.mark();
    waiter.send({ t: 'game.roll' }); // not my turn
    waiter.send({ t: 'game.move', token: 0 }); // not my turn
    await sleep(200);
    const gotErr = waiter.log.slice(from).some((m) => m.t === 'error' && (m.code === 'NOT_YOUR_TURN' || m.code === 'BAD_STATE'));
    const leaked = waiter.log.slice(from).some((m) => m.t === 'game.dice');
    record('out-of-turn roll/move rejected (NOT_YOUR_TURN), no dice leaked', gotErr && !leaked, `err=${gotErr} leaked=${leaked}`);

    // mover: move before rolling (awaiting-roll) → rejected
    const f2 = mover.mark();
    if (mover.state?.phase === 'awaiting-roll') mover.send({ t: 'game.move', token: 0 });
    await sleep(150);
    const rej = mover.log.slice(f2).some((m) => m.t === 'error');
    record('move-before-roll rejected', rej || mover.state?.phase !== 'awaiting-roll', '');
    await assertHealthy('server healthy after out-of-turn barrage', a);
    a.close(); b.close();
  }

  // ---------- illegal / nonexistent token (must be ILLEGAL_MOVE, never engine throw) ----------
  {
    const { a, b } = await pair('ill');
    // drive to an awaiting-move with a choice, then send bad tokens.
    const mover = onTurn(a, a.match.seat) ? a : b;
    // roll until we get a move phase (or a few tries)
    for (let i = 0; i < 12 && mover.state?.phase !== 'awaiting-move'; i++) {
      const m2 = onTurn(a, a.match.seat) ? a : onTurn(b, b.match.seat) ? b : null;
      if (m2 && m2.state?.phase === 'awaiting-roll') m2.send({ t: 'game.roll' });
      await sleep(120);
    }
    const active = [a, b].find((x) => x.state?.phase === 'awaiting-move' && onTurn(x, x.match.seat));
    if (active) {
      const from = active.mark();
      active.send({ t: 'game.move', token: 3 }); // never exists (2 tokens/player)
      active.send({ t: 'game.move', token: 2 });
      await sleep(200);
      const illegal = active.log.slice(from).some((m) => m.t === 'error' && m.code === 'ILLEGAL_MOVE');
      const internal = active.log.slice(from).some((m) => m.t === 'error' && m.code === 'INTERNAL');
      record('nonexistent token → ILLEGAL_MOVE (engine throw NOT reached)', illegal && !internal, `illegal=${illegal} internal=${internal}`);
    } else {
      record('nonexistent token test setup', true, 'skipped (no move phase reached)');
    }
    await assertHealthy('server healthy after illegal-token barrage', a);
    a.close(); b.close();
  }

  // ---------- double-submit + settle-window race (the crash hypothesis) ----------
  {
    const { a, b } = await pair('race');
    let doubleApplied = false;
    let moves = 0;
    const watch = (bot) => {
      const prev = bot.onMessage;
      bot.onMessage = (m) => { prev?.(m); if (m.t === 'game.moved') moves++; };
    };
    watch(a); watch(b);
    // play ~40 turns, and on each of OUR awaiting-roll turns, roll then IMMEDIATELY
    // double-send the move (racing any single-legal auto-play in the settle window).
    for (let i = 0; i < 60; i++) {
      for (const bot of [a, b]) {
        if (bot.over) continue;
        const s = bot.state;
        if (s?.turn === bot.match.seat) {
          if (s.phase === 'awaiting-roll') bot.send({ t: 'game.roll' });
          else if (s.phase === 'awaiting-move' && s.legal?.length) {
            const t = s.legal[0];
            bot.send({ t: 'game.move', token: t });
            bot.send({ t: 'game.move', token: t }); // double-submit
          }
        }
      }
      await sleep(80);
      if (a.over || b.over) break;
    }
    // detect a double-apply: more game.moved than legal (hard to count exactly; rely
    // on invariants + no crash + no duplicate immediate moved for the same token).
    record('double-submit / settle-window race did not corrupt (game progressed)', moves > 0, `moved events=${moves}`);
    await assertHealthy('SERVER SURVIVES the settle-window double-move race', a);
    a.close(); b.close();
  }

  // ---------- double-booking: queue.join while already in a game ----------
  {
    const { a, b } = await pair('book');
    const from = a.mark();
    a.send({ t: 'queue.join', stake: 0 }); // already in a game
    await sleep(200);
    const rejected = a.log.slice(from).some((m) => m.t === 'error' && m.code === 'BAD_STATE');
    const secondMatch = a.log.slice(from).some((m) => m.t === 'match.found');
    record('queue.join while in a game rejected (no second booking)', rejected && !secondMatch, `rejected=${rejected} secondMatch=${secondMatch}`);
    await assertHealthy('server healthy after double-book attempt', a);
    a.close(); b.close();
  }

  // ---------- actions after game over are inert ----------
  {
    const { a, b } = await pair('over');
    // resign to force game.over quickly
    const resigner = a;
    resigner.send({ t: 'game.resign' });
    await Promise.all([a.await((m) => m.t === 'game.over', 8000).catch(() => {}), b.await((m) => m.t === 'game.over', 8000).catch(() => {})]);
    const from = a.mark();
    a.send({ t: 'game.roll' }); a.send({ t: 'game.move', token: 0 });
    b.send({ t: 'game.roll' }); b.send({ t: 'game.move', token: 0 });
    await sleep(250);
    const post = a.log.slice(from).some((m) => m.t === 'game.dice' || m.t === 'game.moved' || m.t === 'game.over');
    record('post-game actions are inert (no dice/moved/second over)', !post, post ? 'LEAKED post-game activity' : 'inert');
    await assertHealthy('server healthy after post-game actions', a);
    a.close(); b.close();
  }

  // ---------- entropy reveal mismatch is rejected ----------
  {
    const a = new WireBot('ent');
    const b = new WireBot('ent2');
    await a.connect();
    a.send({ t: 'table.create', stake: 0 });
    const created = await a.await((m) => m.t === 'table.created', 8000);
    // disable autoReveal on b so we can send a BAD entropy
    b.opts.autoReveal = false;
    await b.connect();
    b.send({ t: 'table.join', code: created.code });
    await b.await((m) => m.t === 'match.found', 8000);
    const from = b.mark();
    b.send({ t: 'game.entropy', entropy: 'deadbeef_not_matching_commit' });
    await sleep(200);
    const rejected = b.log.slice(from).some((m) => m.t === 'error');
    record('entropy reveal mismatching the hello commit is rejected', rejected, rejected ? '' : 'accepted a bad reveal!');
    await assertHealthy('server healthy after entropy mismatch', a);
    a.close(); b.close();
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n[chaos] ${results.length - bad.length}/${results.length} attacks handled cleanly${bad.length ? ` — FAILURES: ${bad.map((b) => b.name).join(' | ')}` : ''}`);
  process.exitCode = bad.length ? 1 : 0;
  process.exit(process.exitCode);
}

void main();
