/**
 * E-social 2 acceptance: friends & challenges. Two MiniPay-proven clients:
 * A requests B (B gets a live friends.update), B reciprocates (mutual), A
 * challenges B (A gets table.created, B gets the LIVE friend.challenge.offer),
 * B joins the offered code → both get match.found. Also asserts an unproven
 * session cannot friend.add and a non-friend cannot be challenged.
 * In-memory store (no infra). Run: npm run friends-test -w apps/server
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type { FriendInfo, ServerMsg } from '@ludo/shared';

const PORT = 8796;
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
  pid: string | null;
  proven: boolean;
  friends: FriendInfo[];
  requests: FriendInfo[];
  added: (ServerMsg & { t: 'friend.added' }) | null;
  offer: (ServerMsg & { t: 'friend.challenge.offer' }) | null;
  code: string | null;
  matched: boolean;
  error: string | null;
  send(o: unknown): void;
}

function open(wallet?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c: Client = { ws, pid: null, proven: false, friends: [], requests: [], added: null, offer: null, code: null, matched: false, error: null, send: (o) => ws.send(JSON.stringify(o)) };
    const timer = setTimeout(() => reject(new Error('open timeout')), 10_000);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      if (msg.t === 'hello.ok') {
        c.pid = msg.pid ?? null;
        c.proven = !!msg.walletProven;
        if (msg.friends) c.friends = msg.friends;
        if (msg.friendRequests) c.requests = msg.friendRequests;
        clearTimeout(timer);
        resolve(c);
      }
      if (msg.t === 'friends.update') {
        c.friends = msg.friends;
        c.requests = msg.requests;
      }
      if (msg.t === 'friend.added') c.added = msg;
      if (msg.t === 'friend.challenge.offer') c.offer = msg;
      if (msg.t === 'table.created') c.code = msg.code;
      if (msg.t === 'match.found') c.matched = true;
      if (msg.t === 'error') c.error = msg.code;
    });
    ws.on('open', () => {
      c.send({ t: 'hello', entropy: randomBytes(16).toString('hex'), wallet, miniPay: !!wallet, name: wallet ? `P${wallet.slice(-4)}` : undefined });
    });
    ws.on('error', reject);
  });
}

function fail(msg: string, server: ChildProcess): never {
  console.error('FAIL:', msg);
  server.kill('SIGKILL');
  process.exit(1);
}

const server = startServer();
await waitHealthy();

const WALLET_A = '0x' + 'a1'.repeat(20);
const WALLET_B = '0x' + 'b2'.repeat(20);

const a = await open(WALLET_A);
const b = await open(WALLET_B);
if (!a.pid || !a.proven || !b.pid || !b.proven) fail(`expected two proven sessions (a=${a.proven} b=${b.proven})`, server);
console.log('[friends-test] two MiniPay-proven sessions with pids');

// Unproven guest cannot touch the graph.
const guest = await open(undefined);
guest.send({ t: 'friend.add', pid: b.pid });
await sleep(300);
if (guest.error !== 'BAD_STATE') fail(`expected BAD_STATE for unproven friend.add, got ${guest.error}`, server);
guest.ws.close();
console.log('[friends-test] unproven session refused friend.add');

// Challenging a NON-friend is refused.
a.send({ t: 'friend.challenge', pid: b.pid, stake: 0 });
await sleep(1200); // > the 1/s friend.* throttle, so the next add isn't dropped
if (a.error !== 'BAD_STATE') fail(`expected BAD_STATE challenging a non-friend, got ${a.error}`, server);
a.error = null;
console.log('[friends-test] challenge to a non-friend refused');

// Gifting a NON-friend is refused too (phase 2: gifts are a bond, not spam).
await sleep(1100); // clear the friend.* throttle window
a.send({ t: 'friend.gift', pid: b.pid, id: 'tok-wax' });
await sleep(500);
if (a.error !== 'BAD_STATE') fail(`expected BAD_STATE gifting a non-friend, got ${a.error}`, server);
a.error = null;
console.log('[friends-test] gift to a non-friend refused');

await sleep(700); // finish clearing the throttle before the add below

// A requests B → B (live) sees the request.
a.send({ t: 'friend.add', pid: b.pid });
await sleep(500);
if (a.added?.status !== 'requested') fail(`expected friend.added 'requested', got ${JSON.stringify(a.added)}`, server);
if (!b.requests.some((r) => r.pid === a.pid)) fail(`B should see A's request live, got ${JSON.stringify(b.requests)}`, server);
console.log("[friends-test] request delivered live to B's session");

// B reciprocates → mutual, both lists updated, presence visible.
b.send({ t: 'friend.add', pid: a.pid });
await sleep(500);
if (b.added?.status !== 'friends') fail(`expected friend.added 'friends', got ${JSON.stringify(b.added)}`, server);
const bInA = a.friends.find((f) => f.pid === b.pid);
if (!bInA) fail(`A should now list B as a friend, got ${JSON.stringify(a.friends)}`, server);
if (bInA.online !== true) fail(`B has a live session — A must see online:true, got ${JSON.stringify(bInA)}`, server);
console.log('[friends-test] mutual friendship + presence snapshot');

// Gift to a MUTUAL friend passes every gate up to the spend — and a fresh
// account holds 0 tickets, so the server must refuse with LIMIT_REACHED
// (the positive spend→own→push composition is covered by the store tests).
await sleep(1100); // clear the friend.* throttle window
a.send({ t: 'friend.gift', pid: b.pid, id: 'tok-wax' });
await sleep(500);
if (a.error !== 'LIMIT_REACHED') fail(`expected LIMIT_REACHED gifting with 0 tickets, got ${a.error}`, server);
a.error = null;
console.log('[friends-test] mutual gift reaches the ticket spend (0 tickets → refused)');

// A challenges B (free): A gets the table code, B gets the LIVE offer.
await sleep(1100); // clear the friend.* throttle window
a.send({ t: 'friend.challenge', pid: b.pid, stake: 0 });
await sleep(600);
if (!a.code) fail('A should receive table.created for the challenge', server);
if (b.offer?.code !== a.code) fail(`B should receive the live offer for ${a.code}, got ${JSON.stringify(b.offer)}`, server);
if (b.offer.from.pid !== a.pid) fail('offer.from must identify the challenger', server);
console.log('[friends-test] challenge → table.created (A) + live offer (B)');

// B accepts by joining the offered code → both matched.
b.send({ t: 'table.join', code: b.offer.code });
await sleep(1500);
if (!a.matched || !b.matched) fail(`both should reach match.found (a=${a.matched} b=${b.matched})`, server);
console.log('[friends-test] offer accepted → match.found on both sides');

a.ws.close();
b.ws.close();
server.kill('SIGTERM');
console.log('FRIENDS-TEST OK — request, mutual consent, presence, live challenge, accepted duel, gift gates.');
process.exit(0);
