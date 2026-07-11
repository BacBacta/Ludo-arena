/**
 * E2.4 acceptance test: message flood → temporary ban; other IPs unaffected.
 * Flow: a client floods the server with pings -> server drops, then bans the
 * IP and closes the socket -> a new connection from that IP is rejected with
 * LIMIT_REACHED -> a client from another loopback IP (127.0.0.2) still gets
 * a normal hello.ok. Frame-size cap (1 KB) is asserted too.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type { ServerMsg } from '@ludo/shared';

const PORT = 8792;
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
      const res = await fetch(`http://localhost:${PORT}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('server did not become healthy');
}

function fail(msg: string, server: ChildProcess): never {
  console.error('FAIL:', msg);
  server.kill('SIGKILL');
  process.exit(1);
}

const server = startServer();
await waitHealthy();

// ---------- phase 1: flood until banned ----------

const flooder = new WebSocket(URL);
let banned = false;
let closed = false;
flooder.on('message', (data) => {
  const msg = JSON.parse(data.toString()) as ServerMsg;
  if (msg.t === 'error' && msg.code === 'LIMIT_REACHED') banned = true;
});
flooder.on('close', () => {
  closed = true;
});
await new Promise<void>((resolve) => flooder.on('open', () => resolve()));
flooder.send(JSON.stringify({ t: 'hello', entropy: randomBytes(16).toString('hex') }));

// three flood waves ~1 s apart: each drains the bucket → 3 violations → ban
for (let wave = 0; wave < 4 && !closed; wave++) {
  for (let i = 0; i < 400 && flooder.readyState === WebSocket.OPEN; i++) {
    flooder.send(JSON.stringify({ t: 'ping' }));
  }
  await sleep(1_100);
}
if (!banned || !closed) fail(`expected flood ban (banned=${banned} closed=${closed})`, server);
console.log('[abuse-test] flooder banned and disconnected');

// ---------- phase 2: banned IP is rejected on a fresh connection ----------

const retry = new WebSocket(URL);
let rejected = false;
retry.on('message', (data) => {
  const msg = JSON.parse(data.toString()) as ServerMsg;
  if (msg.t === 'error' && msg.code === 'LIMIT_REACHED') rejected = true;
});
await new Promise<void>((resolve) => {
  retry.on('close', () => resolve());
  retry.on('error', () => resolve());
});
if (!rejected) fail('expected LIMIT_REACHED on reconnect from the banned IP', server);
console.log('[abuse-test] banned IP rejected on reconnect');

// ---------- phase 3: another IP still plays normally ----------

// IPv4 URL: a v4 localAddress cannot bind to `localhost` resolving to ::1
const legit = new WebSocket(`ws://127.0.0.1:${PORT}`, { localAddress: '127.0.0.2' });
const legitOk = await new Promise<boolean>((resolve) => {
  const timer = setTimeout(() => resolve(false), 5_000);
  legit.on('open', () =>
    legit.send(JSON.stringify({ t: 'hello', entropy: randomBytes(16).toString('hex') })),
  );
  legit.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as ServerMsg;
    if (msg.t === 'hello.ok') {
      clearTimeout(timer);
      resolve(true);
    }
  });
  legit.on('error', () => resolve(false));
});
if (!legitOk) fail('expected a client from another IP to be unaffected by the ban', server);
console.log('[abuse-test] other IP unaffected');

// ---------- phase 4: oversized frames are rejected (1 KB cap) ----------

const big = new WebSocket(`ws://127.0.0.1:${PORT}`, { localAddress: '127.0.0.3' });
const bigClosed = await new Promise<boolean>((resolve) => {
  const timer = setTimeout(() => resolve(false), 5_000);
  big.on('open', () => big.send(JSON.stringify({ t: 'hello', entropy: 'x'.repeat(4096) })));
  big.on('close', () => {
    clearTimeout(timer);
    resolve(true);
  });
  big.on('error', () => {
    /* 'close' follows */
  });
});
if (!bigClosed) fail('expected the connection to drop on a >1 KB frame', server);
try {
  const health = await fetch(`http://localhost:${PORT}/health`);
  if (!health.ok) throw new Error(String(health.status));
} catch {
  fail('server died on an oversized frame (must drop the connection, not crash)', server);
}
console.log('[abuse-test] oversized frame dropped the connection, server still healthy');

legit.close();
server.kill('SIGTERM');
console.log('ABUSE-TEST OK — flood => temporary ban; other IPs and frame cap intact.');
process.exit(0);
