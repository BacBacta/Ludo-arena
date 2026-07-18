/**
 * E5.4 acceptance: geo-gating (allowlist). With STAKING_ALLOWED_COUNTRIES=AA, a
 * client whose CDN country header is ZZ (not on the allowlist) gets
 * stakingBlocked=true in hello.ok, is refused a staked queue.join
 * (LIMIT_REACHED), but may still queue a free (stake 0) game.
 * In-memory store. Run: npm run geo-test -w apps/server
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type { ServerMsg } from '@ludo/shared';

const PORT = 8794;
const URL = `ws://localhost:${PORT}`;

function startServer(): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, PORT: String(PORT), REDIS_URL: '', DATABASE_URL: '', STAKING_ALLOWED_COUNTRIES: 'AA' },
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

function fail(msg: string, server: ChildProcess): never {
  console.error('FAIL:', msg);
  server.kill('SIGKILL');
  process.exit(1);
}

const server = startServer();
await waitHealthy();

const ws = new WebSocket(URL, { headers: { 'x-country': 'ZZ' } });
const state = { stakingBlocked: undefined as boolean | undefined, error: null as string | null, queuedFree: false };
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString()) as ServerMsg;
  if (msg.t === 'hello.ok') state.stakingBlocked = msg.stakingBlocked;
  if (msg.t === 'error') state.error = msg.code;
  if (msg.t === 'queue.ok') state.queuedFree = true;
});
await new Promise<void>((resolve, reject) => {
  ws.on('open', () => resolve());
  ws.on('error', reject);
});

const send = (o: unknown): void => ws.send(JSON.stringify(o));
send({ t: 'hello', entropy: randomBytes(16).toString('hex') });
await sleep(300);
if (state.stakingBlocked !== true) fail(`expected stakingBlocked=true, got ${state.stakingBlocked}`, server);
console.log('[geo-test] hello.ok reports stakingBlocked=true for a blocked region');

// staked join refused
send({ t: 'queue.join', stake: 25 });
await sleep(300);
if (state.error !== 'LIMIT_REACHED') fail(`expected LIMIT_REACHED for staked join, got ${state.error}`, server);
console.log('[geo-test] staked queue.join refused with LIMIT_REACHED');

// free join allowed
state.error = null;
send({ t: 'queue.join', stake: 0 });
await sleep(400);
if (!state.queuedFree || state.error) fail(`expected free join to be allowed (queuedFree=${state.queuedFree} error=${state.error})`, server);
console.log('[geo-test] free (stake 0) queue.join allowed');

ws.close();
server.kill('SIGTERM');
console.log('GEO-TEST OK — staked play blocked in a gated region, free practice allowed.');
process.exit(0);
