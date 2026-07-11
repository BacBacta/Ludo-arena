/**
 * E2.1 acceptance test: a server restart does not kill an in-progress game.
 * Flow: start server -> two clients match at 25c -> play a bit -> SIGKILL the
 * server -> restart it -> both clients reconnect with their sessionToken ->
 * hello.ok carries `resumed` with the same gameId -> the game plays to game.over.
 * Requires REDIS_URL + DATABASE_URL (docker compose up -d at the repo root).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { applyRoll } from '@ludo/game-engine';
import type { GameState, Seat } from '@ludo/game-engine';
import type { ServerMsg } from '@ludo/shared';

const PORT = 8790;
const URL = `ws://localhost:${PORT}`;

if (!process.env.REDIS_URL || !process.env.DATABASE_URL) {
  console.error('restart-test needs REDIS_URL and DATABASE_URL (docker compose up -d).');
  process.exit(1);
}

function startServer(): ChildProcess {
  // Direct node child (no npx/shell wrapper) so SIGKILL reaches the server itself.
  return spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    env: { ...process.env, PORT: String(PORT) },
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
  over: ServerMsg & { t: 'game.over' } | null;
  resumedGameId: string | null;
}

function connect(p: Player, joinQueue: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    p.ws = ws;
    const fail = setTimeout(() => reject(new Error(p.label + ': connect timeout')), 15_000);

    const send = (obj: unknown): void => void ws.send(JSON.stringify(obj));

    const act = (): void => {
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
            p.resumedGameId = msg.resumed.gameId;
            p.seat = msg.resumed.seat;
            p.state = msg.resumed.state;
            act(); // it may already be our turn in the restored game
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
          // replay the roll locally to learn our legal moves (same as e2e.ts)
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
    resumedGameId: null,
  };
}

async function waitFor(cond: () => boolean, what: string, ms = 60_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for ' + what);
    await sleep(50);
  }
}

// ---------- phase 1: match and play a little ----------

let server = startServer();
await waitHealthy();

const a = makePlayer('A');
const b = makePlayer('B');
await connect(a, true);
await connect(b, true);
await waitFor(() => a.gameId !== null && b.gameId !== null, 'match.found');
const gameId = a.gameId!;
console.log('[restart-test] game started:', gameId);

// let a couple of turns happen so the snapshot is mid-game
await sleep(1_500);

// ---------- phase 2: kill the server mid-game ----------

server.kill('SIGKILL');
a.ws?.terminate();
b.ws?.terminate();
await sleep(300);
console.log('[restart-test] server killed, restarting…');

server = startServer();
await waitHealthy();

// ---------- phase 3: reconnect with the same tokens ----------

await connect(a, false);
await connect(b, false);

if (a.resumedGameId !== gameId || b.resumedGameId !== gameId) {
  console.error(
    `FAIL: expected both clients to resume game ${gameId}, got A=${a.resumedGameId} B=${b.resumedGameId}`,
  );
  server.kill('SIGKILL');
  process.exit(1);
}
console.log('[restart-test] both clients resumed game', gameId);

// ---------- phase 4: the game must play out to game.over ----------

await waitFor(() => a.over !== null && b.over !== null, 'game.over', 120_000);
console.log(
  `[restart-test] game.over: winner=${a.over!.winner} reason=${a.over!.reason} ` +
    `payout=${a.over!.payoutCents}c rake=${a.over!.rakeCents}c`,
);

a.ws?.close();
b.ws?.close();
server.kill('SIGTERM');
console.log('RESTART-TEST OK — a server restart does not kill in-progress games.');
process.exit(0);
