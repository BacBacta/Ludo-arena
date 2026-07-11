/**
 * Ludo Arena game server — Node + ws.
 * Hot state (sessions, queues, rooms) is written through to the store
 * (Redis + Postgres when configured, in-memory otherwise — BACKLOG E2.1).
 * In-progress games are restored from snapshots at boot: a restart does
 * not kill them; players reattach with their sessionToken.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  isoWeek,
  leaguePointsForWin,
  parseClientMsg,
  potCents,
  type ResumedGame,
  type ServerMsg,
  type StakeCents,
} from '@ludo/shared';

/** Current UTC date (YYYY-MM-DD) for daily-challenge / streak resets. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}
function utcYesterday(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}
import type { Seat } from '@ludo/game-engine';
import { Matchmaker } from './matchmaking.js';
import { RateLimiter } from './rateLimit.js';
import { Room, type Client } from './room.js';
import { createFairness } from './fairness.js';
import { createArbiter, SettlementQueue } from './settlement.js';
import { createStore, playerId, type RoomSnapshot, type SessionRecord } from './store/index.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file: rely on the ambient environment
}

const PORT = Number(process.env.PORT ?? 8787);

interface Session extends Client {
  id: string;
  ws: WebSocket | null;
  entropy: string;
  stake: StakeCents | null;
  room: Room | null;
  seat: Seat | null;
  alive: boolean;
}

const store = await createStore();
const sessions = new Map<string, Session>();
const rooms = new Map<string, Room>();
const matchmaker = new Matchmaker<Session>();
// Per-room write chain: snapshots must reach the store in transition order.
const roomWrites = new Map<string, Promise<void>>();

// On-chain settlement (E3.3). null when no ARBITER_PRIVATE_KEY is configured.
const arbiter = createArbiter();
// gameId → who to notify with game.settled once the payout tx is mined.
const settlementNotify = new Map<string, { sessionIds: [string, string]; winner: Seat }>();
const settlementQueue = arbiter
  ? new SettlementQueue({
      store,
      arbiter,
      onSettled: (gameId, txHash) => {
        const info = settlementNotify.get(gameId);
        if (!info) return;
        for (const id of info.sessionIds) {
          sessions.get(id)?.send({ t: 'game.settled', gameId, txHash, winner: info.winner });
        }
        settlementNotify.delete(gameId);
      },
      onRefunded: (gameId, txHash) => {
        const info = settlementNotify.get(gameId);
        if (!info) return;
        for (const id of info.sessionIds) {
          sessions.get(id)?.send({ t: 'game.refunded', gameId, txHash });
        }
        settlementNotify.delete(gameId);
      },
    })
  : null;
if (arbiter) console.log(`[ludo-server] settlement enabled — arbiter ${arbiter.address} on chain ${arbiter.chainId}`);
else console.warn('[ludo-server] settlement disabled (no ARBITER_PRIVATE_KEY)');

const NAMES = ['Kwame', 'Amara', 'Thabo', 'Zainab', 'Kofi', 'Nia', 'Sekou', 'Fatou'];
const FLAGS = ['🇨🇲', '🇳🇬', '🇰🇪', '🇬🇭', '🇸🇳', '🇨🇮', '🇿🇦', '🇹🇿'];

function toRecord(s: Session): SessionRecord {
  return {
    id: s.id,
    wallet: s.wallet,
    entropy: s.entropy,
    name: s.name,
    flag: s.flag,
    elo: s.elo,
    stake: s.stake,
    gameId: s.room?.gameId ?? null,
    seat: s.seat,
  };
}

function persistSession(s: Session): void {
  store.saveSession(toRecord(s)).catch((e) => console.error('[store] saveSession', e));
}

function persistRoom(room: Room): void {
  const snap = room.toSnapshot();
  const prev = roomWrites.get(room.gameId) ?? Promise.resolve();
  roomWrites.set(
    room.gameId,
    prev.then(() => store.saveRoom(snap)).catch((e) => console.error('[store] saveRoom', e)),
  );
}

function makeSession(id: string, ws: WebSocket | null, rec: Omit<SessionRecord, 'gameId' | 'seat'>): Session {
  return {
    id,
    ws,
    wallet: rec.wallet,
    entropy: rec.entropy,
    name: rec.name,
    flag: rec.flag,
    elo: rec.elo,
    stake: rec.stake,
    room: null,
    seat: null,
    alive: ws !== null,
    send(m: ServerMsg) {
      if (this.ws && this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify(m));
      }
    },
  };
}

function wireRoom(room: Room): void {
  rooms.set(room.gameId, room);
  room.onChange = persistRoom;
  room.onCapture = (seat) => {
    const s = sessions.get(room.client(seat).id);
    if (!s) return;
    store
      .addCapture(playerId(s.wallet, s.id), utcToday())
      .then((challenge) => s.send({ t: 'challenge.update', challenge }))
      .catch((e) => console.error('[challenge] addCapture', e));
  };
  room.onEnd = () => {
    rooms.delete(room.gameId);
    // Resolve players through the sessions map: covers both sessions wired at
    // startGame and sessions reattached after a restart.
    for (const seat of [0, 1] as const) {
      const s = sessions.get(room.client(seat).id);
      if (s && s.room === room) {
        s.room = null;
        s.seat = null;
        persistSession(s);
      }
    }
  };
  room.onResult = (result) => {
    const [pa, pb] = result.players;
    const idA = playerId(pa.wallet, pa.id);
    const idB = playerId(pb.wallet, pb.id);
    store
      .recordGame({
        gameId: result.gameId,
        stakeCents: result.stakeCents,
        playerA: idA,
        playerB: idB,
        winnerSeat: result.winner,
        reason: result.reason,
        payoutCents: result.payoutCents,
        rakeCents: result.rakeCents,
        eloDelta: result.eloDelta,
        fairnessCommit: result.fairness.commit,
        serverSeed: result.fairness.serverSeed,
      })
      .then(() => Promise.all([store.updateElo(idA, pa.elo), store.updateElo(idB, pb.elo)]))
      .then(() => store.deleteRoom(result.gameId))
      .catch((e) => console.error('[store] onResult', e));

    // Weekly league: award the winner league points and push their standings (E4.3).
    const winnerId = result.winner === 0 ? idA : idB;
    const winnerSession = sessions.get(result.players[result.winner].id);
    store
      .addLeaguePoints(winnerId, leaguePointsForWin(result.stakeCents))
      .then((league) => winnerSession?.send({ t: 'league.update', league }))
      .catch((e) => console.error('[league] addLeaguePoints', e));

    // Staked game with both wallets known → settle the payout on-chain (E3.3).
    const winnerWallet = result.players[result.winner].wallet;
    if (settlementQueue && result.stakeCents > 0 && pa.wallet && pb.wallet && winnerWallet) {
      settlementNotify.set(result.gameId, { sessionIds: [pa.id, pb.id], winner: result.winner });
      settlementQueue
        .enqueue(result.gameId, winnerWallet)
        .catch((e) => console.error('[settlement] enqueue', e));
    }
  };
}

/** Detached placeholder until the real session reattaches via its token. */
function stubClient(p: RoomSnapshot['players'][number]): Client {
  return { id: p.sessionId, wallet: p.wallet, name: p.name, flag: p.flag, elo: p.elo, send() {} };
}

// ---------- boot: restore in-progress games ----------

await store.queueClear(); // queued sockets did not survive the restart
for (const snap of await store.loadRooms()) {
  const room = Room.fromSnapshot(snap, stubClient(snap.players[0]), stubClient(snap.players[1]));
  wireRoom(room);
  room.resume();
  console.log(`[ludo-server] restored game ${snap.gameId} (stake ${snap.stakeCents}c)`);
}
// Finish any settlements interrupted by the previous run.
await settlementQueue?.resumePending();

// Weekly league rollover (E4.3): runs when the ISO week changes (Mon 00:00 UTC).
// Checked at boot and hourly so a restart never misses the boundary.
async function maybeRolloverLeague(): Promise<void> {
  const week = isoWeek(new Date());
  const last = await store.getMeta('leagueWeek');
  if (last === null) {
    await store.setMeta('leagueWeek', week); // first boot: mark, don't roll over
    return;
  }
  if (last !== week) {
    const { promoted, relegated } = await store.rolloverLeagues();
    await store.setMeta('leagueWeek', week);
    console.log(`[league] rollover ${last} → ${week}: ${promoted} promoted, ${relegated} relegated`);
  }
}
await maybeRolloverLeague().catch((e) => console.error('[league] rollover', e));
setInterval(() => void maybeRolloverLeague().catch((e) => console.error('[league] rollover', e)), 3_600_000);

// ---------- http + ws ----------

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size, rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: http, maxPayload: 1024 });
const limiter = new RateLimiter();
setInterval(() => limiter.prune(), 60_000);

let connSeq = 0;

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress ?? 'unknown';
  if (limiter.isBanned(ip)) {
    send(ws, { t: 'error', code: 'LIMIT_REACHED', message: 'Temporarily banned. Try again later.' });
    ws.close();
    return;
  }
  const connKey = `${ip}#${++connSeq}`;

  // Without a listener, a ws-level error (e.g. an oversized frame, code 1009)
  // becomes an unhandled 'error' event and would crash the whole process.
  ws.on('error', (e) => console.warn('[ludo-server] ws error:', e.message));

  let session: Session | null = null;
  // Handlers await store lookups; chain them so messages keep arrival order.
  let inbox = Promise.resolve();

  ws.on('message', (data) => {
    const verdict = limiter.allow(connKey, ip);
    if (verdict !== 'ok') {
      // silent drop while over rate (no error amplification); one notice on ban
      if (verdict === 'ban') {
        send(ws, { t: 'error', code: 'LIMIT_REACHED', message: 'Rate limit exceeded — temporarily banned.' });
        ws.close();
      }
      return;
    }
    inbox = inbox
      .then(() => handle(data.toString()))
      .catch((e) => {
        console.error('[ludo-server] message', e);
        send(ws, { t: 'error', code: 'INTERNAL', message: 'Internal error.' });
      });
  });

  async function handle(raw: string): Promise<void> {
    const msg = parseClientMsg(raw);
    if (!msg) {
      send(ws, { t: 'error', code: 'BAD_MESSAGE', message: 'Invalid message.' });
      return;
    }

    if (msg.t === 'hello') {
      const resumedSession = msg.sessionToken ? await resumeSession(msg.sessionToken, ws) : null;
      if (resumedSession) {
        session = resumedSession;
        const rpid = playerId(resumedSession.wallet, resumedSession.id);
        send(ws, {
          t: 'hello.ok',
          sessionToken: resumedSession.id,
          elo: resumedSession.elo,
          resumed: resumedGame(resumedSession),
          challenge: await store.getChallenge(rpid, utcToday()),
          streak: resumedSession.wallet ? await store.recordLogin(rpid, utcToday(), utcYesterday()) : undefined,
          league: await store.getLeague(rpid),
        });
        return;
      }
      const id = randomBytes(16).toString('hex');
      const idx = Math.floor(Math.random() * NAMES.length);
      const name = NAMES[idx] ?? 'Player';
      const flag = FLAGS[idx] ?? '🌍';
      // Wallet-linked players keep their ELO across sessions (Postgres).
      const elo = msg.wallet
        ? (await store.getOrCreatePlayer(playerId(msg.wallet, id), { wallet: msg.wallet, name, flag })).elo
        : 1200;
      session = makeSession(id, ws, {
        id,
        wallet: msg.wallet,
        entropy: msg.entropy,
        name,
        flag,
        elo,
        stake: null,
      });
      sessions.set(id, session);
      persistSession(session);
      const pid = playerId(msg.wallet, id);
      const challenge = await store.getChallenge(pid, utcToday());
      // Streak is persisted only for wallet-linked players (anon rows are ephemeral).
      const streak = msg.wallet ? await store.recordLogin(pid, utcToday(), utcYesterday()) : undefined;
      const league = await store.getLeague(pid);
      send(ws, { t: 'hello.ok', sessionToken: id, elo, challenge, streak, league });
      return;
    }

    if (!session) {
      send(ws, { t: 'error', code: 'BAD_STATE', message: 'hello required first.' });
      return;
    }

    switch (msg.t) {
      case 'ping':
        session.send({ t: 'pong' });
        break;

      case 'queue.join': {
        if (session.room) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Already in a game.' });
          break;
        }
        session.stake = msg.stake;
        persistSession(session);
        const pair = matchmaker.join(msg.stake, {
          session,
          entropy: session.entropy,
          elo: session.elo,
          enqueuedAt: Date.now(),
        });
        if (!pair) {
          await store.queuePush(msg.stake, session.id);
          session.send({ t: 'queue.ok', position: matchmaker.position(msg.stake, session) });
          break;
        }
        await store.queueRemove(pair[0].session.id);
        await startGame(msg.stake, pair[0].session, pair[1].session);
        break;
      }

      case 'queue.leave':
        matchmaker.leaveAll(session);
        await store.queueRemove(session.id);
        break;

      case 'game.roll':
        if (session.room && session.seat !== null) session.room.roll(session.seat);
        break;

      case 'game.move':
        if (session.room && session.seat !== null) session.room.move(session.seat, msg.token);
        break;

      case 'game.rematch':
        // v1: re-queue at the same stake (instant rematch: BACKLOG E4)
        if (!session.room && session.stake !== null) {
          const pair = matchmaker.join(session.stake, {
            session,
            entropy: session.entropy,
            elo: session.elo,
            enqueuedAt: Date.now(),
          });
          if (pair) {
            await store.queueRemove(pair[0].session.id);
            await startGame(session.stake, pair[0].session, pair[1].session);
          } else {
            await store.queuePush(session.stake, session.id);
            session.send({ t: 'queue.ok', position: 1 });
          }
        }
        break;
    }
  }

  ws.on('close', () => {
    limiter.release(connKey);
    if (!session) return;
    session.ws = null;
    session.alive = false;
    matchmaker.leaveAll(session);
    store.queueRemove(session.id).catch((e) => console.error('[store] queueRemove', e));
    // The room keeps running: clock + auto-move handle absence (disconnection != forfeit).
    // The in-memory entry is dropped after 10 min; the store copy keeps its own TTL
    // so the token can still resume (fresh reconnect path) afterwards.
    const s = session;
    setTimeout(() => {
      if (!s.alive && !s.room) sessions.delete(s.id);
    }, 600_000);
  });
});

/** Full match context so a reconnecting client can rebuild its game screen. */
function resumedGame(s: Session): ResumedGame | undefined {
  if (!s.room || s.seat === null || s.room.isOver()) return undefined;
  const opp = s.room.client(s.seat === 0 ? 1 : 0);
  return {
    gameId: s.room.gameId,
    seat: s.seat,
    state: s.room.getState(),
    stakeCents: s.room.stakeCents,
    potCents: potCents(s.room.stakeCents),
    opponent: { name: opp.name, elo: opp.elo, flag: opp.flag },
    fairnessCommit: s.room.fairness.commit,
  };
}

/** Look up a session token in memory, then in the store (post-restart). */
async function resumeSession(token: string, ws: WebSocket): Promise<Session | null> {
  const existing = sessions.get(token);
  if (existing) {
    existing.ws = ws;
    existing.alive = true;
    return existing;
  }
  const rec = await store.loadSession(token);
  if (!rec) return null;
  const session = makeSession(rec.id, ws, rec);
  sessions.set(rec.id, session);
  if (rec.gameId && rec.seat !== null) {
    const room = rooms.get(rec.gameId);
    if (room && !room.isOver()) {
      session.room = room;
      session.seat = rec.seat;
      room.attach(rec.seat, session);
    } else {
      persistSession(session); // the game ended while we were away
    }
  }
  return session;
}

async function startGame(stake: StakeCents, a: Session, b: Session): Promise<void> {
  const gameId = randomBytes(16).toString('hex');
  // Durable participant rows must exist before the game record references them.
  await Promise.all([
    store.getOrCreatePlayer(playerId(a.wallet, a.id), { wallet: a.wallet, name: a.name, flag: a.flag }),
    store.getOrCreatePlayer(playerId(b.wallet, b.id), { wallet: b.wallet, name: b.name, flag: b.flag }),
  ]);
  const room = new Room(gameId, stake, a, b, createFairness(a.entropy, b.entropy));
  a.room = room;
  a.seat = 0;
  b.room = room;
  b.seat = 1;
  wireRoom(room);
  persistSession(a);
  persistSession(b);
  const pot = potCents(stake);
  a.send({
    t: 'match.found',
    gameId,
    seat: 0,
    opponent: { name: b.name, elo: b.elo, flag: b.flag },
    stakeCents: stake,
    potCents: pot,
    fairnessCommit: room.fairness.commit,
  });
  b.send({
    t: 'match.found',
    gameId,
    seat: 1,
    opponent: { name: a.name, elo: a.elo, flag: a.flag },
    stakeCents: stake,
    potCents: pot,
    fairnessCommit: room.fairness.commit,
  });
  room.start();
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// ELO windows widen while players wait: re-check the queues every second.
setInterval(() => {
  for (const { stake, pair } of matchmaker.sweep()) {
    Promise.all([store.queueRemove(pair[0].session.id), store.queueRemove(pair[1].session.id)])
      .then(() => startGame(stake, pair[0].session, pair[1].session))
      .catch((e) => console.error('[ludo-server] sweep startGame', e));
  }
}, 1_000);

http.listen(PORT, () => {
  console.log(`[ludo-server] ws://localhost:${PORT} (health: http://localhost:${PORT}/health)`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Snapshots are already in the store (write-through); just stop cleanly.
    for (const room of rooms.values()) room.suspend();
    settlementQueue?.stop();
    void Promise.allSettled([...roomWrites.values()])
      .then(() => store.close())
      .finally(() => process.exit(0));
  });
}
