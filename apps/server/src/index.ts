/**
 * Ludo Arena game server — Node + ws.
 * Hot state (sessions, queues, rooms) is written through to the store
 * (Redis + Postgres when configured, in-memory otherwise — BACKLOG E2.1).
 * In-progress games are restored from snapshots at boot: a restart does
 * not kill them; players reattach with their sessionToken.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { getAddress, isAddress } from 'viem';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  isoWeek,
  leaguePointsForWin,
  MAX_DAILY_GAMES_VS_SAME,
  parseClientMsg,
  potCents,
  TABLE_CODE_CHARS,
  TABLE_CODE_LEN,
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
function utcPlusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
import type { Seat } from '@ludo/game-engine';
import { Matchmaker } from './matchmaking.js';
import { RateLimiter } from './rateLimit.js';
import { Room, type Client } from './room.js';
import { createFairness, createSeedCommit, finalizeFairness, sha256Hex, type Fairness } from './fairness.js';
import { createArbiter, GameStatus, SettlementQueue } from './settlement.js';
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
  entropy: string; // raw entropy (legacy hello, or once revealed via game.entropy)
  entropyCommit?: string; // sha256(entropy) from hello (anti-grinding commit-reveal)
  stake: StakeCents | null;
  room: Room | null;
  seat: Seat | null;
  alive: boolean;
  /** Game awaiting this session's entropy reveal before it can be finalized. */
  pendingGameId?: string;
  fingerprint?: string; // device fingerprint from hello (E5.3)
  country?: string; // ISO country from the CDN header (E5.4)
}

// Geo-gating (E5.4): ISO country codes where staked play is disabled.
const BLOCKED_COUNTRIES = new Set(
  (process.env.BLOCKED_COUNTRIES ?? '').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean),
);
function countryOf(headers: Record<string, string | string[] | undefined>): string | undefined {
  const c = headers['cf-ipcountry'] ?? headers['x-vercel-ip-country'] ?? headers['x-country'];
  return typeof c === 'string' && c.length === 2 ? c.toUpperCase() : undefined;
}
function isGeoBlocked(country: string | undefined): boolean {
  return country !== undefined && BLOCKED_COUNTRIES.has(country);
}

const store = await createStore();
const sessions = new Map<string, Session>();
const rooms = new Map<string, Room>();
const matchmaker = new Matchmaker<Session>();
// Per-room write chain: snapshots must reach the store in transition order.
const roomWrites = new Map<string, Promise<void>>();
// Private tables (E4.4): share code → host waiting for a friend to join.
interface PrivateTable {
  host: Session;
  stake: StakeCents;
  createdAt: number;
}
const privateTables = new Map<string, PrivateTable>();
const TABLE_TTL_MS = 15 * 60_000;

/** Games matched but awaiting both players' entropy reveals (anti-grinding). The
 *  server has committed its seed; the Room is created only once both reveal. */
interface PendingReveal {
  gameId: string;
  stake: StakeCents;
  a: Session;
  b: Session;
  serverSeed: string;
  commit: string;
  entropies: [string | null, string | null];
  /** True once we're polling the escrow for both stakes to lock (staked games). */
  lockPolling?: boolean;
}
const pendingReveals = new Map<string, PendingReveal>();

// C3 — don't start a staked game until BOTH stakes are locked on-chain (status
// Active), or a blitz game could finish before the joins mine and pay the winner
// nothing. Poll the escrow between reveal and Room creation.
const LOCK_POLL_MS = 3_000;
const MAX_LOCK_POLLS = 40; // ~2 min: generous for two Celo approve+join txs to mine

function generateTableCode(): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const bytes = randomBytes(TABLE_CODE_LEN);
    let code = '';
    for (let i = 0; i < TABLE_CODE_LEN; i++) {
      code += TABLE_CODE_CHARS[bytes[i]! % TABLE_CODE_CHARS.length];
    }
    if (!privateTables.has(code)) return code;
  }
  throw new Error('could not allocate a table code');
}

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
    const loserId = result.winner === 0 ? idB : idA;
    const winnerSession = sessions.get(result.players[result.winner].id);
    const loserSession = sessions.get(result.players[result.winner === 0 ? 1 : 0].id);
    store
      .addLeaguePoints(winnerId, leaguePointsForWin(result.stakeCents))
      .then((league) => winnerSession?.send({ t: 'league.update', league }))
      .catch((e) => console.error('[league] addLeaguePoints', e));

    // Anti-tilt cashback (E4.5): only for staked games — winner resets, loser
    // accumulates rake and gets a cashback after 3 losses in a row.
    if (result.stakeCents > 0) {
      store.applyAntiTilt(winnerId, true, 0).catch((e) => console.error('[cashback] win', e));
      store
        .applyAntiTilt(loserId, false, result.rakeCents)
        .then(({ cents, totalCents }) => {
          if (cents > 0) loserSession?.send({ t: 'cashback', cents, totalCents });
        })
        .catch((e) => console.error('[cashback] loss', e));
    }

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

/** Concurrent-socket cap per IP: one host can't exhaust FDs/memory by opening
 *  many connections (each of which otherwise gets its own fresh token bucket). */
const MAX_CONNS_PER_IP = 24;
const connsByIp = new Map<string, number>();
setInterval(() => limiter.prune(), 60_000);
// Expire stale private tables (host gone or waited too long).
setInterval(() => {
  const now = Date.now();
  for (const [code, table] of privateTables) {
    if (!table.host.alive || now - table.createdAt > TABLE_TTL_MS) privateTables.delete(code);
  }
}, 60_000);

let connSeq = 0;

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress ?? 'unknown';
  const country = countryOf(req.headers);
  if (limiter.isBanned(ip)) {
    send(ws, { t: 'error', code: 'LIMIT_REACHED', message: 'Temporarily banned. Try again later.' });
    ws.close();
    return;
  }
  const liveForIp = connsByIp.get(ip) ?? 0;
  if (liveForIp >= MAX_CONNS_PER_IP) {
    send(ws, { t: 'error', code: 'LIMIT_REACHED', message: 'Too many connections.' });
    ws.close();
    return;
  }
  connsByIp.set(ip, liveForIp + 1);
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
        if (msg.fingerprint) resumedSession.fingerprint = msg.fingerprint;
        resumedSession.country = country;
        const rpid = playerId(resumedSession.wallet, resumedSession.id);
        send(ws, {
          t: 'hello.ok',
          sessionToken: resumedSession.id,
          elo: resumedSession.elo,
          resumed: resumedGame(resumedSession),
          challenge: await store.getChallenge(rpid, utcToday()),
          streak: resumedSession.wallet ? await store.recordLogin(rpid, utcToday(), utcYesterday()) : undefined,
          league: await store.getLeague(rpid),
          cashbackCents: await store.getCashback(rpid),
          limits: await store.getLimits(rpid, utcToday()),
          stakingBlocked: isGeoBlocked(country),
        });
        return;
      }
      const id = randomBytes(16).toString('hex');
      const idx = Math.floor(Math.random() * NAMES.length);
      const name = NAMES[idx] ?? 'Player';
      const flag = FLAGS[idx] ?? '🌍';
      // Only accept a well-formed checksummed address; garbage would otherwise
      // flow to the arbiter as the settlement recipient and brick the escrow.
      const wallet = normalizeWallet(msg.wallet);
      // Wallet-linked players keep their ELO across sessions (Postgres).
      const elo = wallet
        ? (await store.getOrCreatePlayer(playerId(wallet, id), { wallet, name, flag })).elo
        : 1200;
      session = makeSession(id, ws, {
        id,
        wallet,
        entropy: msg.entropy ?? '', // legacy raw entropy; new clients reveal later
        name,
        flag,
        elo,
        stake: null,
      });
      session.entropyCommit = msg.entropyCommit; // anti-grinding commit (new clients)
      session.fingerprint = msg.fingerprint;
      session.country = country;
      sessions.set(id, session);
      persistSession(session);
      const pid = playerId(msg.wallet, id);
      const challenge = await store.getChallenge(pid, utcToday());
      // Streak is persisted only for wallet-linked players (anon rows are ephemeral).
      const streak = msg.wallet ? await store.recordLogin(pid, utcToday(), utcYesterday()) : undefined;
      const league = await store.getLeague(pid);
      const cashbackCents = await store.getCashback(pid);
      const limits = await store.getLimits(pid, utcToday());
      send(ws, { t: 'hello.ok', sessionToken: id, elo, challenge, streak, league, cashbackCents, limits, stakingBlocked: isGeoBlocked(country) });
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
        const blocked = await stakeBlock(session, msg.stake);
        if (blocked) {
          session.send({ t: 'error', code: 'LIMIT_REACHED', message: blocked });
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

      case 'table.create': {
        if (session.room) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Already in a game.' });
          break;
        }
        const blockedCreate = await stakeBlock(session, msg.stake);
        if (blockedCreate) {
          session.send({ t: 'error', code: 'LIMIT_REACHED', message: blockedCreate });
          break;
        }
        session.stake = msg.stake;
        const code = generateTableCode();
        privateTables.set(code, { host: session, stake: msg.stake, createdAt: Date.now() });
        session.send({ t: 'table.created', code, stakeCents: msg.stake });
        break;
      }

      case 'table.join': {
        if (session.room) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Already in a game.' });
          break;
        }
        const table = privateTables.get(msg.code);
        if (!table || table.host === session || !table.host.alive || table.host.room) {
          session.send({ t: 'error', code: 'TABLE_NOT_FOUND', message: 'Table not found or no longer available.' });
          break;
        }
        const blockedJoin = await stakeBlock(session, table.stake);
        if (blockedJoin) {
          session.send({ t: 'error', code: 'LIMIT_REACHED', message: blockedJoin });
          break;
        }
        // Anti multi-accounting (E5.3): block same-device self-play and too many
        // staked games against the same wallet today.
        const collusion = await collusionBlock(table.host, session, table.stake);
        if (collusion) {
          session.send({ t: 'error', code: 'LIMIT_REACHED', message: collusion });
          break;
        }
        privateTables.delete(msg.code);
        session.stake = table.stake;
        await startGame(table.stake, table.host, session);
        break;
      }

      case 'game.roll':
        if (session.room && session.seat !== null) session.room.roll(session.seat);
        break;

      case 'game.move':
        if (session.room && session.seat !== null) session.room.move(session.seat, msg.token);
        break;

      case 'game.resign':
        // deliberate forfeit → the room finishes with the other seat as winner,
        // driving the normal game.over + settlement path for the opponent.
        if (session.room && session.seat !== null) session.room.resign(session.seat);
        break;

      case 'game.entropy': {
        // Anti-grinding reveal: verify the raw entropy against the hello commit,
        // store it, and finalize the game once both players have revealed.
        const pending = session.pendingGameId ? pendingReveals.get(session.pendingGameId) : undefined;
        if (!pending) break;
        let seat: 0 | 1;
        if (session === pending.a) seat = 0;
        else if (session === pending.b) seat = 1;
        else break;
        if (!session.entropyCommit || sha256Hex(msg.entropy) !== session.entropyCommit) {
          session.send({ t: 'error', code: 'BAD_MESSAGE', message: 'Entropy does not match commit.' });
          break;
        }
        session.entropy = msg.entropy;
        pending.entropies[seat] = msg.entropy;
        // Start once both revealed AND (for real-money games) both stakes are locked.
        maybeStartPending(pending);
        break;
      }

      case 'limits.set': {
        const pid = playerId(session.wallet, session.id);
        const selfExcludedUntil = msg.selfExcludeDays ? utcPlusDays(msg.selfExcludeDays) : undefined;
        await store.setLimits(pid, { dailyLimitCents: msg.dailyLimitCents, selfExcludedUntil });
        session.send({ t: 'limits.update', limits: await store.getLimits(pid, utcToday()) });
        break;
      }

      case 'game.rematch': {
        // v1: re-queue at the same stake (instant rematch: BACKLOG E4)
        if (!session.room && session.stake !== null) {
          const blockedRematch = await stakeBlock(session, session.stake);
          if (blockedRematch) {
            session.send({ t: 'error', code: 'LIMIT_REACHED', message: blockedRematch });
            break;
          }
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
  }

  ws.on('close', () => {
    limiter.release(connKey);
    const n = (connsByIp.get(ip) ?? 1) - 1;
    if (n <= 0) connsByIp.delete(ip);
    else connsByIp.set(ip, n);
    if (!session) return;
    session.ws = null;
    session.alive = false;
    matchmaker.leaveAll(session);
    store.queueRemove(session.id).catch((e) => console.error('[store] queueRemove', e));
    // Drop private tables this session was hosting.
    for (const [code, table] of privateTables) {
      if (table.host === session) privateTables.delete(code);
    }
    // Abandon a game that was awaiting entropy reveals (Room not created yet).
    if (session.pendingGameId) {
      const p = pendingReveals.get(session.pendingGameId);
      if (p) {
        pendingReveals.delete(p.gameId);
        const opp = p.a === session ? p.b : p.a;
        opp.pendingGameId = undefined;
        opp.send({ t: 'error', code: 'INTERNAL', message: 'Opponent left before the game started.' });
      }
    }
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

/** Anti multi-accounting gate (E5.3): message if the pairing must be refused, else null. */
async function collusionBlock(a: Session, b: Session, stake: StakeCents): Promise<string | null> {
  if (stake <= 0) return null;
  if (a.fingerprint && a.fingerprint === b.fingerprint) return 'Same-device play is not allowed for staked games.';
  // Repeated-opponent cap is wallet-scoped (anon rows are ephemeral).
  if (a.wallet && b.wallet) {
    const played = await store.pairGamesToday(playerId(a.wallet, a.id), playerId(b.wallet, b.id), utcToday());
    if (played >= MAX_DAILY_GAMES_VS_SAME) return 'Daily limit of staked games against this opponent reached.';
  }
  return null;
}

/** Responsible-gaming gate (E5.2): message if this stake must be blocked, else null. */
/** Return a checksummed address, or undefined if not a valid EVM address. */
function normalizeWallet(w?: string): string | undefined {
  if (!w || !isAddress(w)) return undefined;
  return getAddress(w);
}

async function stakeBlock(session: Session, stake: StakeCents): Promise<string | null> {
  if (stake <= 0) return null;
  // Never take REAL stakes when settlement can't survive a restart (in-memory /
  // Redis-only): a crash would drop the settlement job and lock funds in escrow.
  // Only wallet-backed players lock real funds on-chain; wallet-less demo players
  // stake simulated balances (no escrow, no settlement job) so they're unaffected.
  if (session.wallet && !store.settlementDurable()) {
    return 'Staked games are temporarily unavailable — free practice only.';
  }
  if (isGeoBlocked(session.country)) return 'Staked games are not available in your region.';
  const limits = await store.getLimits(playerId(session.wallet, session.id), utcToday());
  if (limits.selfExcludedUntil) return `Self-excluded until ${limits.selfExcludedUntil}.`;
  if (limits.stakedTodayCents + stake > limits.dailyLimitCents) {
    return `Daily stake limit reached (${limits.stakedTodayCents}/${limits.dailyLimitCents}¢).`;
  }
  return null;
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

// Real-money games (both wallets) don't start until both stakes are locked
// on-chain — see maybeStartPending()/pollStakeLock() (audit C3). This runs during
// the pre-Room reveal phase, so a blitz game can't finish before the joins mine.
async function startGame(stake: StakeCents, a: Session, b: Session): Promise<void> {
  const gameId = randomBytes(16).toString('hex');
  // Durable participant rows must exist before the game record references them.
  const idA = playerId(a.wallet, a.id);
  const idB = playerId(b.wallet, b.id);
  await Promise.all([
    store.getOrCreatePlayer(idA, { wallet: a.wallet, name: a.name, flag: a.flag }),
    store.getOrCreatePlayer(idB, { wallet: b.wallet, name: b.name, flag: b.flag }),
  ]);
  // Count the stake toward each player's daily total (E5.2) and the pair count (E5.3).
  if (stake > 0) {
    await Promise.all([
      store.addDailyStake(idA, utcToday(), stake),
      store.addDailyStake(idB, utcToday(), stake),
    ]);
    if (a.wallet && b.wallet) await store.bumpPairGame(idA, idB, utcToday());
  }
  // Anti-grinding: if both clients sent an entropy COMMIT, the server commits its
  // seed now (knowing only the hashes), announces the match, and waits for both to
  // reveal their raw entropy before finalizing the dice. Legacy clients that sent
  // raw entropy fall back to the immediate (grindable) path for deploy compatibility.
  const newFlow = !!a.entropyCommit && !!b.entropyCommit;
  const pot = potCents(stake);
  if (newFlow) {
    const { serverSeed, commit } = createSeedCommit();
    pendingReveals.set(gameId, { gameId, stake, a, b, serverSeed, commit, entropies: [null, null] });
    a.pendingGameId = gameId;
    b.pendingGameId = gameId;
    // Announce the match + the seed commit now; the Room + play start only after
    // both reveal their entropy (finalizeGame). Client auto-reveals on match.found.
    a.send(matchFoundMsg(gameId, 0, b, stake, pot, commit));
    b.send(matchFoundMsg(gameId, 1, a, stake, pot, commit));
    return;
  }
  // legacy: raw entropy already known → announce + start immediately
  const fairness = createFairness(a.entropy, b.entropy);
  a.send(matchFoundMsg(gameId, 0, b, stake, pot, fairness.commit));
  b.send(matchFoundMsg(gameId, 1, a, stake, pot, fairness.commit));
  startRoom(gameId, stake, a, b, fairness);
}

function matchFoundMsg(gameId: string, seat: Seat, opp: Session, stake: StakeCents, pot: number, commit: string): ServerMsg {
  return {
    t: 'match.found',
    gameId,
    seat,
    opponent: { name: opp.name, elo: opp.elo, flag: opp.flag },
    stakeCents: stake,
    potCents: pot,
    fairnessCommit: commit,
  };
}

/** Create the Room from a finalized fairness and start it (match.found already sent). */
function startRoom(gameId: string, stake: StakeCents, a: Session, b: Session, fairness: Fairness): void {
  const room = new Room(gameId, stake, a, b, fairness);
  a.room = room;
  a.seat = 0;
  b.room = room;
  b.seat = 1;
  a.pendingGameId = undefined;
  b.pendingGameId = undefined;
  wireRoom(room);
  persistSession(a);
  persistSession(b);
  room.start();
}

/** Both players revealed their entropy → bind the committed seed and start play. */
function finalizeGame(p: PendingReveal): void {
  pendingReveals.delete(p.gameId);
  const fairness = finalizeFairness(p.serverSeed, p.commit, p.entropies[0] ?? '', p.entropies[1] ?? '');
  startRoom(p.gameId, p.stake, p.a, p.b, fairness);
}

/**
 * Decide whether a pending game can start yet. Requires BOTH entropy reveals
 * (fairness) and, for a real-money game (both wallets + arbiter), BOTH stakes
 * locked on-chain (C3) — otherwise a fast game could finish before the joins
 * mine and the winner would be paid nothing.
 */
function maybeStartPending(p: PendingReveal): void {
  if (p.entropies[0] === null || p.entropies[1] === null) return; // await reveals
  const needsLock = p.stake > 0 && !!p.a.wallet && !!p.b.wallet && !!arbiter;
  if (!needsLock) {
    finalizeGame(p);
    return;
  }
  if (p.lockPolling) return;
  p.lockPolling = true;
  pollStakeLock(p, 0);
}

/** Poll the escrow until both stakes are Active, then start; abort on timeout. */
function pollStakeLock(p: PendingReveal, attempt: number): void {
  if (pendingReveals.get(p.gameId) !== p) return; // finalized or aborted
  void arbiter!
    .gameStatus(p.gameId)
    .then(({ status }) => {
      if (pendingReveals.get(p.gameId) !== p) return;
      if (status === GameStatus.Active) {
        finalizeGame(p);
        return;
      }
      if (attempt >= MAX_LOCK_POLLS) {
        // Stakes never both locked. Abort the match; whoever DID lock can reclaim
        // via the escrow's refundExpired (WaitingOpponent) after JOIN_TIMEOUT.
        pendingReveals.delete(p.gameId);
        p.a.pendingGameId = undefined;
        p.b.pendingGameId = undefined;
        const err: ServerMsg = { t: 'error', code: 'INTERNAL', message: 'Stakes were not locked in time — match cancelled.' };
        p.a.send(err);
        p.b.send(err);
        console.warn(`[stake-gate] ${p.gameId} aborted: stakes not Active after ${attempt} polls`);
        return;
      }
      setTimeout(() => pollStakeLock(p, attempt + 1), LOCK_POLL_MS);
    })
    .catch((e) => {
      console.error('[stake-gate] gameStatus poll failed', e instanceof Error ? e.message : e);
      if (attempt < MAX_LOCK_POLLS && pendingReveals.get(p.gameId) === p) {
        setTimeout(() => pollStakeLock(p, attempt + 1), LOCK_POLL_MS);
      }
    });
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
