/**
 * E2.2 acceptance test: cutting the network for 20 s mid-game → the game continues.
 * Flow: two clients match at 25c -> client A hard-drops its socket for 20 s
 * (server auto-moves A on clock expiry; disconnection != forfeit) -> A reconnects
 * with its sessionToken -> hello.ok carries the enriched `resumed` (match context
 * + state) -> both clients play to game.over.
 * Works with the in-memory store (no env needed); persistence adds restart survival.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { applyRoll } from '@ludo/game-engine';
import type { GameState, Seat } from '@ludo/game-engine';
import { potCents, type ResumedGame, type ServerMsg } from '@ludo/shared';

const PORT = 8791;
const URL = `ws://localhost:${PORT}`;
const CUT_MS = 20_000;

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

interface Player {
  label: string;
  entropy: string;
  token: string | null;
  seat: Seat | null;
  gameId: string | null;
  state: GameState | null;
  ws: WebSocket | null;
  over: (ServerMsg & { t: 'game.over' }) | null;
  resumed: ResumedGame | null;
}

function makePlayer(label: string): Player {
  return {
    label,
    entropy: randomBytes(16).toString('hex'),
    token: null,
    seat: null,
    gameId: null,
    state: null,
    ws: null,
    over: null,
    resumed: null,
  };
}

function connect(p: Player, joinQueue: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    p.ws = ws;
    const fail = setTimeout(() => reject(new Error(p.label + ': connect timeout')), 15_000);

    const send = (obj: unknown): void => void ws.send(JSON.stringify(obj));

    const act = (): void => {
      if (ws !== p.ws) return; // stale socket after a reconnect
      const st = p.state;
      if (!st || p.seat === null || st.winner !== null || st.turn !== p.seat) return;
      if (st.phase === 'awaiting-roll') setTimeout(() => send({ t: 'game.roll' }), 25);
      else if (st.phase === 'awaiting-move' && st.legal.length > 0)
        setTimeout(() => send({ t: 'game.move', token: st.legal[0] }), 25);
    };

    ws.on('open', () => {
      send({ t: 'hello', entropy: p.entropy, sessionToken: p.token ?? undefined });
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      switch (msg.t) {
        case 'hello.ok':
          p.token = msg.sessionToken;
          if (msg.resumed) {
            p.resumed = msg.resumed;
            p.seat = msg.resumed.seat;
            p.state = msg.resumed.state;
            act();
          }
          if (joinQueue) send({ t: 'queue.join', stake: 25 });
          clearTimeout(fail);
          resolve();
          break;
        case 'match.found':
          p.seat = msg.seat;
          p.gameId = msg.gameId;
          break;
        case 'game.state':
        case 'game.moved':
          p.state = msg.state;
          act();
          break;
        case 'game.dice':
          if (p.state && p.state.phase === 'awaiting-roll') {
            try {
              p.state = applyRoll(p.state, msg.value);
            } catch {
              /* resync via next game.moved */
            }
            act();
          }
          break;
        case 'game.turn':
          act();
          break;
        case 'game.over':
          p.over = msg;
          break;
        default:
          break;
      }
    });

    ws.on('error', (e) => {
      clearTimeout(fail);
      reject(new Error(p.label + ': ' + String(e)));
    });
  });
}

async function waitFor(cond: () => boolean, what: string, ms = 90_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for ' + what);
    await sleep(50);
  }
}

const server = startServer();
await waitHealthy();

// ---------- phase 1: match and play a little ----------

const a = makePlayer('A');
const b = makePlayer('B');
await connect(a, true);
await connect(b, true);
await waitFor(() => a.gameId !== null && b.gameId !== null, 'match.found');
const gameId = a.gameId!;
console.log('[reconnect-test] game started:', gameId);
await sleep(800);

// ---------- phase 2: A loses network for 20 s ----------

a.ws?.terminate(); // act() ignores this stale socket once connect() replaces it
console.log(`[reconnect-test] A disconnected for ${CUT_MS / 1000}s (B stays in game)…`);
await sleep(CUT_MS);

if (b.over) {
  console.error('FAIL: game ended during a 20 s disconnection (should continue, not forfeit)');
  server.kill('SIGKILL');
  process.exit(1);
}

// ---------- phase 3: A reconnects with its token ----------

await connect(a, false);
if (!a.resumed || a.resumed.gameId !== gameId) {
  console.error(`FAIL: expected resumed game ${gameId}, got ${a.resumed?.gameId ?? 'none'}`);
  server.kill('SIGKILL');
  process.exit(1);
}
if (a.resumed.stakeCents !== 25 || a.resumed.potCents !== potCents(25) || !a.resumed.opponent.name) {
  console.error('FAIL: resumed payload missing match context:', JSON.stringify(a.resumed));
  server.kill('SIGKILL');
  process.exit(1);
}
console.log('[reconnect-test] A resumed with full match context (opponent:', a.resumed.opponent.name + ')');

// ---------- phase 4: the game plays out to game.over for both ----------

await waitFor(() => a.over !== null && b.over !== null, 'game.over', 120_000);
console.log(
  `[reconnect-test] game.over: winner=${a.over!.winner} reason=${a.over!.reason} ` +
    `payout=${a.over!.payoutCents}c rake=${a.over!.rakeCents}c`,
);

a.ws?.close();
b.ws?.close();
server.kill('SIGTERM');
console.log('RECONNECT-TEST OK — a 20 s network cut mid-game does not kill the game.');
process.exit(0);
