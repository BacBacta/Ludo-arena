/**
 * Ludo Arena game server — Node + ws.
 * Hot state (sessions, queues, rooms) is written through to the store
 * (Redis + Postgres when configured, in-memory otherwise — BACKLOG E2.1).
 * In-progress games are restored from snapshots at boot: a restart does
 * not kill them; players reattach with their sessionToken.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from 'viem';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  FREEROLL,
  TABLE4,
  PREMIUM_SKINS,
  isoWeek,
  leaguePointsForWin,
  MAX_DAILY_GAMES_VS_SAME,
  parseClientMsg,
  PROFILE_NAME_MIN,
  PROFILE_NAME_MAX,
  potCents,
  potCents4,
  TABLE_CODE_CHARS,
  TABLE_CODE_LEN,
  TOS_VERSION,
  walletProofMessage,
  type Player4Info,
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
import { createFairness, createFairness4, createSeed4Commit, createSeedCommit, finalizeFairness, finalizeFairness4, randomSeatSeed, sha256Hex, type Fairness } from './fairness.js';
import { Room4, BOT4_NAMES, type Seat4 } from './room4.js';
import { createArbiter, GameStatus, SettlementQueue } from './settlement.js';
import { createArbiterN, GameStatusN, SettlementQueue4 } from './settlement4.js';
import { createCosmeticsVerifier } from './cosmetics.js';
import { createStore, pidFor, playerId, type RoomSnapshot, type SessionRecord } from './store/index.js';

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
  /** 4-player online game membership (separate from the 2p `room`). */
  room4: Room4 | null;
  seat4: number | null;
  alive: boolean;
  /** Game awaiting this session's entropy reveal before it can be finalized. */
  pendingGameId?: string;
  fingerprint?: string; // device fingerprint from hello (E5.3)
  country?: string; // ISO country from the CDN header (E5.4)
  ip?: string; // socket IP (server-derived anti-collusion signal, E5.3)
  /** ToS version this session accepted (18+/consent gate for staked play). */
  consentTos?: string;
  /** profile.get throttle: last lookup timestamp (anti-spam, DB-bound query). */
  lastProfileGetAt?: number;
  /** QA test session (see QA_KEY): isolated matchmaking, no ladder writes. */
  qa?: boolean;
  /** Equipped avatar frame (cosmetic, client-authoritative like dice skins). */
  frame?: string;
  /** Chosen profile avatar id (cosmetic, client-authoritative like the frame). */
  avatar?: string;
  /** Last opponent + stake, for a true direct rematch (BACKLOG E4). */
  lastOpponentId?: string;
  lastStake?: StakeCents;
  /** Seat held in the last game (`seat` is nulled on room end) — a rematch
   *  re-pairs with the SAME seats so colours/corners never silently swap. */
  lastSeat?: Seat;
  /** Label to show for THIS game (see duoNames): normally `name`, but
   *  disambiguated when both players carry the same one. It must live on the
   *  session, not just in match.found, so a RECONNECT re-sends the same labels.
   *  Cleared when the room ends; the durable player row is never touched. */
  displayName?: string;
  rematchWanted?: boolean;
  /** True when the last game came from a PRIVATE table — a rematch then waits for
   *  the same friend instead of spilling into the public queue. */
  lastGamePrivate?: boolean;
  /** Wallet ownership proof (SIWE): the nonce we issued + whether it's proven. */
  walletNonce?: string;
  walletProven?: boolean;
  /** Running inside MiniPay: the auto-connected address is trusted, so ownership
   *  is accepted WITHOUT a SIWE signature (MiniPay can't personal_sign). */
  miniPay?: boolean;
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
/** Secret gate for QA test traffic (e2e runs against production). A session
 *  connecting with ?qa=<QA_KEY> is isolated: it only pairs with other QA
 *  sessions, may not stake, and its games write nothing to public ladders.
 *  Unset (default) disables the flag entirely. */
const QA_KEY = process.env.QA_KEY ?? '';

const sessions = new Map<string, Session>();
const rooms = new Map<string, Room>();
const matchmaker = new Matchmaker<Session>();
// Freeroll (ticket-gated free 1v1) waits in its own queue so it never pairs
// with regular free/staked players; entry tickets are spent at match time.
const freerollMatchmaker = new Matchmaker<Session>();
// 4-player online Sit&Go: a simple gather queue with bot-fill after a short wait.
const rooms4 = new Map<string, Room4>();
const freeroll4Waiting: Session[] = [];
let freeroll4Timer: ReturnType<typeof setTimeout> | null = null;
// Staked cUSD 4-player: one wait queue per stake (4 real stakers required, no
// bots), plus games awaiting all 4 on-chain deposits before Room4 starts.
interface StakedQueue4 {
  waiting: Session[];
  timer: ReturnType<typeof setTimeout> | null;
}
const staked4 = new Map<number, StakedQueue4>();
function staked4Queue(stake: number): StakedQueue4 {
  let q = staked4.get(stake);
  if (!q) {
    q = { waiting: [], timer: null };
    staked4.set(stake, q);
  }
  return q;
}
interface PendingStaked4 {
  gameId: string;
  humans: Session[]; // seat index = position in this array
  stake: number;
  pot: number;
  rake: number;
  // Anti-grinding (R-DICE-3): the seed is committed knowing only the seat commits;
  // each human reveals its raw entropy, and the dice bind to those reveals — so the
  // server can't pre-grind the sequence. Fairness is finalized once all reveals are in.
  serverSeed: string;
  commit: string;
  seatCommits: string[]; // each seat's hello entropyCommit, to verify its reveal
  reveals: (string | null)[]; // raw entropy per seat (null until revealed)
}
const pendingStaked4 = new Map<string, PendingStaked4>();
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
  /** Ticket-gated freeroll (entries already spent; winner gets the ticket prize). */
  freeroll?: boolean;
  /** True once we're polling the escrow for both stakes to lock (staked games). */
  lockPolling?: boolean;
}
const pendingReveals = new Map<string, PendingReveal>();
// Grace period for a FREE game to receive both entropy reveals before we start it
// anyway (so a non-revealing client can't hang the match on "Opponent found!").
const REVEAL_TIMEOUT_MS = 6_000;

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

/**
 * Ops alerting for money-critical events (payout failed / stuck escrow). Opt-in:
 * POSTs to OPS_WEBHOOK_URL (Slack/Discord/PagerDuty-compatible `{text}`) when set,
 * so a stuck payout pages a human instead of dying in a log. Dep-free (uses the
 * built-in fetch); always console.error too. No DSN → console-only (no-op).
 */
function postOpsAlert(message: string): void {
  const url = process.env.OPS_WEBHOOK_URL?.trim();
  if (!url) return;
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: message }),
  }).catch((e) => console.error('[ops] alert webhook failed', e instanceof Error ? e.message : e));
}

// R-COMP-2: real-money staked play must be an EXPLICIT launch decision, not a side
// effect of the arbiter secret being present. Settlement arms ONLY when
// STAKING_ENABLED === 'true'; otherwise staked play stays off even with a key +
// escrow configured, so mainnet addresses landing in secrets can never silently
// go live. Flip this flag deliberately (per network) once launch is signed off.
const stakingEnabled = (process.env.STAKING_ENABLED ?? '').trim() === 'true';
if (!stakingEnabled && (process.env.ARBITER_PRIVATE_KEY ?? '').trim()) {
  console.warn('[ludo-server] ARBITER_PRIVATE_KEY is set but STAKING_ENABLED != true — staked play is DISABLED (explicit launch gate, R-COMP-2). Set STAKING_ENABLED=true to arm settlement.');
}
// On-chain settlement (E3.3). null unless staking is armed AND a key is configured.
const arbiter = stakingEnabled ? createArbiter() : null;
// cUSD cosmetic-purchase verifier (rec 6). null until the CosmeticsStore is
// deployed → cosmetic.claim stays off (ticket unlocks still work regardless).
const cosmeticsVerifier = createCosmeticsVerifier();
// N-player settlement for staked 4-player games (LudoEscrowN). null unless staking
// is armed AND the N-player escrow is deployed + configured.
const arbiterN = stakingEnabled ? createArbiterN() : null;
// gameId → who to notify with game.settled once the payout tx is mined.
const settlementNotify = new Map<string, { sessionIds: [string, string]; winner: Seat }>();
const settlementQueue = arbiter
  ? new SettlementQueue({
      store,
      arbiter,
      onAlert: postOpsAlert,
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
// gameId → seats to notify + winner seat, for the durable 4p queue's callbacks.
const settlement4Notify = new Map<string, { sessionIds: string[]; winnerSeat: number }>();
const settlementQueue4 = arbiterN
  ? new SettlementQueue4({
      store,
      arbiter: arbiterN,
      onAlert: postOpsAlert,
      onSettled: (gameId, txHash) => {
        const info = settlement4Notify.get(gameId);
        if (!info) return;
        for (const id of info.sessionIds) {
          sessions.get(id)?.send({ t: 'game.settled4', gameId, txHash, winner: info.winnerSeat });
        }
        settlement4Notify.delete(gameId);
      },
      onRefunded: (gameId, txHash) => {
        const info = settlement4Notify.get(gameId);
        if (!info) return;
        for (const id of info.sessionIds) {
          sessions.get(id)?.send({ t: 'game.refunded4', gameId, txHash });
        }
        settlement4Notify.delete(gameId);
      },
    })
  : null;
if (arbiter) console.log(`[ludo-server] settlement enabled — arbiter ${arbiter.address} on chain ${arbiter.chainId}`);
if (arbiterN) console.log(`[ludo-server] staked 4-player enabled — LudoEscrowN arbiter ${arbiterN.address} on chain ${arbiterN.chainId}`);
if (cosmeticsVerifier) console.log(`[ludo-server] cUSD cosmetics enabled — CosmeticsStore ${cosmeticsVerifier.address} on chain ${cosmeticsVerifier.chainId}`);
// Compliance nudge: real settlement is on but no jurisdictions are geo-blocked and
// the country header is only trustworthy behind a trusted edge (Cloudflare/Vercel).
if (arbiter && BLOCKED_COUNTRIES.size === 0) {
  console.warn('[compliance] settlement is ENABLED but BLOCKED_COUNTRIES is empty — staked play is allowed in every region. Set a legal-reviewed deny list and enforce the country header behind a trusted edge before real-money launch.');
}
else console.warn('[ludo-server] settlement disabled (no ARBITER_PRIVATE_KEY)');

/** Guest display-name pool. Kept LARGE on purpose: the name and flag together are
 *  a guest's whole identity, so a small pool means players meet their own double.
 *  With 8 names (the original pool) 12.5% of 1v1s and ~59% of 4-player tables had
 *  two identical players — indistinguishable on screen. */
const NAMES = [
  'Kwame', 'Amara', 'Thabo', 'Zainab', 'Kofi', 'Nia', 'Sekou', 'Fatou',
  'Chidi', 'Ngozi', 'Tunde', 'Aisha', 'Mandla', 'Lerato', 'Sipho', 'Naledi',
  'Yaw', 'Adwoa', 'Kojo', 'Abena', 'Moussa', 'Aminata', 'Ibrahim', 'Khadija',
  'Tendai', 'Chipo', 'Farai', 'Rudo', 'Juma', 'Zuri', 'Baraka', 'Imani',
];

/** Deterministic 32-bit hash (FNV-1a) — stable across processes, unlike random. */
function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Neutral identity mark. A country flag is NEVER inferred — see deriveIdentity. */
const GLOBE = '🌍';

/** Stable identity: a player's display NAME is derived (not random) from their
 *  identity key, so a wallet-linked player is the same Kwame every session — the
 *  prerequisite for profiles, friends and leaderboards.
 *
 *  The flag is deliberately NOT derived. A flag is a claim about who you are, so
 *  it appears only when the player picks one in their profile (customFlag);
 *  everyone else shows the neutral globe. Inferring it was wrong twice over: it
 *  put a country on players who never chose one, and hashing name+flag from the
 *  same value made them perfectly correlated (Amara was always 🇳🇬), leaving only
 *  NAMES.length distinct guest identities — players met their own double. */
function deriveIdentity(idKey: string): { name: string; flag: string } {
  const h = stableHash(idKey);
  return { name: NAMES[h % NAMES.length] ?? 'Player', flag: GLOBE };
}

/** Basic substring blocklist for the custom-name filter. Not exhaustive — a
 *  starting moderation floor for a free-text handle in a real-money game (the
 *  broader anti-harassment stance stays: emotes/chat remain closed sets). */
const NAME_BLOCKLIST = [
  'fuck', 'shit', 'bitch', 'cunt', 'nigg', 'faggot', 'rape', 'nazi', 'hitler',
  'admin', 'moderator', 'support', 'official', 'ludoarena',
];

/**
 * Sanitize an edited display name. Returns a clean name, or undefined when the
 * input is unusable → the caller falls back to the derived name (the connection
 * is NEVER rejected over a cosmetic field). Strips control chars, collapses
 * whitespace, bounds length, blocks URLs/handles (impersonation/spam) and a
 * basic profanity list, and restricts to letters/digits/space + a few marks.
 */
function sanitizeName(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  let s = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length < PROFILE_NAME_MIN) return undefined;
  s = s.slice(0, PROFILE_NAME_MAX).trim();
  if (s.length < PROFILE_NAME_MIN) return undefined;
  if (/https?:|www\.|@|\.(com|net|org|io|xyz|gg|me)\b/i.test(s)) return undefined;
  const lower = s.toLowerCase();
  if (NAME_BLOCKLIST.some((w) => lower.includes(w))) return undefined;
  if (!/^[\p{L}\p{N} _.'-]+$/u.test(s)) return undefined;
  return s;
}

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
    room4: null,
    seat4: null,
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
        s.displayName = undefined; // per-game label; the next pairing settles a fresh one
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
    // QA games keep the audit trail (recordGame/ELO above) but must not touch
    // the public ladder or grant rewards — test traffic polluted the league.
    if (room.qa) return;
    store
      .addLeaguePoints(winnerId, leaguePointsForWin(result.stakeCents))
      .then((league) => winnerSession?.send({ t: 'league.update', league }))
      .catch((e) => console.error('[league] addLeaguePoints', e));
    // Profile W/L: bump the winner's win count (games_played is bumped in updateElo).
    store.recordWin(winnerId).catch((e) => console.error('[profile] recordWin', e));

    // Freeroll prize: winner takes both entries plus the house bonus, in tickets.
    if (result.freeroll) {
      store
        .grantTickets(winnerId, FREEROLL.winnerTickets)
        .then((total) => {
          winnerSession?.send({ t: 'tickets.grant', granted: FREEROLL.winnerTickets, total, reason: 'freeroll-win' });
        })
        .catch((e) => console.error('[freeroll] prize', e));
    }

    // Anti-tilt bonus (E4.5): only for staked games — a win resets the streak,
    // the 3rd straight loss grants freeroll ticket(s) (spendable, no cash liability).
    if (result.stakeCents > 0) {
      store.applyAntiTilt(winnerId, true).catch((e) => console.error('[anti-tilt] win', e));
      store
        .applyAntiTilt(loserId, false)
        .then(({ grantedTickets, totalTickets }) => {
          if (grantedTickets > 0) {
            loserSession?.send({ t: 'tickets.grant', granted: grantedTickets, total: totalTickets, reason: 'anti-tilt' });
          }
        })
        .catch((e) => console.error('[anti-tilt] loss', e));
    }

    // Staked game with both wallets known → settle the payout on-chain (E3.3).
    const winnerWallet = result.players[result.winner].wallet;
    if (settlementQueue && result.stakeCents > 0 && pa.wallet && pb.wallet && winnerWallet) {
      settlementNotify.set(result.gameId, { sessionIds: [pa.id, pb.id], winner: result.winner });
      settlementQueue.enqueue(result.gameId, winnerWallet).catch((e) => {
        // A dropped enqueue would silently lose the winner's payout (the terminal
        // snapshot is already persisted). Page ops — the boot reconciliation
        // (R-SETTLE-2) is the net that re-enqueues it, but a live DB blip that
        // never crashes the process would otherwise go unnoticed.
        const msg = `[settlement][ALERT] enqueue FAILED for game ${result.gameId}, winner ${winnerWallet}: ${e instanceof Error ? e.message : e}. Winner not yet queued for payout.`;
        console.error(msg);
        postOpsAlert(msg);
      });
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
  // R-SETTLE-2: a staked game can persist its terminal (over=true) snapshot and
  // then crash before onResult's async enqueue lands — the payout job is lost and
  // resume() no-ops for an over room, so the winner would never be paid. Re-enqueue
  // any finished staked game that has no settlement record yet.
  const winnerSeat = snap.over ? snap.state.winner : null;
  if (settlementQueue && snap.stakeCents > 0 && winnerSeat != null) {
    const winnerWallet = snap.players[winnerSeat]?.wallet;
    const bothWallets = snap.players[0].wallet && snap.players[1].wallet;
    if (winnerWallet && bothWallets && !(await store.hasSettlement(snap.gameId))) {
      settlementNotify.set(snap.gameId, { sessionIds: [snap.players[0].sessionId, snap.players[1].sessionId], winner: winnerSeat });
      await settlementQueue.enqueue(snap.gameId, winnerWallet).catch((e) => console.error('[settlement] boot re-enqueue', e));
      console.warn(`[settlement] re-enqueued orphaned staked game ${snap.gameId} (crash between game-over and settlement)`);
    }
  }
}
// Finish any settlements interrupted by the previous run (1v1 and 4p).
await settlementQueue?.resumePending();
await settlementQueue4?.resumePending();

// Arbiter gas-balance monitor: a broke arbiter silently stalls EVERY payout
// (retries exhaust, funds sit in escrow). Alert ops once when the native balance
// dips below the floor (default 0.05 CELO), and re-arm after it recovers.
const gasArbiter = arbiter ?? arbiterN;
if (gasArbiter) {
  const floorWei = process.env.ARBITER_MIN_BALANCE_WEI?.trim()
    ? BigInt(process.env.ARBITER_MIN_BALANCE_WEI.trim())
    : 50_000_000_000_000_000n; // 0.05 CELO
  let lowBalanceAlerted = false;
  const checkGas = async (): Promise<void> => {
    try {
      const bal = await gasArbiter.nativeBalance();
      if (bal < floorWei && !lowBalanceAlerted) {
        lowBalanceAlerted = true;
        postOpsAlert(`[arbiter][ALERT] LOW GAS — arbiter ${gasArbiter.address} balance ${bal} wei < floor ${floorWei} wei on chain ${gasArbiter.chainId}. Top up or payouts will stall.`);
      } else if (bal >= floorWei && lowBalanceAlerted) {
        lowBalanceAlerted = false; // recovered — re-arm the alert
        console.log(`[arbiter] gas balance recovered (${bal} wei)`);
      }
    } catch (e) {
      console.error('[arbiter] gas balance check failed', e instanceof Error ? e.message : e);
    }
  };
  void checkGas();
  setInterval(() => void checkGas(), 5 * 60_000);
}

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
    const { promoted, relegated, ticketsAwarded } = await store.rolloverLeagues();
    await store.setMeta('leagueWeek', week);
    console.log(`[league] rollover ${last} → ${week}: ${promoted} promoted, ${relegated} relegated, ${ticketsAwarded} tickets awarded`);
  }
}
await maybeRolloverLeague().catch((e) => console.error('[league] rollover', e));
setInterval(() => void maybeRolloverLeague().catch((e) => console.error('[league] rollover', e)), 3_600_000);

// ---------- http + ws ----------

const http = createServer((req, res) => {
  // Liveness: the process is up. Kept unconditional so the orchestrator never
  // kills a running server just because a dependency blipped.
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size, rooms: rooms.size }));
    return;
  }
  // Readiness: only "ready" if we can actually persist and (when settlement is
  // enabled) reach the chain RPC — otherwise a load balancer should stop routing
  // staked traffic to an instance that can't durably record or settle. Returns
  // 503 (not 200) on failure so the probe is actionable.
  if (req.url === '/ready') {
    void (async () => {
      const checks: Record<string, boolean> = { store: false };
      try {
        await withTimeout(store.getMeta('__ready__'), 2000);
        checks.store = true;
      } catch {
        /* store unreachable */
      }
      if (arbiter) {
        checks.rpc = false;
        try {
          await withTimeout(arbiter.healthcheck(), 2500);
          checks.rpc = true;
        } catch {
          /* RPC unreachable */
        }
      }
      const ok = Object.values(checks).every(Boolean);
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok, durable: store.settlementDurable(), checks }));
    })();
    return;
  }
  res.writeHead(404);
  res.end();
});

/** Reject a promise that takes longer than `ms` (keeps the readiness probe from
 *  hanging on a wedged store/RPC connection). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

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
  let qaConn = false;
  if (QA_KEY !== '') {
    try {
      qaConn = new URL(req.url ?? '/', 'ws://x').searchParams.get('qa') === QA_KEY;
    } catch {
      qaConn = false;
    }
  }
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
      // Normalize the wallet once so both the resume-reconcile and the fresh path
      // see the same checksummed address (garbage → undefined).
      const wallet = normalizeWallet(msg.wallet);
      const resumedSession = msg.sessionToken ? await resumeSession(msg.sessionToken, ws, wallet) : null;
      if (resumedSession) {
        session = resumedSession;
        resumedSession.qa = qaConn || undefined;
        if (msg.fingerprint) resumedSession.fingerprint = msg.fingerprint;
        resumedSession.country = country;
        resumedSession.ip = ip;
        resumedSession.miniPay = msg.miniPay === true;
        if (msg.frame !== undefined) resumedSession.frame = msg.frame;
        if (msg.avatar !== undefined) resumedSession.avatar = msg.avatar;
        // Profile edit on a resumed session: apply the sanitized custom identity
        // (anon → session-only; wallet → persisted + re-read below).
        const rCustomName = sanitizeName(msg.name);
        const rCustomFlag = msg.flag;
        if (rCustomName) resumedSession.name = rCustomName;
        if (rCustomFlag) resumedSession.flag = rCustomFlag;
        await recordConsent(resumedSession, msg.consent);
        const rProof = issueWalletNonce(resumedSession);
        const rpid = playerId(resumedSession.wallet, resumedSession.id);
        const rStats = resumedSession.wallet
          ? await store.getOrCreatePlayer(rpid, { wallet: resumedSession.wallet, name: resumedSession.name, flag: resumedSession.flag, frame: msg.frame, avatar: msg.avatar, customName: rCustomName, customFlag: rCustomFlag })
          : { gamesPlayed: 0, wins: 0, name: resumedSession.name, flag: resumedSession.flag };
        resumedSession.name = rStats.name;
        resumedSession.flag = rStats.flag;
        send(ws, {
          t: 'hello.ok',
          sessionToken: resumedSession.id,
          elo: resumedSession.elo,
          name: resumedSession.name,
          flag: resumedSession.flag,
          games: rStats.gamesPlayed,
          wins: rStats.wins,
          pid: resumedSession.wallet ? pidFor(rpid) : undefined,
          frame: resumedSession.frame,
          avatar: resumedSession.avatar,
          resumed: resumedGame(resumedSession),
          challenge: await store.getChallenge(rpid, utcToday()),
          streak: resumedSession.wallet ? await store.recordLogin(rpid, utcToday(), utcYesterday()) : undefined,
          league: await store.getLeague(rpid),
          limits: await store.getLimits(rpid, utcToday()),
          ownedSkins: await store.getOwnedSkins(rpid),
          stakingBlocked: isGeoBlocked(country),
          walletNonce: rProof.walletNonce,
          walletProven: rProof.walletProven,
          consentTosVersion: resumedSession.consentTos,
        });
        // R-WEB-1: if this session had a live 4-player seat (staked table), rebind
        // the new socket to it and resync — a dropped staker resumes instead of
        // forfeiting their locked stake. The room kept the seat during the grace
        // window (Room4.drop detaches without bot-forfeiting for staked tables).
        if (resumedSession.room4 && resumedSession.seat4 != null && !resumedSession.room4.isOver()) {
          resumedSession.room4.attach(resumedSession.seat4, resumedSession);
        }
        return;
      }
      const id = randomBytes(16).toString('hex');
      // `wallet` was normalized at the top of the hello handler. Identity is
      // DERIVED from the stable key (wallet → same name/flag every session),
      // not randomised per connection.
      const idKey = playerId(wallet, id);
      // Identity is DERIVED from the stable key (same name/flag every session) —
      // UNLESS the player edited their profile: a sanitized custom name and/or a
      // valid custom flag override the derived default and are persisted.
      const derived = deriveIdentity(idKey);
      const customName = sanitizeName(msg.name);
      const customFlag = msg.flag; // parse validated it is a flag emoji (or undefined)
      // Wallet-linked players keep their ELO + custom identity across sessions.
      const stats = wallet
        ? await store.getOrCreatePlayer(idKey, { wallet, name: derived.name, flag: derived.flag, frame: msg.frame, avatar: msg.avatar, customName, customFlag })
        : { elo: 1200, gamesPlayed: 0, wins: 0, name: customName ?? derived.name, flag: customFlag ?? derived.flag };
      const elo = stats.elo;
      const name = stats.name;
      const flag = stats.flag;
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
      if (qaConn) {
        session.qa = true;
        console.log('[qa] session flagged: isolated matchmaking, no ladder writes');
      }
      session.ip = ip;
      session.miniPay = msg.miniPay === true; // trusted address, no SIWE (before issueWalletNonce)
      session.frame = msg.frame; // cosmetic; validated to AVATAR_FRAMES in parse
      session.avatar = msg.avatar; // cosmetic; validated to AVATARS in parse
      sessions.set(id, session);
      persistSession(session);
      const pid = playerId(msg.wallet, id);
      const challenge = await store.getChallenge(pid, utcToday());
      // Streak is persisted only for wallet-linked players (anon rows are ephemeral).
      const streak = msg.wallet ? await store.recordLogin(pid, utcToday(), utcYesterday()) : undefined;
      const league = await store.getLeague(pid);
      const limits = await store.getLimits(pid, utcToday());
      const ownedSkins = await store.getOwnedSkins(pid);
      await recordConsent(session, msg.consent);
      const proof = issueWalletNonce(session);
      send(ws, {
        t: 'hello.ok',
        sessionToken: id,
        elo,
        name,
        flag,
        games: stats.gamesPlayed,
        wins: stats.wins,
        pid: wallet ? pidFor(idKey) : undefined,
        frame: session.frame,
        avatar: session.avatar,
        challenge,
        streak,
        league,
        limits,
        ownedSkins,
        stakingBlocked: isGeoBlocked(country),
        walletNonce: proof.walletNonce,
        walletProven: proof.walletProven,
        consentTosVersion: session.consentTos,
      });
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

      case 'wallet.prove': {
        // Verify the signature over the nonce we issued recovers to the claimed
        // wallet → the client controls that address (SIWE ownership proof).
        if (!session.wallet || !session.walletNonce) break;
        try {
          const recovered = await recoverMessageAddress({
            message: walletProofMessage(session.walletNonce),
            signature: msg.signature as `0x${string}`,
          });
          if (getAddress(recovered) === getAddress(session.wallet)) {
            session.walletProven = true;
            session.walletNonce = undefined;
          } else {
            session.send({ t: 'error', code: 'BAD_STATE', message: 'Wallet verification failed.' });
          }
        } catch {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Wallet verification failed.' });
        }
        break;
      }

      case 'queue.join': {
        if (session.room || session.pendingGameId) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Already in a game.' });
          break;
        }
        // Reject a duplicate join from a session that's already queued (a double
        // queue.join must not create two entries / self-pair).
        if (matchmaker.position(msg.stake, session) > 0 || freerollMatchmaker.position(0, session) > 0) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Already in the queue.' });
          break;
        }
        // Freeroll (ticket-gated free 1v1): its own queue; entry checked here and
        // SPENT at match time (refunded on abandon before the game starts).
        if (msg.freeroll) {
          if (walletKeyedWriteBlocked(session)) {
            session.send({ t: 'error', code: 'BAD_STATE', message: 'Verify your wallet to spend a freeroll ticket.' });
            break;
          }
          const fpid = playerId(session.wallet, session.id);
          const held = (await store.getChallenge(fpid, utcToday())).tickets;
          if (held < FREEROLL.entryTickets) {
            session.send({ t: 'error', code: 'LIMIT_REACHED', message: 'No freeroll ticket — complete the daily challenge to earn one.' });
            break;
          }
          session.stake = 0;
          persistSession(session);
          const fpair = freerollMatchmaker.join(0, {
            session,
            identity: playerId(session.wallet, session.id),
            entropy: session.entropy,
            elo: session.elo,
            enqueuedAt: Date.now(),
            walletBacked: !!session.wallet,
            qa: session.qa,
          });
          if (!fpair) {
            session.send({ t: 'queue.ok', position: freerollMatchmaker.position(0, session) });
            break;
          }
          await startFreeroll(fpair[0].session, fpair[1].session);
          break;
        }
        if (session.qa && msg.stake > 0) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'QA sessions cannot join staked queues.' });
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
          identity: playerId(session.wallet, session.id),
          entropy: session.entropy,
          elo: session.elo,
          enqueuedAt: Date.now(),
          walletBacked: !!session.wallet,
          qa: session.qa,
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

      case 'queue.join4': {
        if (session.room || session.room4 || session.pendingGameId) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Already in a game.' });
          break;
        }
        const stake4 = msg.stakeCents ?? 0;
        if (session.qa && stake4 > 0) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'QA sessions cannot join staked queues.' });
          break;
        }
        if (session.qa && stake4 === 0) {
          // Isolated table: the QA session + bots, never seated with real players.
          startRoom4([session]);
          break;
        }
        if (stake4 > 0) {
          // Staked cUSD 4-player: needs the N-player escrow + a wallet, and the
          // same money-mode parity gates as 1v1 (consent + wallet-proof + durable
          // settlement + geo + daily limit). No bots — 4 real stakers required.
          if (!arbiterN) {
            session.send({ t: 'error', code: 'BAD_STATE', message: 'Staked 4-player tables are coming soon — play the free table for now.' });
            break;
          }
          if (!session.wallet) {
            session.send({ t: 'error', code: 'BAD_STATE', message: 'Connect a wallet to play a staked 4-player table.' });
            break;
          }
          const blocked4 = await stakeBlock(session, stake4 as StakeCents);
          if (blocked4) {
            session.send({ t: 'error', code: 'LIMIT_REACHED', message: blocked4 });
            break;
          }
          const sq = staked4Queue(stake4);
          if (sq.waiting.includes(session)) {
            session.send({ t: 'error', code: 'BAD_STATE', message: 'Already in the queue.' });
            break;
          }
          sq.waiting.push(session);
          session.send({ t: 'queue.ok', position: sq.waiting.length });
          if (sq.waiting.length >= TABLE4.seats) {
            tryStartStaked4(stake4);
          } else if (!sq.timer) {
            // No bot-fill for money: cancel the queue if 4 stakers don't gather.
            sq.timer = setTimeout(() => cancelStaked4(stake4), TABLE4.stakedFillMs);
          }
          break;
        }
        // Free table: bot-fill after a short wait, no entry, no prize.
        if (freeroll4Waiting.includes(session)) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Already in the queue.' });
          break;
        }
        freeroll4Waiting.push(session);
        session.send({ t: 'queue.ok', position: freeroll4Waiting.length });
        if (freeroll4Waiting.length >= TABLE4.seats) {
          tryStartFreeroll4(false);
        } else if (!freeroll4Timer) {
          freeroll4Timer = setTimeout(() => tryStartFreeroll4(true), TABLE4.botFillMs);
        }
        break;
      }

      case 'queue.leave':
        matchmaker.leaveAll(session);
        freerollMatchmaker.leaveAll(session);
        leave4(session);
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
        // Money-mode parity (same rule as the public queue): a staked table
        // created by a wallet player can't be joined by a demo player (the
        // host's REAL stake would lock against a simulated one), and vice versa.
        if (table.stake > 0 && !!table.host.wallet !== !!session.wallet) {
          session.send({
            t: 'error',
            code: 'BAD_STATE',
            message: session.wallet
              ? 'This table is in demo mode — ask your friend to connect a wallet.'
              : 'This is a real-stakes table — connect a wallet to join.',
          });
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
        await startGame(table.stake, table.host, session, false, true);
        break;
      }

      case 'game.roll':
        if (session.room4 && session.seat4 !== null) session.room4.roll(session.seat4);
        else if (session.room && session.seat !== null) session.room.roll(session.seat);
        break;

      case 'game.move':
        if (session.room4 && session.seat4 !== null) session.room4.move(session.seat4, msg.token);
        else if (session.room && session.seat !== null) session.room.move(session.seat, msg.token);
        break;

      case 'game.resign':
        // deliberate forfeit → the room finishes with the other seat as winner,
        // driving the normal game.over + settlement path for the opponent.
        if (session.room4 && session.seat4 !== null) session.room4.resign(session.seat4);
        else if (session.room && session.seat !== null) session.room.resign(session.seat);
        break;

      case 'emote':
        // Quick emote or quick-chat to the current game — routed to whichever
        // room the player is in; the room throttles per seat. id is validated
        // against EMOTES/QUICK_CHATS in parse (closed sets, no free text).
        if (session.room4 && session.seat4 !== null) session.room4.emote(session.seat4, msg.id);
        else if (session.room && session.seat !== null) session.room.emote(session.seat, msg.id);
        break;

      case 'gift':
        // Directed gift to a chosen opponent seat; the room throttles per seat.
        if (session.room4 && session.seat4 !== null) session.room4.gift(session.seat4, msg.to, msg.id);
        else if (session.room && session.seat !== null) session.room.gift(session.seat, msg.to, msg.id);
        break;

      case 'profile.get': {
        // Public profile by opaque pid (tap-on-avatar). Throttled per session:
        // it is the only client-triggered DB lookup outside the game loop.
        const now = Date.now();
        if (now - (session.lastProfileGetAt ?? 0) < 500) break;
        session.lastProfileGetAt = now;
        const prof = await store.getProfileByPid(msg.pid);
        if (!prof) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Unknown player' });
          break;
        }
        // Head-to-head vs the requester (1v1 games only), omitted when empty.
        // GATED on a PROVEN wallet: a fresh profile.get socket can claim any
        // `wallet` in hello (unproven), so personalizing h2h to that claim would
        // leak arbitrary players' pairwise records. Only a SIWE/MiniPay-proven
        // session may read its own h2h. (Authenticated in-game h2h lands in C4.)
        const requesterId = playerId(session.wallet, session.id);
        let h2h: { wins: number; losses: number } | undefined;
        if (session.walletProven && prof.id !== requesterId) {
          const r = await store.headToHead(requesterId, prof.id);
          if (r.aWins + r.bWins > 0) h2h = { wins: r.aWins, losses: r.bWins };
        }
        session.send({
          t: 'profile.info',
          profile: { pid: msg.pid, name: prof.name, flag: prof.flag, elo: prof.elo, games: prof.gamesPlayed, wins: prof.wins, division: prof.division, frame: prof.frame, avatar: prof.avatar, h2h },
        });
        break;
      }

      case 'game.entropy': {
        // Anti-grinding reveal: verify the raw entropy against the hello commit,
        // store it, and finalize the game once both players have revealed.
        const pending = session.pendingGameId ? pendingReveals.get(session.pendingGameId) : undefined;
        if (pending) {
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
        // Staked 4-player reveal (R-DICE-3): bind this seat's raw entropy against
        // its hello commit; play starts once all four reveal AND all stakes lock.
        const p4 = session.pendingGameId ? pendingStaked4.get(session.pendingGameId) : undefined;
        if (p4) {
          const seat4 = p4.humans.indexOf(session);
          if (seat4 < 0) break;
          if (sha256Hex(msg.entropy) !== p4.seatCommits[seat4]) {
            session.send({ t: 'error', code: 'BAD_MESSAGE', message: 'Entropy does not match commit.' });
            break;
          }
          session.entropy = msg.entropy;
          p4.reveals[seat4] = msg.entropy;
          maybeStartStaked4(p4);
        }
        break;
      }

      case 'limits.set': {
        if (walletKeyedWriteBlocked(session)) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Verify your wallet to change limits.' });
          break;
        }
        const pid = playerId(session.wallet, session.id);
        const selfExcludedUntil = msg.selfExcludeDays ? utcPlusDays(msg.selfExcludeDays) : undefined;
        await store.setLimits(pid, { dailyLimitCents: msg.dailyLimitCents, selfExcludedUntil });
        session.send({ t: 'limits.update', limits: await store.getLimits(pid, utcToday()) });
        break;
      }

      case 'skin.buy': {
        if (walletKeyedWriteBlocked(session)) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Verify your wallet to spend tickets.' });
          break;
        }
        // Unlock a premium dice skin by spending its ticket price (server-authoritative).
        const price = PREMIUM_SKINS[msg.skinId];
        if (price === undefined) {
          session.send({ t: 'error', code: 'BAD_MESSAGE', message: 'Unknown skin.' });
          break;
        }
        const spid = playerId(session.wallet, session.id);
        const alreadyOwned = await store.getOwnedSkins(spid);
        if (alreadyOwned.includes(msg.skinId)) {
          // idempotent: already unlocked, never charge twice
          const held = (await store.getChallenge(spid, utcToday())).tickets;
          session.send({ t: 'skin.owned', ownedIds: alreadyOwned, tickets: held });
          break;
        }
        const spent = await store.spendTickets(spid, price);
        if (spent === null) {
          session.send({ t: 'error', code: 'LIMIT_REACHED', message: 'Not enough freeroll tickets to unlock this skin.' });
          break;
        }
        const ownedIds = await store.ownSkin(spid, msg.skinId);
        session.send({ t: 'skin.owned', ownedIds, tickets: spent });
        break;
      }

      case 'cosmetic.claim': {
        // Grant a cosmetic bought with cUSD on-chain, after verifying the tx.
        if (!cosmeticsVerifier) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'cUSD cosmetic purchases are not available yet.' });
          break;
        }
        // The grant always credits the on-chain BUYER's wallet-pid, and we verify
        // this session's wallet actually paid (buyer == session.wallet). So no
        // SIWE proof is needed: a claim can only ever credit the address that
        // truly paid — you can't grant yourself someone else's purchase.
        if (!session.wallet) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Connect a wallet to claim a purchase.' });
          break;
        }
        const cpid = playerId(session.wallet, session.id);
        const already = await store.getOwnedSkins(cpid);
        if (already.includes(msg.id)) {
          const held = (await store.getChallenge(cpid, utcToday())).tickets;
          session.send({ t: 'skin.owned', ownedIds: already, tickets: held });
          break;
        }
        const ok = await cosmeticsVerifier
          .verifyPurchase(msg.txHash as Hex, session.wallet as Address, msg.id)
          .catch(() => false);
        if (!ok) {
          session.send({ t: 'error', code: 'BAD_MESSAGE', message: 'Could not verify that cUSD purchase.' });
          break;
        }
        const owned = await store.ownSkin(cpid, msg.id);
        const held = (await store.getChallenge(cpid, utcToday())).tickets;
        session.send({ t: 'skin.owned', ownedIds: owned, tickets: held });
        break;
      }

      case 'game.rematch': {
        if (session.room || session.pendingGameId) break;
        // Fresh per-game entropy commit (fairness): rebind BEFORE pairing/seeding so
        // the server commits its next seed without ever knowing this game's raw
        // entropy — the client reveals it later on match.found. Without this, a
        // rematch would reuse the already-revealed value and be grindable.
        if (msg.entropyCommit) session.entropyCommit = msg.entropyCommit;
        const stake = session.lastStake ?? session.stake ?? 0;
        // True direct rematch: if the last opponent is still connected, idle, and
        // has ALSO asked to rematch us at the same stake, pair the two of them
        // directly — but only while the anti-collusion cap still allows another
        // game between them (else fall through to matchmaking a fresh opponent).
        const opp = session.lastOpponentId ? sessions.get(session.lastOpponentId) : undefined;
        if (
          opp &&
          opp.alive &&
          !opp.room &&
          !opp.pendingGameId &&
          opp.rematchWanted &&
          opp.lastOpponentId === session.id &&
          (opp.lastStake ?? 0) === stake
        ) {
          const collusion = await collusionBlock(session, opp, stake);
          const blockA = await stakeBlock(session, stake);
          const blockB = await stakeBlock(opp, stake);
          if (!collusion && !blockA && !blockB) {
            // both waiting elsewhere are removed from any queue before we pair them
            matchmaker.leaveAll(session);
            matchmaker.leaveAll(opp);
            await store.queueRemove(session.id);
            await store.queueRemove(opp.id);
            session.rematchWanted = false;
            opp.rematchWanted = false;
            session.stake = stake;
            opp.stake = stake;
            // Keep the SAME seats as the previous game. startGame's first arg is
            // seat 0, and `session` here is whoever clicked rematch LAST — so the
            // seats (colours, corners) silently swapped on about half of all
            // rematches, which players read as "the board is inverted again".
            const seatZero = opp.lastSeat === 0 ? opp : session;
            const seatOne = seatZero === session ? opp : session;
            await startGame(stake, seatZero, seatOne, false, session.lastGamePrivate ?? false);
            break;
          }
          // cap hit / blocked → fall through to matchmaking a different opponent
        }
        // Private table: wait for the SAME friend only — never spill into the public
        // queue (that could match a stranger before the friend clicks rematch). The
        // friend's own rematch triggers the direct re-pair above.
        if (session.lastGamePrivate) {
          const blockedPriv = await stakeBlock(session, stake);
          if (blockedPriv) {
            session.send({ t: 'error', code: 'LIMIT_REACHED', message: blockedPriv });
            break;
          }
          session.rematchWanted = true;
          session.stake = stake;
          offerRematchTo(opp, session); // let the friend accept/decline explicitly
          break;
        }
        // No ready partner (or direct rematch refused): remember the wish and
        // re-queue for any opponent at this stake.
        const blockedRematch = await stakeBlock(session, stake);
        if (blockedRematch) {
          session.send({ t: 'error', code: 'LIMIT_REACHED', message: blockedRematch });
          break;
        }
        session.rematchWanted = true;
        session.stake = stake;
        offerRematchTo(opp, session); // notify the last opponent they can accept
        const pair = matchmaker.join(stake, {
          session,
          identity: playerId(session.wallet, session.id),
          entropy: session.entropy,
          elo: session.elo,
          enqueuedAt: Date.now(),
          walletBacked: !!session.wallet,
          qa: session.qa,
        });
        if (pair) {
          await store.queueRemove(pair[0].session.id);
          await startGame(stake, pair[0].session, pair[1].session);
        } else {
          await store.queuePush(stake, session.id);
          session.send({ t: 'queue.ok', position: 1 });
        }
        break;
      }

      case 'rematch.decline': {
        // We're bowing out (Decline, or leaving the end screen). If the last
        // opponent is waiting on us for a rematch, tell them so they stop.
        const opp = session.lastOpponentId ? sessions.get(session.lastOpponentId) : undefined;
        await cancelRematchWait(opp, session.id, 'declined');
        session.rematchWanted = false; // we're not seeking one either
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
    // R-RT-1: a resume (double tab / reconnect) rebinds the SAME Session object to
    // a newer socket. If this closing socket is no longer the session's active one,
    // it is stale — do the per-connection cleanup above but NEVER tear down the live
    // session (nulling its ws, dropping its live 4p seat to a bot, forfeiting a
    // locked stake). Only the owning socket's close tears the session down.
    if (session.ws !== ws) return;
    session.ws = null;
    session.alive = false;
    // If the last opponent is waiting on us for a rematch, don't leave them
    // hanging on "searching…" — tell them we left. (They can still get a fresh
    // offer if we reconnect and click rematch again.)
    const rematchWaiter = session.lastOpponentId ? sessions.get(session.lastOpponentId) : undefined;
    void cancelRematchWait(rematchWaiter, session.id, 'left');
    matchmaker.leaveAll(session);
    freerollMatchmaker.leaveAll(session);
    leave4(session);
    session.room4?.drop(session.id);
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
        // Freeroll entries were spent at match time: refund BOTH players so a
        // pre-game disconnect can't burn the honest opponent's earned ticket.
        if (p.freeroll) {
          refundFreerollEntry(p.a);
          refundFreerollEntry(p.b);
        }
        // Staked game abandoned pre-Room: auto-refund any on-chain deposit either
        // side already locked (R-SETTLE-1) — the queue voids/refunds by status.
        scheduleRefund1v1(p);
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
  // Re-send the SAME labels the game started with (see duoNames): a reconnect that
  // fell back to raw names would put the two screens back out of sync. The room's
  // Client is the Session, so the per-game displayName is right here.
  const oppSession = sessions.get(opp.id);
  return {
    gameId: s.room.gameId,
    seat: s.seat,
    state: s.room.getState(),
    stakeCents: s.room.stakeCents,
    potCents: potCents(s.room.stakeCents),
    opponent: { name: oppSession ? label(oppSession) : opp.name, elo: opp.elo, flag: opp.flag, pid: opp.wallet ? pidFor(playerId(opp.wallet, opp.id)) : undefined, frame: opp.frame, avatar: opp.avatar },
    youName: label(s),
    fairnessCommit: s.room.fairness.commit,
  };
}

/** Anti multi-accounting gate (E5.3): message if the pairing must be refused, else null. */
async function collusionBlock(a: Session, b: Session, stake: StakeCents): Promise<string | null> {
  if (stake <= 0) return null;
  if (a.fingerprint && a.fingerprint === b.fingerprint) return 'Same-device play is not allowed for staked games.';
  // Server-derived signal (not client-controlled like the fingerprint): refuse a
  // staked pairing between two sockets on the same IP. This only blocks pairing
  // the two of them together — each still matches other opponents — so shared-NAT
  // false positives cost nothing, while same-network chip-dumping is stopped.
  if (a.ip && a.ip !== 'unknown' && a.ip === b.ip) return 'Same-network play is not allowed for staked games.';
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

/** Record + apply the 18+/ToS consent a client sent in hello. Persisted per
 *  player (audit: which version, when) and mirrored on the session for the gate.
 *  Falls back to any durable record when this hello carries no fresh consent. */
async function recordConsent(session: Session, consent?: { tosVersion: string; age18: boolean }): Promise<void> {
  const pid = playerId(session.wallet, session.id);
  if (consent && consent.age18 && consent.tosVersion === TOS_VERSION) {
    session.consentTos = consent.tosVersion;
    await store.setMeta(`consent:${pid}`, JSON.stringify({ v: consent.tosVersion, at: new Date().toISOString() }));
    return;
  }
  if (!session.consentTos) {
    const stored = await store.getMeta(`consent:${pid}`);
    if (stored) {
      try {
        session.consentTos = (JSON.parse(stored) as { v?: string }).v;
      } catch {
        /* legacy/plain record */
      }
    }
  }
}

/** Wallet ownership proof state for hello.ok. Proof is PER-SESSION (never durable
 *  by wallet — that would let anyone claim a proven address), so a fresh session
 *  with an unproven wallet gets a nonce to sign. */
/** R-AUTH-2: a wallet-keyed durable write (tickets, cosmetics, RG limits/self-
 *  exclusion, ELO) must never act on a wallet the session only CLAIMED. Wallet
 *  addresses are public, so a scripted client that sets `wallet` without proving
 *  it could spend a victim's tickets or force their self-exclusion. Proven wallets
 *  (incl. MiniPay, trusted by the platform) and wallet-less sessions (keyed by the
 *  ephemeral session id, no cross-account reach) are fine. */
function walletKeyedWriteBlocked(session: Session): boolean {
  return !!session.wallet && !session.walletProven;
}

function issueWalletNonce(session: Session): { walletNonce?: string; walletProven?: boolean } {
  if (!session.wallet) return {};
  // MiniPay: the wallet is auto-connected + trusted and cannot personal_sign, so
  // accept the address as proven with NO nonce/signature (the required model).
  if (session.miniPay) {
    session.walletProven = true;
    return { walletProven: true };
  }
  if (session.walletProven) return { walletProven: true };
  session.walletNonce = randomBytes(16).toString('hex');
  return { walletNonce: session.walletNonce, walletProven: false };
}

async function stakeBlock(session: Session, stake: StakeCents): Promise<string | null> {
  if (stake <= 0) return null;
  // Staked play requires accepting the CURRENT terms (18+/ToS), enforced
  // server-side (the client gate is bypassable). Recorded in recordConsent.
  if (session.consentTos !== TOS_VERSION) {
    return 'Please accept the current Terms (18+) to play staked games.';
  }
  // Wallet-backed staked play requires a proven wallet (SIWE) so RG limits and
  // self-exclusion can't be dodged by claiming a different/blank address.
  if (session.wallet && !session.walletProven) {
    return 'Verify your wallet ownership to play staked games.';
  }
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
/** Two wallets are "the same identity" iff both absent or equal (checksummed). */
function walletsMatch(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '') === (b ?? '');
}

async function resumeSession(token: string, ws: WebSocket, wallet: string | undefined): Promise<Session | null> {
  const existing = sessions.get(token);
  if (existing) {
    // A stale token from a wallet-less (or different-wallet) session must NOT be
    // reused for a now-wallet-backed client, or it would keep walletBacked=false
    // and let a real-money client be paired against a demo opponent (and lock
    // real funds with no settlement path). Only reuse mid-game (wallet can't
    // change then); otherwise fall through to a fresh, correctly-tagged session.
    const inGame = !!existing.room && !existing.room.isOver();
    if (!inGame && !walletsMatch(existing.wallet, wallet)) return null;
    // R-RT-1: proactively close the previous socket so a lingering stale tab stops
    // receiving state. Its close handler is now a no-op for the session (guarded on
    // session.ws === ws), so this take-over can't null the new live socket.
    const prev = existing.ws;
    existing.ws = ws;
    existing.alive = true;
    if (prev && prev !== ws) {
      try {
        prev.close();
      } catch {
        /* already closing */
      }
    }
    return existing;
  }
  const rec = await store.loadSession(token);
  if (!rec) return null;
  const session = makeSession(rec.id, ws, rec);
  if (rec.gameId && rec.seat !== null) {
    const room = rooms.get(rec.gameId);
    if (room && !room.isOver()) {
      session.room = room;
      session.seat = rec.seat;
      room.attach(rec.seat, session);
    }
  }
  const inGame = !!session.room && !session.room.isOver();
  if (!inGame && !walletsMatch(session.wallet, wallet)) return null; // wallet changed → fresh session
  sessions.set(rec.id, session);
  if (rec.gameId && (!session.room || session.room.isOver())) persistSession(session); // game ended while away
  return session;
}

// Real-money games (both wallets) don't start until both stakes are locked
// on-chain — see maybeStartPending()/pollStakeLock() (audit C3). This runs during
// the pre-Room reveal phase, so a blitz game can't finish before the joins mine.
/** Spend both entries atomically-enough (single-threaded message loop), refund
 *  on partial failure, then start the ticket-gated free game. */
/** Refund one player's freeroll entry ticket and resync their client total. */
function refundFreerollEntry(s: Session): void {
  store
    .grantTickets(playerId(s.wallet, s.id), FREEROLL.entryTickets)
    .then((total) => s.send({ t: 'tickets.grant', granted: 0, total, reason: 'freeroll-win' }))
    .catch((e) => console.error('[freeroll] refund', e));
}

/** Re-queue one player into the freeroll queue; if that instantly pairs them
 *  with a waiting opponent, start that game (don't drop the returned pair). */
function requeueFreeroll(s: Session): void {
  const pair = freerollMatchmaker.join(0, { session: s, entropy: s.entropy, elo: s.elo, enqueuedAt: Date.now(), walletBacked: !!s.wallet });
  if (pair) void startFreeroll(pair[0].session, pair[1].session);
  else s.send({ t: 'queue.ok', position: freerollMatchmaker.position(0, s) });
}

async function startFreeroll(a: Session, b: Session): Promise<void> {
  const pidA = playerId(a.wallet, a.id);
  const pidB = playerId(b.wallet, b.id);
  const spentA = await store.spendTickets(pidA, FREEROLL.entryTickets);
  if (spentA === null) {
    a.send({ t: 'error', code: 'LIMIT_REACHED', message: 'No freeroll ticket.' });
    requeueFreeroll(b); // opponent still has their ticket — keep them queued
    return;
  }
  const spentB = await store.spendTickets(pidB, FREEROLL.entryTickets);
  if (spentB === null) {
    refundFreerollEntry(a); // only A's ticket was spent
    b.send({ t: 'error', code: 'LIMIT_REACHED', message: 'No freeroll ticket.' });
    requeueFreeroll(a);
    return;
  }
  a.send({ t: 'tickets.grant', granted: 0, total: spentA, reason: 'freeroll-win' }); // sync new totals
  b.send({ t: 'tickets.grant', granted: 0, total: spentB, reason: 'freeroll-win' });
  await startGame(0, a, b, true);
}

async function startGame(stake: StakeCents, a: Session, b: Session, freeroll = false, fromTable = false): Promise<void> {
  // Mark private-table origin so a later rematch re-pairs the same friend rather
  // than re-queueing publicly (both seats share the origin).
  a.lastGamePrivate = fromTable;
  b.lastGamePrivate = fromTable;
  // Settle both labels for this game up front, so match.found AND a later resume
  // hand out the same pair. Never touches `name` — the durable row keeps it.
  const [dnA, dnB] = duoNames(a, b);
  a.displayName = dnA;
  b.displayName = dnB;
  // Anti-grinding (audit HIGH-1): STAKED games REQUIRE the commit-reveal flow —
  // both clients must have sent an entropy COMMIT in hello so the server binds its
  // seed without ever seeing raw entropy first. A client that omits it (stale
  // cache, or a crafted client trying to force the grindable legacy path) cannot
  // play for money. Refuse before any state mutates. Free/practice (stake 0) may
  // still use the legacy path for backward compatibility.
  const newFlow = !!a.entropyCommit && !!b.entropyCommit;
  if (stake > 0 && !newFlow) {
    const err: ServerMsg = { t: 'error', code: 'BAD_STATE', message: 'Please update the app to play staked games (fair-dice handshake required).' };
    a.send(err);
    b.send(err);
    console.warn(`[fairness] refused staked game: missing entropyCommit (a=${!!a.entropyCommit} b=${!!b.entropyCommit})`);
    return;
  }
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
  // reveal their raw entropy before finalizing the dice. Only free/practice games
  // (stake 0) may reach the legacy immediate path — staked games were refused above.
  const pot = potCents(stake);
  if (newFlow) {
    const { serverSeed, commit } = createSeedCommit();
    pendingReveals.set(gameId, { gameId, stake, a, b, serverSeed, commit, entropies: [null, null], freeroll });
    a.pendingGameId = gameId;
    b.pendingGameId = gameId;
    // Announce the match + the seed commit now; the Room + play start only after
    // both reveal their entropy (finalizeGame). Client auto-reveals on match.found.
    a.send(matchFoundMsg(gameId, 0, a, b, stake, pot, commit));
    b.send(matchFoundMsg(gameId, 1, b, a, stake, pot, commit));
    // Robustness: a FREE game must never hang on "Opponent found!" if one side
    // fails to reveal its entropy (flaky mobile data, a stale cached client, or a
    // WhatsApp/in-app browser). After a short grace, start anyway with whatever
    // entropy arrived — the server's secret seed still dominates, so a non-staked
    // game stays fair enough. Staked games keep waiting (fairness is non-negotiable
    // for money) and are torn down by the stake-lock timeout instead.
    if (stake === 0) {
      setTimeout(() => {
        const p = pendingReveals.get(gameId);
        if (p && (p.entropies[0] === null || p.entropies[1] === null)) {
          console.warn(`[fairness] free game ${gameId}: entropy reveal timed out (a=${p.entropies[0] !== null}, b=${p.entropies[1] !== null}) — starting with available entropy`);
          finalizeGame(p);
        }
      }, REVEAL_TIMEOUT_MS);
    }
    return;
  }
  // legacy: raw entropy already known → announce + start immediately
  const fairness = createFairness(a.entropy, b.entropy);
  a.send(matchFoundMsg(gameId, 0, a, b, stake, pot, fairness.commit));
  b.send(matchFoundMsg(gameId, 1, b, a, stake, pot, fairness.commit));
  startRoom(gameId, stake, a, b, fairness, freeroll);
}

/** Display names for a 1v1, disambiguated once so BOTH clients agree. Guest names
 *  are drawn from a fixed pool, so ~3% of games pair two players under one name;
 *  with no flag to tell them apart (a flag means "chosen in a profile") the two
 *  banners read identically. Returns [seat 0's label, seat 1's label]. Display
 *  only — each durable player row keeps its real name. */
function duoNames(a: Session, b: Session): [string, string] {
  if (a.name.toLowerCase() !== b.name.toLowerCase()) return [a.name, b.name];
  return [a.name, uniqueAtTable(b.name, new Set([a.name.toLowerCase()]))];
}

/** The label to show for a player in-game: the per-game disambiguated one when
 *  set, else their real name. */
function label(s: Session): string {
  return s.displayName ?? s.name;
}

/** Tell `opp` that `from` wants a rematch, so their end screen shows an explicit
 *  Accept/Decline offer instead of the rematch depending on both sides guessing
 *  to click. Only when opp is still connected, idle, and our last opponent. */
function offerRematchTo(opp: Session | undefined, from: Session): void {
  if (opp && opp.alive && !opp.room && !opp.pendingGameId && opp.lastOpponentId === from.id && !opp.rematchWanted) {
    opp.send({ t: 'rematch.offer', name: label(from) });
  }
}

/** `waiter` is stuck on "searching…" for a rematch with `leaver`; tell them it
 *  won't happen (declined or left) and pull them out of any queue. */
async function cancelRematchWait(waiter: Session | undefined, leaverId: string, reason: 'declined' | 'left'): Promise<void> {
  if (!waiter || !waiter.rematchWanted || waiter.lastOpponentId !== leaverId) return;
  waiter.rematchWanted = false;
  matchmaker.leaveAll(waiter);
  await store.queueRemove(waiter.id);
  waiter.send({ t: 'rematch.cancelled', reason });
}

function matchFoundMsg(gameId: string, seat: Seat, me: Session, opp: Session, stake: StakeCents, pot: number, commit: string): ServerMsg {
  return {
    t: 'match.found',
    gameId,
    seat,
    opponent: { name: label(opp), elo: opp.elo, flag: opp.flag, pid: opp.wallet ? pidFor(playerId(opp.wallet, opp.id)) : undefined, frame: opp.frame, avatar: opp.avatar },
    youName: label(me),
    stakeCents: stake,
    potCents: pot,
    fairnessCommit: commit,
  };
}

/** Create the Room from a finalized fairness and start it (match.found already sent). */
function startRoom(gameId: string, stake: StakeCents, a: Session, b: Session, fairness: Fairness, freeroll = false): void {
  const room = new Room(gameId, stake, a, b, fairness);
  room.qa = !!a.qa || !!b.qa;
  room.freeroll = freeroll;
  a.room = room;
  a.seat = 0;
  b.room = room;
  b.seat = 1;
  a.pendingGameId = undefined;
  b.pendingGameId = undefined;
  // Remember the pairing so either player can request a true direct rematch after
  // the game ends; a new game supersedes any pending rematch wish.
  a.lastOpponentId = b.id;
  b.lastOpponentId = a.id;
  a.lastStake = stake;
  b.lastStake = stake;
  a.lastSeat = 0;
  b.lastSeat = 1;
  a.rematchWanted = false;
  b.rematchWanted = false;
  wireRoom(room);
  persistSession(a);
  persistSession(b);
  room.start();
}

/** Both players revealed their entropy → bind the committed seed and start play. */
function finalizeGame(p: PendingReveal): void {
  pendingReveals.delete(p.gameId);
  const fairness = finalizeFairness(p.serverSeed, p.commit, p.entropies[0] ?? '', p.entropies[1] ?? '');
  startRoom(p.gameId, p.stake, p.a, p.b, fairness, p.freeroll);
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

/** Enqueue an automatic refund for a staked 1v1 that must NOT proceed (a pre-Room
 *  abort, a disconnect during entropy reveal, or a squatted gameId). The durable
 *  queue reads the on-chain status and recovers any deposit — refund the lone
 *  staker (WaitingOpponent) or void both stakes (Active) — instead of stranding it
 *  until a manual refundExpired. No-op for non-staked or wallet-less games. */
function scheduleRefund1v1(p: PendingReveal): void {
  if (!settlementQueue || p.stake <= 0 || !p.a.wallet || !p.b.wallet) return;
  settlementNotify.set(p.gameId, { sessionIds: [p.a.id, p.b.id], winner: 0 });
  settlementQueue.enqueueRefund(p.gameId).catch((e) => console.error('[settlement] enqueue refund', e));
}

/** Tear down a pending staked match before the Room exists: drop the pending
 *  entry, free both players to queue again, tell them, and auto-refund any locked
 *  stake. Centralised so every abort path (timeout, RPC exhaustion, depositor
 *  mismatch, disconnect) recovers funds identically (R-SETTLE-1/3/4). */
function abortPendingStaked(p: PendingReveal, message: string, alert?: string): void {
  if (pendingReveals.get(p.gameId) !== p) return; // already torn down
  pendingReveals.delete(p.gameId);
  p.a.pendingGameId = undefined;
  p.b.pendingGameId = undefined;
  const err: ServerMsg = { t: 'error', code: 'INTERNAL', message };
  p.a.send(err);
  p.b.send(err);
  scheduleRefund1v1(p);
  if (alert) {
    console.error(alert);
    postOpsAlert(alert);
  }
}

/** Poll the escrow until both stakes are Active, then start; abort on timeout. */
function pollStakeLock(p: PendingReveal, attempt: number): void {
  if (pendingReveals.get(p.gameId) !== p) return; // finalized or aborted
  void arbiter!
    .gameStatus(p.gameId)
    .then(({ status, playerA, playerB }) => {
      if (pendingReveals.get(p.gameId) !== p) return;
      if (status === GameStatus.Active) {
        // R-SETTLE-3: `join` is permissionless and the gameId is known to both
        // clients, so a stranger who learns it could fill the second seat. Before
        // starting, verify the on-chain depositors ARE the two matched players —
        // otherwise void both deposits and cancel, never play a mismatched escrow.
        const want = [p.a.wallet!.toLowerCase(), p.b.wallet!.toLowerCase()].sort();
        const got = [playerA.toLowerCase(), playerB.toLowerCase()].sort();
        if (want[0] !== got[0] || want[1] !== got[1]) {
          abortPendingStaked(
            p,
            'Stake verification failed — match cancelled. Any locked stake is refunded shortly.',
            `[stake-gate][ALERT] ${p.gameId} depositor mismatch: matched {${want.join(', ')}} but escrow holds {${got.join(', ')}} — voiding.`,
          );
          return;
        }
        finalizeGame(p);
        return;
      }
      if (attempt >= MAX_LOCK_POLLS) {
        // Stakes never both locked. Abort + auto-refund whoever DID lock.
        abortPendingStaked(p, 'Stakes were not locked in time — match cancelled. Any locked stake is refunded shortly.');
        console.warn(`[stake-gate] ${p.gameId} aborted: stakes not Active after ${attempt} polls`);
        return;
      }
      setTimeout(() => pollStakeLock(p, attempt + 1), LOCK_POLL_MS);
    })
    .catch((e) => {
      console.error('[stake-gate] gameStatus poll failed', e instanceof Error ? e.message : e);
      if (pendingReveals.get(p.gameId) !== p) return;
      if (attempt >= MAX_LOCK_POLLS) {
        // R-SETTLE-4: the poll exhausted on persistent RPC errors. It used to stop
        // silently — leaking any locked deposit and wedging pendingGameId (players
        // couldn't re-queue until they disconnected). Abort + refund like the
        // success-path timeout instead.
        abortPendingStaked(p, 'Could not confirm stakes on-chain — match cancelled. Any locked stake is refunded shortly.');
        console.warn(`[stake-gate] ${p.gameId} aborted: gameStatus poll errored out after ${attempt} attempts`);
        return;
      }
      setTimeout(() => pollStakeLock(p, attempt + 1), LOCK_POLL_MS);
    });
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// ---- 4-player online Sit&Go (ticket entry, bot-filled) --------------------

/** Remove a session from the free OR staked 4-player wait queues (no on-chain
 *  money is locked until match.found4, so leaving a queue needs no refund). */
function leave4(sessionParam: Session): void {
  const i = freeroll4Waiting.indexOf(sessionParam);
  if (i >= 0) freeroll4Waiting.splice(i, 1);
  if (freeroll4Waiting.length === 0 && freeroll4Timer) {
    clearTimeout(freeroll4Timer);
    freeroll4Timer = null;
  }
  for (const [, q] of staked4) {
    const j = q.waiting.indexOf(sessionParam);
    if (j >= 0) q.waiting.splice(j, 1);
    if (q.waiting.length === 0 && q.timer) {
      clearTimeout(q.timer);
      q.timer = null;
    }
  }
}

/** Profile W/L for a finished 4-player game: every human seat played a game; the
 *  human at the winning seat gets a win — UNLESS that seat was handed to a bot
 *  (the human resigned/dropped/auto-forfeited), so a quitter isn't credited a win
 *  a bot earned. Anon/bot player rows just no-op. */
function recordRoom4Stats(humans: Session[], winnerSeat: number, seats: Seat4[]): void {
  humans.forEach((h, seat) => {
    const pid = playerId(h.wallet, h.id);
    store.recordPlayed(pid).catch((e) => console.error('[profile] recordPlayed4', e));
    if (seat === winnerSeat && !seats[seat]?.bot) {
      store.recordWin(pid).catch((e) => console.error('[profile] recordWin4', e));
    }
  });
}

/** First bot identity (from `seat`'s slot onward) whose name is still free at the
 *  table, so no two seats ever share a name. Falls back to a numbered suffix in
 *  the impossible case that every bot name is taken. */
function pickBot4(taken: ReadonlySet<string>, seat: number): { name: string; flag: string } {
  for (let k = 0; k < BOT4_NAMES.length; k++) {
    const cand = BOT4_NAMES[(seat + k) % BOT4_NAMES.length]!;
    if (!taken.has(cand.name.toLowerCase())) return cand;
  }
  const base = BOT4_NAMES[seat % BOT4_NAMES.length]!;
  return { name: `${base.name} ${seat + 1}`, flag: base.flag };
}

/** `base`, or "base 2"/"base 3"… if the table already shows that name. Nobody
 *  picks their own display name here — a guest's is drawn from a 32-name pool, so
 *  two players at one table hit the same one often (~18% with four humans). Since
 *  a quadrant label is JUST the name (no flag by design), two identical labels
 *  are unreadable. Display only: the durable player row keeps the real name. */
function uniqueAtTable(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n <= TABLE4.seats; n++) {
    const cand = `${base} ${n}`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return base;
}

function startRoom4(humans: Session[]): void {
  const gameId = randomBytes(16).toString('hex');
  const seats: Seat4[] = [];
  const seatSeeds: string[] = [];
  // No two seats may show the same label. Every 4p label comes from THIS payload
  // (including each player's own), so disambiguating here is consistent on every
  // screen. Bots must not borrow a human's name either — BOT4_NAMES overlaps the
  // guest pool (both hold "Amara"), which put a human and a bot under one name.
  const taken = new Set<string>();
  for (let i = 0; i < TABLE4.seats; i++) {
    const h = humans[i];
    if (h) {
      const name = uniqueAtTable(h.name, taken);
      taken.add(name.toLowerCase());
      seats.push({ client: h, bot: false, name, flag: h.flag, pid: h.wallet ? pidFor(playerId(h.wallet, h.id)) : undefined, frame: h.frame, avatar: h.avatar });
      seatSeeds.push(h.entropyCommit || h.entropy || randomSeatSeed());
    } else {
      const bot = pickBot4(taken, i);
      taken.add(bot.name.toLowerCase());
      seats.push({ client: null, bot: true, name: bot.name, flag: bot.flag });
      seatSeeds.push(randomSeatSeed());
    }
  }
  const fairness = createFairness4(seatSeeds);
  const room = new Room4(gameId, seats, fairness, 0, 0); // free table: no tickets, no cUSD
  room.onResult = (r) => recordRoom4Stats(humans, r.winnerSeat, r.seats);
  room.onEnd = () => rooms4.delete(gameId);
  rooms4.set(gameId, room);
  const players = room.players();
  humans.forEach((h, seat) => {
    h.room4 = room;
    h.seat4 = seat;
    h.send({
      t: 'match.found4',
      gameId,
      seat,
      players,
      entryTickets: 0,
      prizeTickets: 0,
      stakeCents: 0,
      potCents: 0,
      fairnessCommit: fairness.commit,
    });
  });
  room.start();
}

/** Start a 4-player game when the queue is full, or (force) after the bot-fill wait. */
function tryStartFreeroll4(force: boolean): void {
  if (freeroll4Waiting.length >= TABLE4.seats || (force && freeroll4Waiting.length >= 1)) {
    if (freeroll4Timer) {
      clearTimeout(freeroll4Timer);
      freeroll4Timer = null;
    }
    const humans = freeroll4Waiting.splice(0, TABLE4.seats);
    startRoom4(humans);
    if (freeroll4Waiting.length > 0) freeroll4Timer = setTimeout(() => tryStartFreeroll4(true), TABLE4.botFillMs);
  }
}

// ---- staked cUSD 4-player (LudoEscrowN) ------------------------------------

/** 4 real stakers gathered → run the staked table. */
function tryStartStaked4(stake: number): void {
  const q = staked4Queue(stake);
  if (q.waiting.length < TABLE4.seats) return;
  if (q.timer) {
    clearTimeout(q.timer);
    q.timer = null;
  }
  const humans = q.waiting.splice(0, TABLE4.seats);
  startStakedRoom4(humans, stake);
}

/** The staked queue never gathered 4 stakers → release them. No money was locked
 *  yet (deposits only happen after match.found4), so there's nothing to refund. */
function cancelStaked4(stake: number): void {
  const q = staked4Queue(stake);
  if (q.timer) {
    clearTimeout(q.timer);
    q.timer = null;
  }
  for (const s of q.waiting.splice(0, q.waiting.length)) {
    s.send({ t: 'error', code: 'LIMIT_REACHED', message: 'Not enough players for a staked table right now — try the free table or a different stake.' });
  }
}

/** Announce the staked match; each client locks its stake in LudoEscrowN, then the
 *  server polls until all 4 are Active before starting play (C3 for 4-player). */
function startStakedRoom4(humans: Session[], stake: number): void {
  if (!arbiterN) return;
  const gameId = randomBytes(16).toString('hex');
  const pot = potCents4(stake);
  const rake = stake * 4 - pot;
  // Anti-grinding (R-DICE-3): commit the seed knowing ONLY the seat commits, then
  // wait for each human to reveal its raw entropy. Staked 4p is all-human, so every
  // dice input is committed before the server can see it (matches the 2p scheme).
  const { serverSeed, commit } = createSeed4Commit();
  const seatCommits = humans.map((h) => h.entropyCommit || h.entropy || randomSeatSeed());
  const players: Player4Info[] = humans.map((h) => ({ name: h.name, flag: h.flag, bot: false, pid: h.wallet ? pidFor(playerId(h.wallet, h.id)) : undefined, frame: h.frame, avatar: h.avatar }));
  pendingStaked4.set(gameId, { gameId, humans, stake, pot, rake, serverSeed, commit, seatCommits, reveals: humans.map(() => null) });
  // count each seat's stake toward the daily limit (E5.2)
  void Promise.all(humans.map((h) => store.addDailyStake(playerId(h.wallet, h.id), utcToday(), stake))).catch((e) => console.error('[4p] dailyStake', e));
  humans.forEach((h, seat) => {
    h.pendingGameId = gameId; // block other joins while staking
    h.send({ t: 'match.found4', gameId, seat, players, entryTickets: 0, prizeTickets: 0, stakeCents: stake, potCents: pot, fairnessCommit: commit });
  });
  pollStaked4Lock(gameId, 0);
}

/** All four seats revealed their raw entropy (R-DICE-3)? Only then can the dice
 *  be bound to inputs the server committed to blind. */
function allRevealed4(p: PendingStaked4): boolean {
  return p.reveals.every((r) => r !== null);
}

/** A reveal arrived out of order (before stakes locked): if every seat has now
 *  revealed AND the escrow is already Active, start immediately instead of waiting
 *  for the next poll tick. Otherwise the lock poll drives the start. */
function maybeStartStaked4(p: PendingStaked4): void {
  if (!allRevealed4(p) || !arbiterN) return;
  void arbiterN
    .gameStatus(p.gameId)
    .then(({ status }) => {
      if (pendingStaked4.get(p.gameId) === p && status === GameStatusN.Active) startStaked4Room(p);
    })
    .catch(() => {
      /* the lock poll will retry */
    });
}

function pollStaked4Lock(gameId: string, attempt: number): void {
  const p = pendingStaked4.get(gameId);
  if (!p || !arbiterN) return;
  void arbiterN
    .gameStatus(gameId)
    .then(({ status }) => {
      if (pendingStaked4.get(gameId) !== p) return;
      // Start only when the money is locked AND fairness can be bound to all four
      // revealed entropies. If stakes are Active but a reveal is still missing, keep
      // polling — the MAX_LOCK_POLLS timeout below tears down + refunds a table that
      // never completes (a seat that never reveals).
      if (status === GameStatusN.Active && allRevealed4(p)) {
        startStaked4Room(p);
        return;
      }
      if (attempt >= MAX_LOCK_POLLS) {
        pendingStaked4.delete(gameId);
        for (const h of p.humans) {
          h.pendingGameId = undefined;
          h.send({ t: 'error', code: 'INTERNAL', message: 'Not all 4 stakes were locked in time — table cancelled. Any locked stake is refunded shortly.' });
        }
        scheduleRefundUnfilled4(gameId, p.humans);
        return;
      }
      setTimeout(() => pollStaked4Lock(gameId, attempt + 1), LOCK_POLL_MS);
    })
    .catch((e) => {
      console.error('[4p stake-gate] poll failed', e instanceof Error ? e.message : e);
      if (attempt < MAX_LOCK_POLLS && pendingStaked4.get(gameId) === p) setTimeout(() => pollStaked4Lock(gameId, attempt + 1), LOCK_POLL_MS);
    });
}

/** All 4 stakes Active AND all entropies revealed → bind the dice to the reveals
 *  (R-DICE-3) and start the Room4, settling the winner on win. */
function startStaked4Room(p: PendingStaked4): void {
  pendingStaked4.delete(p.gameId);
  // Bind the committed seed to the now-revealed raw seat seeds. allRevealed4 gated
  // this call, so every reveal is present; `?? ''` only satisfies the type.
  const fairness = finalizeFairness4(p.serverSeed, p.commit, p.reveals.map((r) => r ?? ''));
  const seats: Seat4[] = p.humans.map((h) => ({ client: h, bot: false, name: h.name, flag: h.flag, pid: h.wallet ? pidFor(playerId(h.wallet, h.id)) : undefined, frame: h.frame, avatar: h.avatar }));
  const room = new Room4(p.gameId, seats, fairness, 0, 0, p.pot, p.rake);
  room.onResult = (r) => {
    recordRoom4Stats(p.humans, r.winnerSeat, r.seats);
    settleStaked4(p, r.winnerSeat);
  };
  room.onEnd = () => rooms4.delete(p.gameId);
  rooms4.set(p.gameId, room);
  p.humans.forEach((h, seat) => {
    h.pendingGameId = undefined;
    h.room4 = room;
    h.seat4 = seat;
  });
  room.start();
}

/** Winner decided → durably settle the payout on LudoEscrowN. The job is
 *  persisted and resumed at boot, so a crash before the tx mines never loses it. */
function settleStaked4(p: PendingStaked4, winnerSeat: number): void {
  const winner = p.humans[winnerSeat];
  if (!winner?.wallet || !settlementQueue4) return;
  settlement4Notify.set(p.gameId, { sessionIds: p.humans.map((h) => h.id), winnerSeat });
  settlementQueue4
    .enqueue(p.gameId, getAddress(winner.wallet))
    .catch((e) => console.error('[settlement4] enqueue', e));
}

/** Refund every depositor of a table that never filled. Durable: the queue waits
 *  out the on-chain JOIN_TIMEOUT before submitting refundUnfilled, and survives a
 *  restart mid-wait (the pre-existing in-memory setTimeout did not). */
function scheduleRefundUnfilled4(gameId: string, humans: Session[]): void {
  if (!settlementQueue4) return;
  settlement4Notify.set(gameId, { sessionIds: humans.map((h) => h.id), winnerSeat: -1 });
  settlementQueue4
    .enqueueRefundUnfilled(gameId)
    .catch((e) => console.error('[settlement4] enqueue refund', e));
}

// ELO windows widen while players wait: re-check the queues every second.
setInterval(() => {
  for (const { stake, pair } of matchmaker.sweep()) {
    Promise.all([store.queueRemove(pair[0].session.id), store.queueRemove(pair[1].session.id)])
      .then(() => startGame(stake, pair[0].session, pair[1].session))
      .catch((e) => console.error('[ludo-server] sweep startGame', e));
  }
  for (const { pair } of freerollMatchmaker.sweep()) {
    startFreeroll(pair[0].session, pair[1].session).catch((e) => console.error('[ludo-server] sweep freeroll', e));
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
