/**
 * Identity regression: R15 (identity space), R16 (globe rule — no inferred
 * flags, chosen flag honored), R17 (unique labels at a 4p table), R18 (same-name
 * 1v1 disambiguated consistently, and labels survive a reconnect).
 * See docs/QA-GAME-AUDIT-PROMPT.md §6.
 */
import { WireBot, sleep, tally, sha256 } from './lib/common.mjs';
import { randomBytes } from 'node:crypto';

const t = tally('wire-identity');

// ---------- R15 + R16: guest identity space and the globe rule
{
  const ids = [];
  for (let batch = 0; batch < 6; batch++) {
    const bots = await Promise.all(Array.from({ length: 10 }, () => new WireBot('').connect().catch(() => null)));
    for (const b of bots) if (b?.hello) { ids.push({ name: b.hello.name, flag: b.hello.flag }); b.close(); }
    await sleep(400); // stay under the per-IP connection rate limit
  }
  const names = new Set(ids.map((i) => i.name));
  const flags = new Set(ids.map((i) => i.flag));
  t.check('R15 guest name space is wide', ids.length >= 40 && names.size >= 20, `${names.size} distinct names over ${ids.length} guests`);
  t.check('R16 guests only ever get the globe', flags.size === 1 && flags.has('🌍'), [...flags].join(' '));

  const chosen = new WireBot('Bacta');
  await chosen.connect({ flag: '🇨🇮' });
  t.check('R16 profile-chosen name+flag honored', chosen.hello?.name === 'Bacta' && chosen.hello?.flag === '🇨🇮', `${chosen.hello?.name} ${chosen.hello?.flag}`);
  chosen.close();
}

// ---------- R17: no two seats at a 4p table may share a label (bots included)
{
  let tables = 0, dupes = 0, dedupFired = 0;
  for (let i = 0; i < 10; i++) {
    const four = await Promise.all(Array.from({ length: 4 }, () => new WireBot('').connect().catch(() => null)));
    const live = four.filter(Boolean);
    if (live.length < 4) { live.forEach((b) => b.close()); continue; }
    for (const b of live) b.send({ t: 'queue.join4', stakeCents: 0 });
    const m = await live[0].await((x) => x.t === 'match.found4', 20000, 'match.found4').catch(() => null);
    if (m) {
      tables++;
      const labels = m.players.map((p) => p.name.toLowerCase());
      if (new Set(labels).size !== labels.length) dupes++;
      if (m.players.some((p) => / \d$/.test(p.name))) dedupFired++;
    }
    live.forEach((b) => b.close());
    await sleep(600);
  }
  t.check('R17 no duplicate labels at any 4p table', tables >= 8 && dupes === 0, `${tables} tables, ${dupes} with duplicates, dedup fired on ${dedupFired}`);
}

// ---------- R18: forced same-name 1v1 → distinct labels, both screens agree,
// and the SAME labels come back after a mid-game reconnect (resume).
{
  const host = new WireBot('Imani');
  await host.connect();
  host.send({ t: 'table.create', stake: 0 });
  const created = await host.await((m) => m.t === 'table.created', 8000, 'table.created');
  const guest = new WireBot('Imani');
  await guest.connect();
  guest.send({ t: 'table.join', code: created.code });
  await Promise.all([
    host.await((m) => m.t === 'match.found', 10000, 'mf host'),
    guest.await((m) => m.t === 'match.found', 10000, 'mf guest'),
  ]);
  const hYou = host.match.youName, hOpp = host.match.opponent?.name;
  const gYou = guest.match.youName, gOpp = guest.match.opponent?.name;
  t.check('R18 same-name pair gets distinct labels', hYou && gYou && hYou !== gYou, `"${hYou}" vs "${gYou}"`);
  t.check('R18 both screens agree on the labels', hYou === gOpp && gYou === hOpp);

  // wait for the game to actually start, then drop the guest and resume
  await host.await((m) => m.t === 'game.state', 9000, 'game.state');
  const token = guest.hello.sessionToken;
  guest.close();
  await sleep(800);
  const back = new WireBot('Imani');
  await back.connect({ sessionToken: token });
  const resumed = back.hello?.resumed;
  t.check('R18 reconnect resumes the live game', !!resumed);
  t.check('R18 resume re-sends the SAME labels', resumed?.youName === gYou && resumed?.opponent?.name === gOpp,
    `resumed you="${resumed?.youName}" opp="${resumed?.opponent?.name}"`);
  host.send({ t: 'game.resign' });
  await sleep(400);
  host.close(); back.close();
}

// ---------- server half of R12: a client-sent (persisted) name is echoed stable
{
  const first = new WireBot('');
  await first.connect();
  const assigned = first.hello?.name;
  first.close();
  // the CLIENT pins `assigned` to localStorage (UI probe covers that); the server
  // must keep honoring it verbatim when the next hello carries it
  const again = new WireBot(assigned);
  await again.connect();
  t.check('R12 (server half) a carried name is echoed unchanged', again.hello?.name === assigned, `"${assigned}" → "${again.hello?.name}"`);
  again.close();
}

t.done();
