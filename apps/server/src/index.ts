/**
 * Serveur de jeu Ludo Arena — Node + ws.
 * v1 : état en mémoire (sessions, files, rooms). Persistance Redis/Postgres : BACKLOG E2.1.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMsg, type ServerMsg, type StakeCents } from '@ludo/shared';
import type { Seat } from '@ludo/game-engine';
import { Matchmaker } from './matchmaking.js';
import { Room, type Client } from './room.js';

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

const sessions = new Map<string, Session>();
const matchmaker = new Matchmaker<Session>();

const NAMES = ['Kwame', 'Amara', 'Thabo', 'Zainab', 'Kofi', 'Nia', 'Sekou', 'Fatou'];
const FLAGS = ['🇨🇲', '🇳🇬', '🇰🇪', '🇬🇭', '🇸🇳', '🇨🇮', '🇿🇦', '🇹🇿'];

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: http, maxPayload: 1024 });

wss.on('connection', (ws) => {
  let session: Session | null = null;

  ws.on('message', (data) => {
    const msg = parseClientMsg(data.toString());
    if (!msg) {
      send(ws, { t: 'error', code: 'BAD_MESSAGE', message: 'Message invalide.' });
      return;
    }

    if (msg.t === 'hello') {
      const existing = msg.sessionToken ? sessions.get(msg.sessionToken) : undefined;
      if (existing) {
        // reprise de session (reconnexion)
        existing.ws = ws;
        existing.alive = true;
        session = existing;
        const resumed =
          existing.room && existing.seat !== null
            ? { gameId: existing.room.gameId, seat: existing.seat, state: existing.room.getState() }
            : undefined;
        send(ws, { t: 'hello.ok', sessionToken: existing.id, elo: existing.elo, resumed });
        return;
      }
      const id = randomBytes(16).toString('hex');
      const idx = Math.floor(Math.random() * NAMES.length);
      session = {
        id,
        ws,
        wallet: msg.wallet,
        entropy: msg.entropy,
        name: NAMES[idx] ?? 'Joueur',
        flag: FLAGS[idx] ?? '🌍',
        elo: 1200,
        stake: null,
        room: null,
        seat: null,
        alive: true,
        send(m: ServerMsg) {
          if (this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(m));
          }
        },
      };
      sessions.set(id, session);
      send(ws, { t: 'hello.ok', sessionToken: id, elo: session.elo });
      return;
    }

    if (!session) {
      send(ws, { t: 'error', code: 'BAD_STATE', message: 'hello requis d’abord.' });
      return;
    }

    switch (msg.t) {
      case 'ping':
        session.send({ t: 'pong' });
        break;

      case 'queue.join': {
        if (session.room) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Déjà en partie.' });
          break;
        }
        session.stake = msg.stake;
        const pair = matchmaker.join(msg.stake, {
          session,
          entropy: session.entropy,
          enqueuedAt: Date.now(),
        });
        if (!pair) {
          session.send({ t: 'queue.ok', position: matchmaker.position(msg.stake, session) });
          break;
        }
        startGame(msg.stake, pair[0].session, pair[1].session);
        break;
      }

      case 'queue.leave':
        matchmaker.leaveAll(session);
        break;

      case 'game.roll':
        if (session.room && session.seat !== null) session.room.roll(session.seat);
        break;

      case 'game.move':
        if (session.room && session.seat !== null) session.room.move(session.seat, msg.token);
        break;

      case 'game.rematch':
        // v1 : re-queue même mise (revanche instantanée : BACKLOG E4)
        if (!session.room && session.stake !== null) {
          const pair = matchmaker.join(session.stake, {
            session,
            entropy: session.entropy,
            enqueuedAt: Date.now(),
          });
          if (pair) startGame(session.stake, pair[0].session, pair[1].session);
          else session.send({ t: 'queue.ok', position: 1 });
        }
        break;
    }
  });

  ws.on('close', () => {
    if (!session) return;
    session.ws = null;
    session.alive = false;
    matchmaker.leaveAll(session);
    // La room continue : horloge + auto-move gèrent l'absence (déconnexion ≠ forfait).
    // Nettoyage des sessions orphelines après 10 min.
    const s = session;
    setTimeout(() => {
      if (!s.alive && !s.room) sessions.delete(s.id);
    }, 600_000);
  });
});

function startGame(stake: StakeCents, a: Session, b: Session): void {
  const gameId = randomBytes(16).toString('hex');
  const room = new Room(gameId, stake, a, b, a.entropy, b.entropy);
  a.room = room;
  a.seat = 0;
  b.room = room;
  b.seat = 1;
  room.onEnd = () => {
    a.room = null;
    a.seat = null;
    b.room = null;
    b.seat = null;
  };
  const pot = room.stakeCents * 2 - Math.floor((room.stakeCents * 2 * 900) / 10_000);
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

http.listen(PORT, () => {
  console.log(`[ludo-server] ws://localhost:${PORT} (health: http://localhost:${PORT}/health)`);
});
