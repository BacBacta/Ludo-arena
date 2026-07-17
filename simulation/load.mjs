/**
 * WebSocket load test (Phase 6). Holds N SIMULTANEOUS full games over the real
 * protocol and measures the budget the brief asks for:
 *   - action latency p95 < 300 ms   (game.roll → the server's game.dice for it)
 *   - no errors                     (server error frames / failed connections)
 *   - no message loss               (a roll that never gets its dice back)
 *
 * k6/Artillery are not used: this stack's "action" is a game move inside a
 * stateful protocol (hello + entropy commit-reveal + private-table pairing before
 * a single roll is legal), so a generic WS load script would have to reimplement
 * the whole client. This harness drives the REAL client protocol (the same WireBot
 * the e2e suite uses) and therefore measures true end-to-end action latency.
 *
 * Usage: SRV='ws://localhost:8787/?qa=simkey' node simulation/load.mjs [GAMES=500] [HOLD_S=30]
 */
import { WireBot } from '../e2e/lib/common.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function main() {
  const GAMES = Number(process.argv[2] || 500);
  const HOLD_S = Number(process.argv[3] || 30);

  const lat = []; // action latency samples (ms): roll → dice
  const stats = { games: 0, paired: 0, errors: 0, connFail: 0, rolls: 0, dice: 0, lost: 0, over: 0 };
  const live = [];

  /** One game: pair, then loop rolling/moving, timing each roll→dice round-trip. */
  async function runGame(i) {
    const a = new WireBot(`L${i}a`);
    const b = new WireBot(`L${i}b`);
    const pend = new Map(); // seat → send ts of an un-answered roll
    try {
      await a.connect();
      a.send({ t: 'table.create', stake: 0 });
      const created = await a.await((m) => m.t === 'table.created', 20000, 'created');
      await b.connect();
      b.send({ t: 'table.join', code: created.code });
      await Promise.all([a.await((m) => m.t === 'match.found', 25000), b.await((m) => m.t === 'match.found', 25000)]);
      stats.paired++;
    } catch {
      stats.connFail++;
      try { a.close(); b.close(); } catch { /* gone */ }
      return;
    }

    for (const bot of [a, b]) {
      const seat = bot.match.seat;
      const prev = bot.onMessage;
      bot.onMessage = (m) => {
        prev?.(m);
        if (m.t === 'error') stats.errors++;
        // the dice frame IS the server's answer to this seat's roll
        if (m.t === 'game.dice' && m.seat === seat) {
          const t0 = pend.get(seat);
          if (t0 !== undefined) { lat.push(Date.now() - t0); pend.delete(seat); stats.dice++; }
        }
        if (m.t === 'game.over') stats.over++;
        if (m.t === 'game.turn' || m.t === 'game.state' || m.t === 'game.moved') act(bot, seat);
      };
    }
    const act = (bot, seat) => {
      if (bot.over || bot.closed) return;
      const s = bot.state;
      if (!s || s.turn !== seat) return;
      if (s.phase === 'awaiting-roll') {
        if (!pend.has(seat)) { pend.set(seat, Date.now()); stats.rolls++; bot.send({ t: 'game.roll' }); }
      } else if (s.phase === 'awaiting-move' && s.legal?.length) {
        bot.send({ t: 'game.move', token: s.legal[0] });
      }
    };
    act(a, a.match.seat); act(b, b.match.seat);
    live.push({ a, b, pend });
    stats.games++;
  }

  // ---- ramp up to GAMES simultaneous games ----
  const t0 = Date.now();
  console.log(`[load] ramping to ${GAMES} simultaneous games…`);
  const BATCH = 50; // open in batches so the ramp itself doesn't self-DoS
  for (let i = 0; i < GAMES; i += BATCH) {
    await Promise.all(Array.from({ length: Math.min(BATCH, GAMES - i) }, (_, k) => runGame(i + k)));
    if ((i / BATCH) % 4 === 0) console.log(`  … ${stats.games} live · paired ${stats.paired} · connFail ${stats.connFail}`);
  }
  const rampS = Math.round((Date.now() - t0) / 1000);
  console.log(`[load] ${stats.games} games live (ramp ${rampS}s) — holding ${HOLD_S}s under load…`);

  // ---- hold and measure ----
  await sleep(HOLD_S * 1000);

  // a roll still un-answered well past the budget = a lost/never-served message
  for (const g of live) for (const [, t0s] of g.pend) if (Date.now() - t0s > 5000) stats.lost++;

  const sorted = [...lat].sort((x, y) => x - y);
  const p50 = pct(sorted, 50), p95 = pct(sorted, 95), p99 = pct(sorted, 99);
  const budgetOk = p95 < 300 && stats.errors === 0 && stats.lost === 0 && stats.connFail === 0;

  console.log(`\n[load] ${stats.games} simultaneous games · ${lat.length} action samples`);
  console.log(`  latency  p50=${p50}ms  p95=${p95}ms  p99=${p99}ms  max=${sorted[sorted.length - 1] ?? 0}ms`);
  console.log(`  rolls=${stats.rolls} dice=${stats.dice} · errors=${stats.errors} · connFail=${stats.connFail} · lost=${stats.lost} · gamesOver=${stats.over}`);
  console.log(`  BUDGET p95<300ms & 0 errors & 0 loss → ${budgetOk ? '✅ PASS' : '❌ FAIL'}`);

  for (const g of live) { try { g.a.close(); g.b.close(); } catch { /* gone */ } }
  process.exit(budgetOk ? 0 : 1);
}

void main();
