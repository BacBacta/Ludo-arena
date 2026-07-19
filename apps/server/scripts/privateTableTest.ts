/**
 * E4.4 acceptance: private tables. A bogus code returns TABLE_NOT_FOUND; a
 * STAKED table refuses a same-IP joiner (the pre-launch anticheat guard — both
 * test sockets come from 127.0.0.1, so this is asserted POSITIVELY, not worked
 * around); a FREE table pairs and plays to game.over. In-memory store (no infra).
 * Run: npm run private-table-test -w apps/server
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { applyRoll } from '@ludo/game-engine';
import type { GameState, Seat } from '@ludo/game-engine';
import { TOS_VERSION, type ServerMsg } from '@ludo/shared';

const PORT = 8793;
const URL = `ws://localhost:${PORT}`;

function startServer(): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, PORT: String(PORT), REDIS_URL: '', DATABASE_URL: '' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/health`)).ok) return;
    } catch {
      /* not up */
    }
    await sleep(100);
  }
  throw new Error('server did not become healthy');
}

interface Client {
  ws: WebSocket;
  seat: Seat | null;
  state: GameState | null;
  over: (ServerMsg & { t: 'game.over' }) | null;
  code: string | null;
  error: string | null;
}

function open(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c: Client = { ws, seat: null, state: null, over: null, code: null, error: null };
    const timer = setTimeout(() => reject(new Error('open timeout')), 10_000);

    const send = (o: unknown): void => ws.send(JSON.stringify(o));
    const act = (): void => {
      const st = c.state;
      if (!st || c.seat === null || st.winner !== null || st.turn !== c.seat) return;
      if (st.phase === 'awaiting-roll') setTimeout(() => send({ t: 'game.roll' }), 20);
      else if (st.phase === 'awaiting-move' && st.legal.length > 0)
        setTimeout(() => send({ t: 'game.move', token: st.legal[0] }), 20);
    };

    ws.on('open', () => {
      clearTimeout(timer);
      // Consent like the real client's legal gate — stakeBlock refuses staked
      // table.create without the current ToS (this test stakes 25¢).
      send({ t: 'hello', entropy: randomBytes(16).toString('hex'), consent: { tosVersion: TOS_VERSION, age18: true } });
      resolve(c);
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      switch (msg.t) {
        case 'table.created':
          c.code = msg.code;
          break;
        case 'match.found':
          c.seat = msg.seat;
          break;
        case 'game.state':
        case 'game.moved':
          c.state = msg.state;
          act();
          break;
        case 'game.dice':
          if (c.state?.phase === 'awaiting-roll') {
            try {
              c.state = applyRoll(c.state, msg.value);
            } catch {
              /* resync */
            }
            act();
          }
          break;
        case 'game.turn':
          act();
          break;
        case 'game.over':
          c.over = msg;
          break;
        case 'error':
          c.error = msg.code;
          break;
        default:
          break;
      }
    });
    ws.on('error', (e) => reject(new Error(String(e))));
  });
}

async function waitFor(cond: () => boolean, what: string, ms = 60_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for ' + what);
    await sleep(30);
  }
}

function fail(msg: string, server: ChildProcess): never {
  console.error('FAIL:', msg);
  server.kill('SIGKILL');
  process.exit(1);
}

const server = startServer();
await waitHealthy();
const send = (c: Client, o: unknown): void => c.ws.send(JSON.stringify(o));

// ---- bogus code → TABLE_NOT_FOUND ----
const bad = await open();
send(bad, { t: 'table.join', code: 'ZZZZZZ' });
await waitFor(() => bad.error !== null, 'error for bad code');
if (bad.error !== 'TABLE_NOT_FOUND') fail(`expected TABLE_NOT_FOUND, got ${bad.error}`, server);
console.log('[private-table-test] bogus code rejected with TABLE_NOT_FOUND');
bad.ws.close();

// ---- STAKED table: creating works, but a same-IP joiner is REFUSED ----
// (E5.3 anticheat: staked pairings between two sockets on the same IP are
// blocked to stop same-network chip-dumping. Both test clients are localhost,
// so the refusal IS the expected behaviour — assert it instead of timing out.)
const stakedHost = await open();
send(stakedHost, { t: 'table.create', stake: 25 });
await waitFor(() => stakedHost.code !== null, 'staked table.created');
console.log('[private-table-test] staked table created, code =', stakedHost.code);

const stakedGuest = await open();
send(stakedGuest, { t: 'table.join', code: stakedHost.code! });
await waitFor(() => stakedGuest.error !== null, 'same-IP staked join refusal');
if (stakedGuest.error !== 'LIMIT_REACHED') fail(`expected LIMIT_REACHED for a same-IP staked join, got ${stakedGuest.error}`, server);
console.log('[private-table-test] same-IP staked join refused (anticheat) ✓');
stakedHost.ws.close();
stakedGuest.ws.close();

// ---- FREE table: create + join + play to the end ----
const host = await open();
send(host, { t: 'table.create', stake: 0 });
await waitFor(() => host.code !== null, 'table.created');
const code = host.code!;
console.log('[private-table-test] free table created, code =', code);

const guest = await open();
send(guest, { t: 'table.join', code });
await waitFor(() => host.seat !== null && guest.seat !== null, 'both matched');
console.log('[private-table-test] friend joined; match started');

await waitFor(() => host.over !== null && guest.over !== null, 'game.over', 120_000);
console.log(
  `[private-table-test] game.over: winner=${host.over!.winner} reason=${host.over!.reason} payout=${host.over!.payoutCents}c`,
);

host.ws.close();
guest.ws.close();
server.kill('SIGTERM');
console.log('PRIVATE-TABLE-TEST OK — create/share/join a private table, play to the end.');
process.exit(0);
