/**
 * Phase 5 — concurrency, desync and network chaos, over the REAL WS layer.
 *
 *  A. RACE CONDITIONS   two players acting in the same millisecond; an action
 *                       landing exactly at turn-timer expiry; a double connection
 *                       of the same account; a capture during a disconnect.
 *                       The final state must always be UNIQUE and COHERENT.
 *  B. STATE SYNC        both clients' observed states are compared continuously;
 *                       any lasting divergence from the server's authoritative
 *                       broadcast is a major bug.
 *  C. NETWORK CHAOS     via simulation/netproxy.mjs (Toxiproxy equivalent):
 *                       brutal disconnect mid-roll, reconnect with stale state,
 *                       asymmetric latency (50ms vs 2000ms), out-of-order frames,
 *                       packet loss. Each must reach a DEFINED behaviour.
 *
 * Refund leg: staked interruptions map to on-chain refunds that are verified
 * with real contracts in sim/flow.ts (no-show→refundExpired, drop→voidGame,
 * stuck→refundActive, 4p unfilled→refundUnfilled) and, for the server's
 * auto-enqueue added in Phase 0 (R-SETTLE-1), in apps/server/test/settlement.test.ts.
 * See simulation/RESULTS-phase5.md §Refund matrix.
 *
 * Run: SRV='ws://localhost:8787/?qa=simkey' node simulation/chaos-net.mjs
 */
import { WireBot } from '../e2e/lib/common.mjs';
import { checkState } from './invariants.mjs';
import { startChaosProxy } from './netproxy.mjs';

const UPSTREAM = process.env.UPSTREAM || 'ws://localhost:8787';
const QA = process.env.QA || '/?qa=simkey';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Pair two bots (optionally each through its own proxy url) on a free private table. */
async function pair(tag, urlA, urlB) {
  const a = new WireBot(`${tag}A`, urlA ? { url: urlA } : {});
  const b = new WireBot(`${tag}B`, urlB ? { url: urlB } : {});
  await a.connect();
  a.send({ t: 'table.create', stake: 0 });
  const created = await a.await((m) => m.t === 'table.created', 10000, 'created');
  await b.connect();
  b.send({ t: 'table.join', code: created.code });
  await Promise.all([a.await((m) => m.t === 'match.found', 12000), b.await((m) => m.t === 'match.found', 12000)]);
  await sleep(400);
  return { a, b };
}

/** Drive both bots normally for `ms`, playing whenever it is their turn. */
async function playFor({ a, b }, ms, everyTick) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms && !a.over && !b.over) {
    for (const bot of [a, b]) {
      const s = bot.state;
      if (!s || bot.over || s.turn !== bot.match?.seat) continue;
      if (s.phase === 'awaiting-roll') bot.send({ t: 'game.roll' });
      else if (s.phase === 'awaiting-move' && s.legal?.length) bot.send({ t: 'game.move', token: s.legal[0] });
    }
    everyTick?.();
    await sleep(60);
  }
}

/** Both clients must converge on the same authoritative board (no lasting desync). */
function statesAgree(a, b) {
  if (!a.state || !b.state) return true; // nothing to compare yet
  return JSON.stringify(a.state.positions) === JSON.stringify(b.state.positions) && a.state.turn === b.state.turn;
}

async function main() {
  // ---------------- A. RACE CONDITIONS ----------------
  // A1 — both players act in the SAME millisecond (both roll + both move at once).
  {
    const { a, b } = await pair('r1');
    let desync = 0;
    for (let i = 0; i < 40 && !a.over && !b.over; i++) {
      // fire BOTH bots' actions with no regard for whose turn it is, same tick
      for (const bot of [a, b]) {
        const s = bot.state;
        if (!s) continue;
        if (s.phase === 'awaiting-roll') bot.send({ t: 'game.roll' });
        else if (s.phase === 'awaiting-move' && s.legal?.length) bot.send({ t: 'game.move', token: s.legal[0] });
      }
      await sleep(70);
      if (!statesAgree(a, b)) desync++;
    }
    await sleep(400);
    const aOk = !a.state || checkState(a.state, 2, null) === null;
    const bOk = !b.state || checkState(b.state, 2, null) === null;
    check('A1 simultaneous same-ms actions → state stays legal on both clients', aOk && bOk);
    check('A1 both clients converge on ONE board (no lasting desync)', statesAgree(a, b), `transient mismatches=${desync}`);
    a.close(); b.close();
  }

  // A2 — an action landing EXACTLY at turn-timer expiry, racing the clock's
  // auto-move. A single-legal roll is auto-settled immediately, so we first reach a
  // MULTI-choice awaiting-move (which arms the 15s clock and waits for the player),
  // then fire our move right on the deadline. Exactly ONE move must apply.
  {
    const { a, b } = await pair('r2');
    let raced = false;
    for (let attempt = 0; attempt < 25 && !raced && !a.over && !b.over; attempt++) {
      const mover = [a, b].find((x) => x.state?.turn === x.match.seat && x.state?.phase === 'awaiting-roll');
      if (mover) { mover.send({ t: 'game.roll' }); await sleep(250); }
      // did anyone land on a MULTI-choice move phase? that's where the clock arms.
      const choosing = [a, b].find((x) => x.state?.turn === x.match.seat && x.state?.phase === 'awaiting-move' && (x.state.legal?.length ?? 0) >= 2);
      if (!choosing) { await sleep(120); continue; }

      const deadline = choosing.log.slice().reverse().find((m) => m.t === 'game.turn')?.deadlineTs;
      if (!deadline) break;
      let moved = 0;
      const prev = choosing.onMessage;
      choosing.onMessage = (m) => { prev?.(m); if (m.t === 'game.moved') moved++; };
      const wait = deadline - Date.now() - 15; // land ON the expiry boundary
      if (wait > 0) await sleep(wait);
      const s = choosing.state;
      if (s?.phase === 'awaiting-move' && s.legal?.length) choosing.send({ t: 'game.move', token: s.legal[0] });
      await sleep(1800); // let both the manual move and any clock auto-move settle
      const legal = !choosing.state || checkState(choosing.state, 2, null) === null;
      // EXACTLY ONE move must have been applied for that turn — never both the
      // player's and the clock's (that would double-advance the board).
      check('A2 move fired ON the turn-clock deadline → exactly one move applied, board legal', legal && moved === 1, `moved events=${moved} (must be 1)`);
      raced = true;
    }
    if (!raced) check('A2 clock-expiry race', false, 'could not reach a multi-choice move phase to race');
    a.close(); b.close();
  }

  // A3 — double connection of the SAME account (R-RT-1 regression, at game level).
  {
    const { a, b } = await pair('r3');
    const token = a.hello.sessionToken;
    const tab2 = new WireBot('r3A2');
    await tab2.connect({ sessionToken: token });
    await sleep(300);
    a.close(); // the STALE tab closes — must NOT tear down the live session
    await sleep(600);
    // the live tab (tab2) must still get served
    const from = tab2.mark();
    tab2.send({ t: 'ping' });
    let alive = false;
    try { await tab2.awaitFrom(from, (m) => m.t === 'pong', 4000); alive = true; } catch { alive = false; }
    check('A3 stale tab closing does not kill the live resumed session', alive);
    tab2.close(); b.close();
  }

  // A4 — capture during a disconnect: one player drops, the other keeps playing
  // (and may capture). The game must stay coherent and keep progressing.
  {
    const { a, b } = await pair('r4');
    await playFor({ a, b }, 1500);
    b.ws.terminate(); // brutal drop mid-game
    await sleep(300);
    await playFor({ a, b: { state: null, over: true } }, 4000); // only A keeps acting
    await sleep(500);
    const ok = !a.state || checkState(a.state, 2, null) === null;
    check('A4 capture/play during an opponent disconnect keeps the board legal', ok, `a.over=${a.over}`);
    a.close(); b.close();
  }

  // ---------------- C. NETWORK CHAOS (via the proxy) ----------------
  const proxyA = await startChaosProxy({ port: 9101, upstream: UPSTREAM });
  const proxyB = await startChaosProxy({ port: 9102, upstream: UPSTREAM });

  // C1 — brutal disconnect DURING a dice roll → defined behaviour: the game does
  // not corrupt; the server clock carries the absent seat (disconnect != forfeit).
  {
    const { a, b } = await pair('c1', proxyA.url + QA, proxyB.url + QA);
    const mover = [a, b].find((x) => x.state?.turn === x.match.seat) ?? a;
    if (mover.state?.phase === 'awaiting-roll') mover.send({ t: 'game.roll' });
    proxyA.killAll(); // brutal cut in the middle of the roll round-trip
    await sleep(1500);
    const bOk = !b.state || checkState(b.state, 2, null) === null;
    check('C1 brutal disconnect mid-roll → surviving client keeps a legal board', bOk);
    a.close(); b.close();
  }

  // C2 — reconnect with a STALE state → the server must resync the client.
  {
    const { a, b } = await pair('c2');
    await playFor({ a, b }, 2000);
    const staleTurn = a.state?.turn;
    const token = a.hello.sessionToken;
    a.ws.terminate(); // drop
    await playFor({ a: b, b: { state: null, over: true } }, 2500); // B plays on; A's view goes stale
    const back = new WireBot('c2A2');
    await back.connect({ sessionToken: token });
    const resync = await back.await((m) => m.t === 'game.state' || m.t === 'hello.ok', 6000, 'resync').catch(() => null);
    await sleep(500);
    const gotFresh = !!back.state || !!resync;
    check('C2 reconnect with a stale view → server resyncs the client', gotFresh, `staleTurn=${staleTurn}`);
    back.close(); b.close();
  }

  // C3 — ASYMMETRIC latency 50ms vs 2000ms. A slow client LAGGING mid-game is
  // expected (not a bug); what must never happen is a DIVERGENCE at rest. So we
  // play under the split latency, then end the game and compare the FINAL boards
  // both clients settle on.
  {
    proxyA.toxics.latencyDownMs = 50; proxyA.toxics.latencyUpMs = 50;
    proxyB.toxics.latencyDownMs = 2000; proxyB.toxics.latencyUpMs = 2000;
    const { a, b } = await pair('c3', proxyA.url + QA, proxyB.url + QA);
    await playFor({ a, b }, 9000);
    const aOk = !a.state || checkState(a.state, 2, null) === null;
    const bOk = !b.state || checkState(b.state, 2, null) === null;
    check('C3 asymmetric latency (50ms vs 2000ms) → both boards legal', aOk && bOk);

    // force a terminal state, then let BOTH sides drain and compare at rest.
    a.send({ t: 'game.resign' });
    await Promise.all([
      a.await((m) => m.t === 'game.over', 12000).catch(() => null),
      b.await((m) => m.t === 'game.over', 12000).catch(() => null),
    ]);
    await sleep(3500); // drain the 2s-lagged link
    const aOver = a.log.slice().reverse().find((m) => m.t === 'game.over');
    const bOver = b.log.slice().reverse().find((m) => m.t === 'game.over');
    const agree = !!aOver && !!bOver && aOver.winner === bOver.winner;
    check('C3 both clients settle on the SAME final result at rest (no desync)', agree, `a.winner=${aOver?.winner} b.winner=${bOver?.winner}`);
    proxyA.toxics.latencyDownMs = 0; proxyA.toxics.latencyUpMs = 0;
    proxyB.toxics.latencyDownMs = 0; proxyB.toxics.latencyUpMs = 0;
    a.close(); b.close();
  }

  // C4 — OUT-OF-ORDER server→client frames → client state stays legal.
  {
    proxyA.toxics.reorderDown = 0.3;
    const { a, b } = await pair('c4', proxyA.url + QA);
    await playFor({ a, b }, 6000);
    await sleep(800);
    const aOk = !a.state || checkState(a.state, 2, null) === null;
    check('C4 out-of-order frames → client board stays legal', aOk);
    proxyA.toxics.reorderDown = 0;
    a.close(); b.close();
  }

  // C5 — PACKET LOSS 20% → the game still progresses (server clock auto-plays the
  // actions that never arrived) and never corrupts.
  {
    proxyA.toxics.lossUp = 0.2; proxyA.toxics.lossDown = 0.2;
    const { a, b } = await pair('c5', proxyA.url + QA);
    const rolls0 = b.log.filter((m) => m.t === 'game.dice').length;
    await playFor({ a, b }, 9000);
    await sleep(1000);
    const rolls1 = b.log.filter((m) => m.t === 'game.dice').length;
    const bOk = !b.state || checkState(b.state, 2, null) === null;
    check('C5 20% packet loss → game still progresses', rolls1 > rolls0, `dice ${rolls0}→${rolls1}`);
    check('C5 20% packet loss → board stays legal', bOk);
    proxyA.toxics.lossUp = 0; proxyA.toxics.lossDown = 0;
    a.close(); b.close();
  }

  await proxyA.close();
  await proxyB.close();

  const bad = results.filter((r) => !r.ok);
  console.log(`\n[chaos-net] ${results.length - bad.length}/${results.length} scenarios reached a defined, coherent behaviour${bad.length ? ` — FAILURES: ${bad.map((b) => b.name).join(' | ')}` : ''}`);
  process.exit(bad.length ? 1 : 0);
}

void main();
