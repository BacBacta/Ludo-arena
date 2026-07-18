/**
 * R-WEB-1 (4-player reconnect) wiring probe. A 4p player who drops can reconnect
 * with their session token and the server reattaches them to their live seat
 * (game.state4 resync) instead of ending the session. Uses a FREE table (staked
 * 4p is server-gated); this proves the resume→Room4.attach wiring end-to-end over
 * the real socket. The staked-only GRACE (a dropped staker keeps their seat rather
 * than an instant bot-forfeit) is covered by apps/server/test/room4.test.ts.
 *
 * Run against a local server: `node e2e/wire-reconnect4.mjs` (SRV to override).
 */
import { WireBot, tally, sleep } from './lib/common.mjs';

const t = tally('wire-reconnect4');

const a = new WireBot('A');
await a.connect();
a.send({ t: 'queue.join4', stakeCents: 0 });
const b = new WireBot('B');
await b.connect();
b.send({ t: 'queue.join4', stakeCents: 0 });

const m = await a.await((x) => x.t === 'match.found4', 30000, 'match.found4');
const token = a.hello.sessionToken;
t.check('A is in a 4p game with a session token', !!m && !!token, token);

// Simulate a mid-game network drop.
a.close();
await sleep(500);

// Reconnect with the SAME token and NO queue.join4 — the server must reattach us.
const a2 = new WireBot('A');
await a2.connect({ sessionToken: token });
const st = await a2.await((x) => x.t === 'game.state4', 10000, 'state4 after reconnect').catch(() => null);
t.check('reconnect with token → server resends game.state4 (reattached)', !!st);

a2.close();
b.close();
t.done();
