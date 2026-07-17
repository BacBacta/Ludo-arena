/**
 * Money-mode boundaries (no real funds involved): every staked/ticketed entry
 * refused for the RIGHT reason, with a clean message, and the session must stay
 * fully usable afterwards. Covers the testable frontiers of M3/M4/M6/M9.
 * See docs/QA-GAME-AUDIT-PROMPT.md §3 « Modes stakés ».
 *
 * NOTE all waits use log-index marks (bot.mark/awaitFrom): timestamp filters
 * miss replies that land in the same millisecond as the send.
 */
import { WireBot, WebSocket, SRV, tally } from './lib/common.mjs';

const t = tally('wire-gates');

const nextError = (bot, from, ms = 5000) =>
  bot.awaitFrom(from, (m) => m.t === 'error', ms, 'error').catch(() => null);

// ---------- M3: staked 1v1 queue without consent/wallet → refused, then free works
{
  const bot = new WireBot('GateM3');
  await bot.connect();
  let mark = bot.mark();
  bot.send({ t: 'queue.join', stake: 25 });
  const err = await nextError(bot, mark);
  t.check('M3 staked queue refused without consent/wallet', !!err, err?.message);
  // `QA sessions cannot join staked queues` is a legitimate gate too, and with a
  // QA_KEY in SRV (how this harness runs against a shared server) it is the FIRST
  // one reached — the consent/wallet gate below it is then unreachable, so the
  // check failed for the harness's own reason rather than a server one.
  t.check('M3 refusal names the actual gate', /terms|18|wallet|region|unavailable|qa/i.test(err?.message ?? ''), err?.message);
  mark = bot.mark();
  bot.send({ t: 'queue.join', stake: 0 });
  const ok = await bot.awaitFrom(mark, (m) => m.t === 'queue.ok', 5000, 'queue.ok').catch(() => null);
  t.check('M3 session usable after the refusal (free queue ok)', !!ok);
  bot.send({ t: 'queue.leave' });
  bot.close();
}

// ---------- M4: freeroll without a ticket → LIMIT_REACHED, session usable
{
  const bot = new WireBot('GateM4');
  await bot.connect();
  const held = bot.hello?.challenge?.tickets ?? 0;
  t.check('M4 a fresh guest starts with zero tickets', held === 0, `tickets=${held}`);
  let mark = bot.mark();
  bot.send({ t: 'queue.join', stake: 0, freeroll: true });
  const err = await nextError(bot, mark);
  t.check('M4 freeroll refused without a ticket', err?.code === 'LIMIT_REACHED' && /ticket/i.test(err?.message ?? ''), `${err?.code}: ${err?.message}`);
  mark = bot.mark();
  bot.send({ t: 'queue.join', stake: 0 });
  const ok = await bot.awaitFrom(mark, (m) => m.t === 'queue.ok', 5000, 'queue.ok').catch(() => null);
  t.check('M4 session usable after the refusal', !!ok);
  bot.send({ t: 'queue.leave' });
  bot.close();
}

// ---------- M6: staked private table without consent/wallet → refused; free create works
{
  const bot = new WireBot('GateM6');
  await bot.connect();
  let mark = bot.mark();
  bot.send({ t: 'table.create', stake: 100 });
  const err = await nextError(bot, mark);
  t.check('M6 staked table.create refused', !!err, err?.message);
  mark = bot.mark();
  bot.send({ t: 'table.create', stake: 0 });
  const created = await bot.awaitFrom(mark, (m) => m.t === 'table.created', 5000, 'table.created').catch(() => null);
  t.check('M6 free table.create still works right after', !!created, created?.code);
  bot.close();
}

// ---------- M9: staked 4p queue → refused cleanly (whatever the active gate);
// the free 4p queue must remain available on the same session
{
  const bot = new WireBot('GateM9');
  await bot.connect();
  let mark = bot.mark();
  bot.send({ t: 'queue.join4', stakeCents: 100 });
  const err = await nextError(bot, mark);
  t.check('M9 staked 4p queue refused cleanly', !!err, `${err?.code}: ${err?.message}`);
  mark = bot.mark();
  bot.send({ t: 'queue.join4', stakeCents: 0 });
  const ok = await bot.awaitFrom(mark, (m) => m.t === 'queue.ok' || m.t === 'match.found4', 6000, 'free 4p accepted').catch(() => null);
  t.check('M9 session usable after the refusal (free 4p ok)', !!ok);
  bot.send({ t: 'queue.leave' });
  bot.close();
}

// ---------- staked pairing also requires the fairness commit (anti-grinding):
// a LEGACY hello (raw entropy, no commit) must not open staked play
{
  const bot = new WireBot('GateLegacy', { autoReveal: false });
  // hand-roll the hello: RAW entropy, no commit — the legacy compatibility path
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('legacy hello timeout')), 8000);
    const ws = new WebSocket(SRV);
    bot.ws = ws;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', entropy: 'legacy-raw-entropy-0123456789abcdef' })));
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(String(d)); } catch { return; }
      m.at = Date.now();
      bot.log.push(m);
      if (m.t === 'hello.ok') { bot.hello = m; clearTimeout(to); resolve(); }
      bot.onMessage?.(m);
    });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
  t.check('legacy hello (raw entropy, no commit) still connects', !!bot.hello);
  const mark = bot.mark();
  bot.send({ t: 'queue.join', stake: 25 });
  const err = await nextError(bot, mark);
  t.check('staked play refused on a commit-less session', !!err, err?.message);
  bot.close();
}

t.done();
