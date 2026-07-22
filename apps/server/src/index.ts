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
  SEASON_PREMIUM,
  STREAK_FREEZE,
  TABLE4,
  PREMIUM_SKINS,
  cosmeticSetById,
  featuredSetIdFor,
  FEATURED_SET_MULTIPLIER,
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
  winbackFor,
  FRIENDS_MAX,
  FRIEND_REQUESTS_MAX,
  type Comeback,
  type FriendInfo,
  type LimitsState,
  type RaceState,
  type StreakState,
  type Player4Info,
  type ResumedGame,
  type ServerMsg,
  type SettlementContracts,
  type StakeCents,
} from '@ludo/shared';

/** Current UTC date (YYYY-MM-DD) for daily-challenge / streak resets. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}
function utcYesterday(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}
function utcTwoDaysAgo(): string {
  return new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
}
function utcPlusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
import type { Seat } from '@ludo/game-engine';
import { Matchmaker } from './matchmaking.js';
import { RateLimiter } from './rateLimit.js';
import { Room, type Client } from './room.js';
import { createFairness, createFairness4, createSeed4Commit, createSeedCommit, finalizeFairness, finalizeFairness4, randomSeatSeed, sha256Hex, type Fairness, type Fairness4 } from './fairness.js';
import { Room4, BOT4_NAMES, type Seat4 } from './room4.js';
import { sameDepositors } from './depositors.js';
import { countryOf as geoCountryOf, isGeoBlocked as geoIsBlocked } from './geo.js';
import { miniPayOriginTrusted } from './originTrust.js';
import { createArbiter, GameStatus, SettlementQueue } from './settlement.js';
import { createArbiterN, GameStatusN, SettlementQueue4 } from './settlement4.js';
import { createCosmeticsVerifier } from './cosmetics.js';
import { budgetLeftCents, claimFpWallets, createRaceFaucet, faucetFailureMessage, jitClaimCents, jitDripCents, poolLeftCents, SEED_LIFETIME_MULT, seedDeficitCents, seedFpDrawCents, seedGrantCents, type RaceFaucet } from './race.js';
import { scoreEventGame, raceLeaderboard } from './raceScore.js';
import { applyHelloCosmetics } from './sessionCosmetics.js';
import { awardGameCrowns, buildSeasonState, buySeasonPremium, claimSeasonTier } from './season.js';
import { telemetry, tpid } from './telemetry.js';
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
  /** friend.* throttle: same anti-spam posture as profile.get (DB-bound). */
  lastFriendMsgAt?: number;
  /** race.claim throttle: it verifies a receipt + sends a funding tx. */
  lastRaceAt?: number;
  /** QA test session (see QA_KEY): isolated matchmaking, no ladder writes. */
  qa?: boolean;
  /** Equipped avatar frame (cosmetic, client-authoritative like dice skins). */
  frame?: string;
  /** Chosen profile avatar id (cosmetic, client-authoritative like the frame). */
  avatar?: string;
  /** Equipped DICE skin — relayed so the opponent's HUD shows this player's die. */
  diceSkin?: string;
  /** Equipped token (pawn) skin + entrance effect (cosmetics phase 1) — catalog-
   *  validated in parse, relayed to the opponent in match.found. */
  tokenSkin?: string;
  entranceFx?: string;
  /** Equipped victory effect (cosmetics phase 2) — the loser watches it too. */
  victoryFx?: string;
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
  /** Whether this connection's WS Origin may auto-prove a MiniPay wallet (R-AUTH-1).
   *  false ⇒ a MiniPay claim is NOT auto-proven (off a trusted origin). Undefined in
   *  dev/testnet (no allowlist configured) ⇒ treated as allowed. */
  miniPayOriginOk?: boolean;
}

// Geo-gating (E5.4/R-COMP-1): ALLOWLIST of ISO countries where staked play has
// been legally cleared. Unset = dev/testnet open mode (warned below); set — even
// to an empty string — = staking only in the listed countries, fail-closed on an
// unknown/unproven region (see geo.ts).
const STAKING_ALLOWED_COUNTRIES: ReadonlySet<string> | null =
  process.env.STAKING_ALLOWED_COUNTRIES === undefined
    ? null
    : new Set(process.env.STAKING_ALLOWED_COUNTRIES.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean));
// Shared secret proving a request came through the trusted edge (Cloudflare/Vercel/
// Fly proxy) that sets the geo header. The Fly server is directly reachable over
// WS, so cf-ipcountry & friends are client-forgeable unless the edge authenticates
// itself — the edge must set `x-edge-secret: <this>` alongside the country header.
const TRUSTED_EDGE_SECRET = (process.env.TRUSTED_EDGE_SECRET ?? '').trim();
// Origins allowed to auto-prove a MiniPay wallet (R-AUTH-1 defence-in-depth). Empty
// = dev/testnet behaviour (any origin). Set to the MiniPay webview origin in prod.
const MINIPAY_ALLOWED_ORIGINS = new Set(
  (process.env.MINIPAY_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
);
// Thin wrappers over the pure, unit-tested geo helpers (see geo.ts).
const countryOf = (headers: Record<string, string | string[] | undefined>): string | undefined =>
  geoCountryOf(headers, TRUSTED_EDGE_SECRET);
const isGeoBlocked = (country: string | undefined): boolean => geoIsBlocked(country, STAKING_ALLOWED_COUNTRIES);

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
// 1s cadence (was 3s): the poll is one cheap eth_call, and its granularity is
// pure match-start latency — after the SECOND player's join mines, the game
// waited up to a full poll period before anyone noticed both stakes were in.
const LOCK_POLL_MS = 1_000;
const MAX_LOCK_POLLS = 120; // same ~2 min window: generous for two Celo approve+join txs to mine

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

// ---- Friends & challenges (E-social 2) --------------------------------------

/** The live session (if any) for an internal player id — presence + push
 *  routing. Linear scan over the sessions map: bounded by concurrent sockets on
 *  this single-machine server, and only run on friend actions / hello. */
function liveSessionFor(targetId: string): Session | undefined {
  for (const s of sessions.values()) {
    if (s.alive && playerId(s.wallet, s.id) === targetId) return s;
  }
  return undefined;
}

/** Presence bookkeeping (E-social 2, living presence). In-memory ONLY: a server
 *  restart just degrades "seen 2 h ago" to plain offline — acceptable for a
 *  hint, and it spares the store a new table + write per disconnect. */
const lastSeenByPid = new Map<string, number>();
/** Last PRESENCE-driven friends.update per target — throttles flappy
 *  connections (metro wifi…) to one refresh per friend per window; graph
 *  changes (add/accept/remove) bypass this and always push. */
const presencePushAt = new Map<string, number>();
const PRESENCE_PUSH_MIN_MS = 10_000;

/** Rolling ANONYMISED trace of the friends flow, for production diagnosis of
 *  the reported "invitation not received / can't accept" without log access.
 *  In-memory, capped, short pid prefixes only. Served read-only on /health. */
const friendTrace: string[] = [];
function ftrace(ev: string): void {
  friendTrace.push(`${new Date().toISOString().slice(11, 19)} ${ev}`);
  if (friendTrace.length > 60) friendTrace.shift();
}

/** Tell my LIVE friends my presence flipped (connect/disconnect), throttled. */
async function notifyFriendsPresence(myId: string): Promise<void> {
  const fids = await store.getFriendIds(myId);
  const now = Date.now();
  for (const fid of fids.slice(0, FRIENDS_MAX)) {
    if (!liveSessionFor(fid)) continue;
    if (now - (presencePushAt.get(fid) ?? 0) < PRESENCE_PUSH_MIN_MS) continue;
    presencePushAt.set(fid, now);
    void pushFriendsUpdate(fid).catch(() => undefined);
  }
}

/** Public FriendInfo for an internal id (null for unknown/ephemeral players). */
/** A player counts as ONLINE this long after their last socket closed. The
 *  lobby is offline-first (one-shot hello syncs, no held socket), so a player
 *  parked on it flickers live only ~1 s per sync — a strict live-socket test
 *  would show them "offline" to every friend. Seen-within-90s covers the
 *  lobby's 45 s presence poll with margin. */
const ONLINE_GRACE_MS = 90_000;

async function friendInfoOf(id: string, withPresence: boolean): Promise<FriendInfo | null> {
  const prof = await store.getProfileByPid(pidFor(id));
  if (!prof) return null;
  const online = withPresence
    ? liveSessionFor(id) !== undefined || Date.now() - (lastSeenByPid.get(id) ?? 0) < ONLINE_GRACE_MS
    : undefined;
  return {
    pid: pidFor(id),
    name: prof.name,
    flag: prof.flag,
    elo: prof.elo,
    avatar: prof.avatar,
    frame: prof.frame,
    online,
    // "seen 2 h ago" hint for OFFLINE friends (in-memory, best effort).
    lastSeenTs: online === false ? lastSeenByPid.get(id) : undefined,
  };
}

/** All three friend lists (capped) as sent in hello.ok / friends.update:
 *  mutual friends, INCOMING requests, and OUTGOING (sent, unanswered) — the
 *  sender's view of pending invitations, withdrawable via friend.remove. */
async function buildFriendLists(id: string): Promise<{ friends: FriendInfo[]; requests: FriendInfo[]; outgoing: FriendInfo[] }> {
  const [fids, rids, oids] = await Promise.all([store.getFriendIds(id), store.getFriendRequestIds(id), store.getOutgoingRequestIds(id)]);
  const friends = (await Promise.all(fids.slice(0, FRIENDS_MAX).map((f) => friendInfoOf(f, true)))).filter(
    (x): x is FriendInfo => x !== null,
  );
  // Online friends first — they're the actionable ones (one-tap challenge).
  friends.sort((a, b) => Number(b.online ?? false) - Number(a.online ?? false));
  const requests = (await Promise.all(rids.slice(0, FRIEND_REQUESTS_MAX).map((f) => friendInfoOf(f, false)))).filter(
    (x): x is FriendInfo => x !== null,
  );
  const outgoing = (await Promise.all(oids.slice(0, FRIEND_REQUESTS_MAX).map((f) => friendInfoOf(f, false)))).filter(
    (x): x is FriendInfo => x !== null,
  );
  return { friends, requests, outgoing };
}

/** Reply with a player's own friends.update on a SPECIFIC socket — the one that
 *  sent the action. Friend actions travel over short-lived one-shot sockets
 *  (sendFriendAction), and a concurrent lobby-sync one-shot rebinds the shared
 *  Session.ws; replying via Session.ws (pushFriendsUpdate) could then land on the
 *  wrong socket, so the acting socket hangs and "accept" silently fails. Sending
 *  straight to `ws` makes the ack race-free. */
async function sendFriendsTo(ws: WebSocket, id: string): Promise<void> {
  const lists = await buildFriendLists(id);
  send(ws, { t: 'friends.update', friends: lists.friends, requests: lists.requests, outgoing: lists.outgoing });
}

/** Push a live friends.update to a player's active session, if any. */
async function pushFriendsUpdate(id: string): Promise<void> {
  const s = liveSessionFor(id);
  ftrace(`push→${pidFor(id).slice(0, 6)} live=${s ? 'yes' : 'no'}`);
  if (!s) return;
  const lists = await buildFriendLists(id);
  s.send({ t: 'friends.update', friends: lists.friends, requests: lists.requests, outgoing: lists.outgoing });
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
// Boot a subsystem factory WITHOUT letting a misconfigured secret crash-loop the
// whole process. A bad CHAIN, a missing escrow for the chain, or a malformed key
// used to THROW at module load (e.g. createArbiter's "No escrow address for chain
// N") → the machine boot-looped and took ALL play down, including FREE games. Now
// the faulty subsystem is disabled and logged LOUDLY, while the server still comes
// up. Disabling fails SAFE: no arbiter → staked play refused (R-COMP-2), no faucet
// → race.claim dormant — money never moves through a half-configured subsystem.
function bootSubsystem<T>(label: string, factory: () => T | null): T | null {
  try {
    return factory();
  } catch (e) {
    console.error(
      `[ludo-server] ${label} failed to initialise — DISABLED. The server stays UP (free play + everything else works); this subsystem is OFF until the config is fixed and redeployed. Cause:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}
// On-chain settlement (E3.3). null unless staking is armed AND a key is configured.
const arbiter = stakingEnabled ? bootSubsystem('settlement arbiter (staked 1v1)', createArbiter) : null;
// cUSD cosmetic-purchase verifier (rec 6). null until the CosmeticsStore is
// deployed → cosmetic.claim stays off (ticket unlocks still work regardless).
const cosmeticsVerifier = bootSubsystem('cosmetics verifier', createCosmeticsVerifier);
// Race Week faucet (event). null unless RACE_WEEK_ACTIVE=true + a funded faucet
// key + a deployed RacePass → race.claim stays dormant off-event.
const raceFaucet = bootSubsystem('Race Week faucet', createRaceFaucet);

// The provisioned Race Week budget is drawn down along TWO dimensions, tracked
// as two counters so the player-facing "prize pool" reflects only winnable money:
//   • PRIZE (POOL_SPENT_KEY): entry grants + JIT top-ups — cUSD that becomes a
//     stake and can be WON back through a game. This is what the gauge shows.
//   • GAS   (SEED_SPENT_KEY): cUSD seeded to burners to pay their own gas — a
//     pure operational cost of the faucet WALLET, never a prize. Invisible to
//     players (the faucet is a distinct wallet; showing gas drain the pool read
//     as "the faucet eats the prize pool").
// Both leave the one faucet wallet, so the pool CAP bounds their SUM (real
// budget guard); only PRIZE is surfaced as poolLeftCents.
const POOL_SPENT_KEY = 'race:pool:spent';
const SEED_SPENT_KEY = 'race:seed:spent';
async function raceSpend(s: Awaited<ReturnType<typeof createStore>>): Promise<{ prize: number; seed: number; total: number }> {
  const prize = Number((await s.getMeta(POOL_SPENT_KEY)) || '0');
  const seed = Number((await s.getMeta(SEED_SPENT_KEY)) || '0');
  return { prize, seed, total: prize + seed };
}

/** Client-facing Race Week state for hello.ok: dormant (undefined) off-event,
 *  else whether THIS wallet already claimed its grant + the funding params. */
async function raceStateFor(wallet: string | undefined): Promise<RaceState | undefined> {
  if (!raceFaucet) return undefined;
  const funded = wallet ? !!(await store.getMeta(`race:grant:${wallet.toLowerCase()}`)) : false;
  // Prize dimension only — gas seeds don't tick down the pool players race for.
  const { prize } = await raceSpend(store);
  return {
    active: true,
    quotaCents: raceFaucet.quotaCents,
    endsAt: raceFaucet.endsAt,
    funded,
    poolLeftCents: poolLeftCents(raceFaucet.poolCents, prize),
    poolCents: raceFaucet.poolCents,
    // The FIXED leaderboard prize (a separate off-chain wallet), shown on the
    // banner. Defaults to the faucet budget only if unset, but is meant to be the
    // real prize ($30 → 3000) so players see a stable reward, not the faucet drain.
    prizePoolCents: Number(process.env.RACE_PRIZE_POOL_CENTS ?? '3000') || 3000,
  };
}

// Serialise JIT top-ups so concurrent game finishes can't read-modify-write the
// pool counter or a wallet's funded total out from under each other (single Fly
// process → an async chain is enough, same posture as raceScore's board mutex).
let raceFundChain: Promise<unknown> = Promise.resolve();
/** JIT top-up: after a player COMPLETES an event game, drip the next stake to
 *  their wallet — bounded by their per-wallet quota AND the total pool. No-op
 *  unless the faucet is in JIT mode. Idempotency isn't required (a top-up per
 *  finished game is intended), but it never funds past `quotaCents`/`poolCents`.
 *  Fire-and-forget from onResult; failures are logged, never thrown. */
async function topUpRaceFunding(store: Awaited<ReturnType<typeof createStore>>, faucet: RaceFaucet, wallet: string): Promise<void> {
  if (!faucet.jit) return;
  const w = wallet.toLowerCase();
  const fundedKey = `race:funded:${w}`;
  // Only participants (claimed their Pass-gated grant) top up; skip demo wallets.
  if (!(await store.getMeta(`race:grant:${w}`))) return;
  const run = async () => {
    const funded = Number((await store.getMeta(fundedKey)) || '0');
    // JIT is a PRIZE draw; bound it by the TOTAL budget left (prize + gas already
    // spent) so the faucet never over-commits, but advance only the prize counter.
    const { prize, total } = await raceSpend(store);
    // Balance-aware (operator report: the faucet kept funding wallets that
    // already held USDT). The drip is a SAFETY NET, not an unconditional payout:
    // a wallet that can already afford the next stake+gas (a winner funding
    // itself from winnings) draws NOTHING; a drained wallet draws only its
    // deficit. A failed balance read falls back to the normal drip (never
    // freezes a real player out over a transient RPC hiccup).
    const balCents = await faucet.balanceCentsOf(wallet as Address).catch(() => null);
    const cents = jitDripCents(faucet.perGameCents, funded, faucet.quotaCents, total, faucet.poolCents, balCents);
    if (cents <= 0) return; // quota drawn, pool dry, OR the wallet is self-funded
    // Reserve BEFORE the transfer (same crash-safety as claim): a crash mid-send
    // can only UNDER-fund, never double-fund. Roll back both counters on revert.
    await store.setMeta(fundedKey, String(funded + cents));
    await store.setMeta(POOL_SPENT_KEY, String(prize + cents));
    try {
      await faucet.fund(wallet as Address, cents);
      telemetry('race.topup', { pid: tpid(w), cents, poolSpent: prize + cents });
    } catch (e) {
      await store.setMeta(fundedKey, String(funded));
      await store.setMeta(POOL_SPENT_KEY, String(prize));
      console.error('[race] top-up transfer failed', e);
    }
  };
  const next = raceFundChain.then(run, run);
  raceFundChain = next.catch(() => undefined);
  return next;
}
// N-player settlement for staked 4-player games (LudoEscrowN). null unless staking
// is armed AND the N-player escrow is deployed + configured.
const arbiterN = stakingEnabled ? bootSubsystem('settlement arbiter (staked 4p)', createArbiterN) : null;
// The escrow addresses the server will SETTLE against, advertised to the client in
// hello.ok so it can refuse to deposit into a mismatched escrow (server resolves
// from a Fly secret, client from a bundled copy — a redeploy could drift them).
// Present only when an arbiter is armed; both arbiters share one chain (CHAIN env).
const settlementContracts: SettlementContracts | undefined =
  arbiter || arbiterN
    ? {
        chainId: (arbiter ?? arbiterN)!.chainId,
        escrow: arbiter?.escrow.toLowerCase(),
        escrowN: arbiterN?.escrow.toLowerCase(),
      }
    : undefined;
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
      // Drop the notify entry on EVERY terminal outcome, not just the two that
      // notify players: a `failed` payout, an already-resolved game and a no-op
      // refund would otherwise keep their entry forever (an unbounded slow leak
      // only a long soak would surface).
      onTerminal: (gameId) => settlementNotify.delete(gameId),
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
      onTerminal: (gameId) => settlement4Notify.delete(gameId),
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
if (raceFaucet) console.log(`[ludo-server] Race Week ACTIVE — faucet ${raceFaucet.address}, quota ${raceFaucet.quotaCents}¢/player, pool ${raceFaucet.poolCents}¢, RacePass ${raceFaucet.racePass}`);
// Compliance nudge: real settlement is on but the staking allowlist is unset and
// the country header is only trustworthy behind a trusted edge (Cloudflare/Vercel).
// (Also fixes a mis-chained else: the full prod config used to log "settlement
// disabled" even with an arbiter configured.)
if (!arbiter) {
  console.warn('[ludo-server] settlement disabled (no ARBITER_PRIVATE_KEY)');
} else if (STAKING_ALLOWED_COUNTRIES === null) {
  console.warn('[compliance] settlement is ENABLED but STAKING_ALLOWED_COUNTRIES is unset — staked play is open in EVERY region (dev/testnet mode). Set the legal-reviewed allowlist (empty value = staking blocked everywhere) before real-money launch.');
} else if (!TRUSTED_EDGE_SECRET) {
  // An allowlist is set but the country header is not authenticated: geo fails
  // CLOSED (unknown region ⇒ no staked play), so legit players will be refused
  // until the edge sets x-edge-secret. Loud, because it blocks real-money play.
  console.warn('[compliance] STAKING_ALLOWED_COUNTRIES is set but TRUSTED_EDGE_SECRET is NOT — the geo header is spoofable, so staked play FAILS CLOSED for every unverified region. Configure the trusted edge to set `x-edge-secret` + the country header before launch.');
}

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
    room4Id: s.room4?.gameId ?? null,
    seat4: s.seat4 ?? null,
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

/** Snapshot a 4-player room after every transition (G-5). Serialized per gameId so
 *  writes never race. Staked 4p carries real money, so — like the 1v1 room — its
 *  in-flight state must survive a restart or 4 deposits strand with no record. */
function persistRoom4(room: Room4): void {
  const snap = room.toSnapshot();
  const prev = roomWrites.get(room.gameId) ?? Promise.resolve();
  roomWrites.set(
    room.gameId,
    prev.then(() => store.saveRoom4(snap)).catch((e) => console.error('[store] saveRoom4', e)),
  );
}

/** Settle a finished staked 4p game from the ROOM SEATS (not a live-session
 *  closure), so it works for a game restored after a restart too. The seats carry
 *  the depositor wallet + owning session id since G-5. */
function settleStaked4FromSeats(gameId: string, seats: Seat4[], winnerSeat: number, fairness?: Fairness4): void {
  const winnerWallet = seats[winnerSeat]?.wallet;
  if (!winnerWallet || !settlementQueue4) return;
  settlement4Notify.set(gameId, { sessionIds: seats.map((s) => s.sessionId ?? ''), winnerSeat });
  // Reveal the dice fairness on-chain: the seed + every seat's revealed seed.
  const reveal = fairness ? { serverSeed: fairness.serverSeed, entropies: [...fairness.seeds] } : undefined;
  settlementQueue4.enqueue(gameId, getAddress(winnerWallet), reveal).catch((e) => console.error('[settlement4] enqueue', e));
}

/** Accrue a finished game's season crowns for one player and push the light
 *  `season.progress` update if they're connected. Fire-and-forget: a crown-accrual
 *  hiccup must never disrupt settlement, stats, or the next match. `session` may be
 *  absent (a player who already disconnected) — the crowns are still recorded. */
function awardSeasonCrowns(pid: string, session: Session | undefined, isWinner: boolean): void {
  awardGameCrowns(store, pid, isWinner, utcToday())
    .then((a) => {
      session?.send({ t: 'season.progress', crowns: a.crowns, tier: a.tier, gained: a.gained, dailyGames: a.dailyGames });
      telemetry('season.crowns', { pid: tpid(pid), gained: a.gained, crowns: a.crowns, tier: a.tier, dailyGames: a.dailyGames, won: isWinner });
    })
    .catch((e) => console.error('[season] awardGameCrowns', e));
}

/** Win-back offer (season Phase 3): a returning wallet player, absent ≥3 days, is
 *  granted non-cashable comeback tickets — UNLESS they're self-excluded (RG). Idempotent
 *  per day: recordLogin reports daysAway only on the day-transition. Returns the
 *  offer to surface in hello.ok (and mutates `streak` so its ticket total is fresh). */
async function applyWinback(pid: string, streak: StreakState | undefined, limits: LimitsState): Promise<Comeback | undefined> {
  if (!streak || streak.daysAway === undefined || streak.daysAway < 3) return undefined;
  if (limits.selfExcludedUntil) return undefined; // RG: never re-engage a self-excluded player
  const offer = winbackFor(streak.daysAway);
  if (!offer) return undefined;
  const total = await store.grantTickets(pid, offer.tickets);
  streak.tickets = total; // keep the ticket count in hello.ok consistent with the grant
  telemetry('winback', { pid: tpid(pid), daysAway: streak.daysAway, tickets: offer.tickets });
  telemetry('tickets', { pid: tpid(pid), delta: offer.tickets, reason: 'winback', total });
  return { daysAway: streak.daysAway, tickets: offer.tickets };
}

/** Best-effort player stats (played/win) for a finished 4p game, from the seats. */
function recordRoom4StatsFromSeats(seats: Seat4[], winnerSeat: number): void {
  seats.forEach((s, seat) => {
    if (s.bot || !s.sessionId) return;
    const pid = playerId(s.wallet, s.sessionId);
    store.recordPlayed(pid).catch((e) => console.error('[profile] recordPlayed4', e));
    if (seat === winnerSeat) store.recordWin(pid).catch((e) => console.error('[profile] recordWin4', e));
    awardSeasonCrowns(pid, sessions.get(s.sessionId), seat === winnerSeat);
  });
}

/** Wire a staked 4p room's lifecycle so it is restart-safe: persist on every
 *  change, settle + record from the seats on finish, and clean up on end. Used by
 *  both a freshly started room and one restored from a snapshot at boot. */
function wireStakedRoom4(room: Room4): void {
  room.onChange = persistRoom4;
  room.onResult = (r) => {
    recordRoom4StatsFromSeats(r.seats, r.winnerSeat);
    settleStaked4FromSeats(r.gameId, r.seats, r.winnerSeat, r.fairness);
  };
  room.onEnd = () => {
    rooms4.delete(room.gameId);
    detachSessionsFromRoom4(room);
    // The terminal snapshot is dropped once settlement is safely enqueued (durable
    // job); the queue's own record + resumePending then own recovery. Delete after
    // a tick so a same-turn crash still leaves the over=true snapshot to reconcile.
    void store.deleteRoom4(room.gameId).catch((e) => console.error('[store] deleteRoom4', e));
  };
}

/** Clear the 4p room membership from every seat's session and persist it, so a
 *  reconnect after the game ends does not try to reattach to a dead room. */
function detachSessionsFromRoom4(room: Room4): void {
  for (const s of room.seatSessions()) {
    const sess = sessions.get(s);
    if (sess && sess.room4 === room) {
      sess.room4 = null;
      sess.seat4 = null;
      persistSession(sess);
    }
  }
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

    const winnerId = result.winner === 0 ? idA : idB;
    const loserId = result.winner === 0 ? idB : idA;
    const winnerSession = sessions.get(result.players[result.winner].id);
    const loserSession = sessions.get(result.players[result.winner === 0 ? 1 : 0].id);
    // QA games keep the audit trail (recordGame/ELO above) but must not grant
    // rewards — test traffic must not touch the season/economy.
    if (room.qa) return;
    // Profile W/L: bump the winner's win count (games_played is bumped in updateElo).
    // (The weekly league was retired — it duplicated the season pass's progression
    //  role and its ticket rollover was an inflation faucet.)
    store.recordWin(winnerId).catch((e) => console.error('[profile] recordWin', e));

    // Season pass: every finished (non-QA) game earns crowns — the wealth-neutral
    // engagement sink that also drives retention. Both players earn; the winner
    // gets the win bonus. Pushed live so the track fills on the end screen.
    awardSeasonCrowns(winnerId, winnerSession, true);
    awardSeasonCrowns(loserId, loserSession, false);

    // Race Week leaderboard: a STAKED game between two event participants scores
    // (win + participation), anti-wash-traded inside scoreEventGame. Only while
    // the event is armed (raceFaucet != null). Fire-and-forget.
    if (raceFaucet && result.stakeCents > 0 && pa.wallet && pb.wallet) {
      const winW = result.winner === 0 ? pa.wallet : pb.wallet;
      const winN = result.winner === 0 ? pa.name : pb.name;
      const loseW = result.winner === 0 ? pb.wallet : pa.wallet;
      const loseN = result.winner === 0 ? pb.name : pa.name;
      void scoreEventGame(store, { winnerWallet: winW, winnerName: winN, loserWallet: loseW, loserName: loseN, day: utcToday() }).catch((e) =>
        console.error('[race] score', e),
      );
      // JIT top-up (mainnet anti-fund-and-run): a player is funded ONE stake at a
      // time. Having just COMPLETED a staked event game, each participant earns the
      // next stake — dripped up to their quota, pool-capped. A wallet that claims
      // and never plays never reaches this hook, so it can't drain past the first
      // grant. Off unless RACE_JIT_FUNDING=true (the lump-sum event is unaffected).
      // BOTH players drip at game.end — including the winner whose payout is
      // still in flight. Deferring the winner's drip to the settlement terminal
      // was tried (it avoids topping up a wallet about to be paid) and REGRESSED
      // the INSTANT rematch: a settle takes seconds on Celo, so a winner who
      // clicked Rejouer right away had 0c spendable and the rematch stake lock
      // reverted on funds. The pre-settle drip is a deliberate BRIDGE: it costs
      // the faucet at most one perGame per win, is bounded by the wallet's
      // lifetime quota, and self-corrects — once the payout lands the wallet is
      // above target and every later drip is 0 (balance-aware).
      if (raceFaucet.jit) {
        void topUpRaceFunding(store, raceFaucet, winW);
        void topUpRaceFunding(store, raceFaucet, loseW);
      }
    }

    // Participation (beta model: freeroll uptake, stake mix). Opaque pids only.
    telemetry('game.end', { winner: tpid(winnerId), loser: tpid(loserId), stakeCents: result.stakeCents, freeroll: !!result.freeroll });

    // Freeroll prize: winner takes the pot in tickets (a slight net sink vs the
    // two entries — see FREEROLL). A faucet event for the ticket-inflation index.
    if (result.freeroll) {
      store
        .grantTickets(winnerId, FREEROLL.winnerTickets)
        .then((total) => {
          winnerSession?.send({ t: 'tickets.grant', granted: FREEROLL.winnerTickets, total, reason: 'freeroll-win' });
          telemetry('tickets', { pid: tpid(winnerId), delta: FREEROLL.winnerTickets, reason: 'freeroll-win', total });
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
      // Reveal the dice fairness on-chain at settlement (provably-fair anchor): the
      // seed whose sha256 is the escrow's fairnessCommit + both entropies.
      const reveal = { serverSeed: result.fairness.serverSeed, entropies: [...result.fairness.entropies] };
      settlementQueue.enqueue(result.gameId, winnerWallet, reveal).catch((e) => {
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
      const reveal = { serverSeed: snap.fairness.serverSeed, entropies: [...snap.fairness.entropies] };
      await settlementQueue.enqueue(snap.gameId, winnerWallet, reveal).catch((e) => console.error('[settlement] boot re-enqueue', e));
      console.warn(`[settlement] re-enqueued orphaned staked game ${snap.gameId} (crash between game-over and settlement)`);
    }
  }
}
// Restore in-progress 4-player games (G-5). Staked 4p carries real money, so a
// restart must not drop the game: an unrestored table strands 4 deposits with no
// server record to settle or refund them.
for (const snap of await store.loadRooms4()) {
  const room = Room4.fromSnapshot(snap);
  wireStakedRoom4(room); // persistence + settle/record-from-seats + cleanup (safe for free tables too: no wallet ⇒ settle no-ops)
  rooms4.set(snap.gameId, room);
  room.resume(); // restart the clock so bots/auto-play drive it to a finish even if nobody reconnects
  console.log(`[ludo-server] restored 4p game ${snap.gameId} (payout ${snap.payoutCents}c)`);
  // R-SETTLE-2 (4p): a staked game can persist its terminal snapshot then crash
  // before settle enqueues. Re-enqueue any finished staked 4p with no record yet.
  const winnerSeat = snap.over ? snap.state.winner : null;
  if (settlementQueue4 && snap.payoutCents > 0 && winnerSeat != null) {
    const winnerWallet = snap.seats[winnerSeat]?.wallet;
    if (winnerWallet && !(await store.hasSettlement(snap.gameId))) {
      settlement4Notify.set(snap.gameId, { sessionIds: snap.seats.map((s) => s.sessionId), winnerSeat });
      const reveal = { serverSeed: snap.fairness.serverSeed, entropies: [...snap.fairness.seeds] };
      await settlementQueue4.enqueue(snap.gameId, getAddress(winnerWallet), reveal).catch((e) => console.error('[settlement4] boot re-enqueue', e));
      console.warn(`[settlement4] re-enqueued orphaned staked 4p game ${snap.gameId} (crash between game-over and settlement)`);
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

// The weekly league was retired: it duplicated the season pass's progression role
// and its weekly ticket rollover was an inflation faucet the season economy is
// designed to avoid. No points are awarded and no rollover runs; the season pass
// is the single progression system. (Store league methods are kept but unused.)

// Season pass rollover: the store starts the next season once the window ends
// (and lazily resets per-player progress). Checked at boot and hourly so a restart
// never leaves an expired season live. `getSeason` also seeds season 1 on first boot.
async function maybeRolloverSeason(): Promise<void> {
  const now = new Date().toISOString();
  const before = await store.getSeason(now);
  if (await store.rolloverSeason(now)) {
    const after = await store.getSeason(now);
    console.log(`[season] rollover ${before.id} → ${after.id} (ends ${after.endsAt})`);
    telemetry('season.rollover', { from: before.id, to: after.id, endsAt: after.endsAt });
  }
}
await maybeRolloverSeason().catch((e) => console.error('[season] rollover', e));
setInterval(() => void maybeRolloverSeason().catch((e) => console.error('[season] rollover', e)), 3_600_000);

// ---------- http + ws ----------

const http = createServer((req, res) => {
  // Liveness: the process is up. Kept unconditional so the orchestrator never
  // kills a running server just because a dependency blipped.
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    // `friends` = the rolling anonymised friend-flow trace (production diagnosis
    // of "invitation not received / can't accept"); harmless to expose — short
    // pid prefixes only, which are public in-app identifiers anyway.
    res.end(JSON.stringify({ ok: true, sessions: sessions.size, rooms: rooms.size, friends: friendTrace.slice(-40) }));
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
  // WS Origin (browsers set it and forbid JS from overriding it) → whether a
  // MiniPay auto-prove may be trusted on this connection (R-AUTH-1 defence).
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  const miniPayOriginOk = miniPayOriginTrusted(origin, MINIPAY_ALLOWED_ORIGINS);
  let qaConn = false;
  if (QA_KEY !== '') {
    try {
      qaConn = new URL(req.url ?? '/', 'ws://x').searchParams.get('qa') === QA_KEY;
    } catch {
      qaConn = false;
    }
  }
  // Authorized QA/load-test connections (they carry the secret QA_KEY) are exempt
  // from the per-IP connection cap, the ban list and the rate limiter — a load run
  // (Phase 4 bot sim, Phase 6 load) drives thousands of fast actions from ONE host,
  // which the prod-facing limits would throttle. Real users never have QA_KEY, so
  // prod protection is unchanged.
  if (!qaConn && limiter.isBanned(ip)) {
    send(ws, { t: 'error', code: 'LIMIT_REACHED', message: 'Temporarily banned. Try again later.' });
    ws.close();
    return;
  }
  const liveForIp = connsByIp.get(ip) ?? 0;
  if (!qaConn && liveForIp >= MAX_CONNS_PER_IP) {
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
    const verdict = qaConn ? 'ok' : limiter.allow(connKey, ip);
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
        // Anti-grinding commit: the game connection nearly ALWAYS resumes (the
        // lobby's one-shot sync minted the token first), so without this the
        // commit sent in the game hello was dropped and startGame refused every
        // staked pairing ("fair-dice handshake required") — both players were
        // silently bounced from the queue and the search spun forever. Guarded:
        // a commit-less one-shot resume must not CLEAR a live game's commit
        // (rooms snapshot seatCommits at start, but the reveal check reads this).
        if (msg.entropyCommit) resumedSession.entropyCommit = msg.entropyCommit;
        resumedSession.country = country;
        resumedSession.ip = ip;
        resumedSession.miniPay = msg.miniPay === true;
        resumedSession.miniPayOriginOk = miniPayOriginOk;
        // ALL equipped cosmetics refresh on resume (not just frame/avatar) — see
        // applyHelloCosmetics: the game hello always resumes, so dropping the
        // phase-1/2 cosmetics here hid them from the opponent in match.found.
        applyHelloCosmetics(resumedSession, msg);
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
        let rChallenge = await store.getChallenge(rpid, utcToday());
        const rStreak = resumedSession.wallet ? await store.recordLogin(rpid, utcToday(), utcYesterday(), utcTwoDaysAgo()) : undefined;
        const rLimits = await store.getLimits(rpid, utcToday());
        const rComeback = resumedSession.wallet ? await applyWinback(rpid, rStreak, rLimits) : undefined;
        if (rComeback) rChallenge = await store.getChallenge(rpid, utcToday()); // refresh ticket total
        // Friends (E-social 2): the wallet-proven hello that actually populates the
        // lobby is almost ALWAYS this resumed path — the first (token-minting) hello
        // fires before the MiniPay wallet connects, so it's unproven, and the sync
        // after wallet-connect carries the token and RESUMES. Omitting the lists
        // here left every real user's requests/friends invisible in the lobby
        // (they only ever arrived via the live friends.update push, lost on reload).
        const rFriendLists = rProof.walletProven ? await buildFriendLists(rpid) : undefined;
        if (resumedSession.wallet) {
          ftrace(`hello res pid=${pidFor(rpid).slice(0, 6)} proven=${rProof.walletProven === true} mini=${resumedSession.miniPay === true} orig=${resumedSession.miniPayOriginOk !== false} req=${rFriendLists?.requests.length ?? '-'} fr=${rFriendLists?.friends.length ?? '-'}`);
        }
        send(ws, {
          t: 'hello.ok',
          sessionToken: resumedSession.id,
          contracts: settlementContracts,
          elo: resumedSession.elo,
          name: resumedSession.name,
          flag: resumedSession.flag,
          games: rStats.gamesPlayed,
          wins: rStats.wins,
          pid: resumedSession.wallet ? pidFor(rpid) : undefined,
          frame: resumedSession.frame,
          avatar: resumedSession.avatar,
          resumed: resumedGame(resumedSession),
          challenge: rChallenge,
          streak: rStreak,
          limits: rLimits,
          ownedSkins: await store.getOwnedSkins(rpid),
          season: await buildSeasonState(store, rpid, new Date().toISOString()),
          race: await raceStateFor(resumedSession.wallet),
          comeback: rComeback,
          stakingBlocked: isGeoBlocked(country),
          walletNonce: rProof.walletNonce,
          walletProven: rProof.walletProven,
          consentTosVersion: resumedSession.consentTos,
          friends: rFriendLists?.friends,
          friendRequests: rFriendLists?.requests,
          friendsOutgoing: rFriendLists?.outgoing,
        });
        // Living presence: my friends' lobbies flip me to "online now".
        if (rProof.walletProven) void notifyFriendsPresence(rpid).catch(() => undefined);
        // R-WEB-1: if this session had a live 4-player seat (staked table), rebind
        // the new socket to it and resync — a dropped staker resumes instead of
        // forfeiting their locked stake. The room kept the seat during the grace
        // window (Room4.drop detaches without bot-forfeiting for staked tables).
        if (resumedSession.room4 && resumedSession.seat4 != null && !resumedSession.room4.isOver()) {
          resumedSession.room4.attach(resumedSession.seat4, resumedSession);
        }
        // A resumed session whose 1v1 match is still PENDING (deposits/reveals
        // in flight — no Room yet, so `resumed` above is undefined) gets its
        // match context REPLAYED: the original match.found may have died with
        // the previous socket (R-RT-1 takeover — e.g. a one-shot resuming the
        // same token closed the match socket mid-staking). Without the replay
        // the client concludes the game is gone, drops its match context, and
        // the eventual game.state strands it on a blank screen while auto-play
        // forfeits its LOCKED stake. Duplicate match.found / game.entropy are
        // no-ops on both sides, so replaying is always safe.
        if (resumedSession.pendingGameId) {
          const pend = pendingReveals.get(resumedSession.pendingGameId);
          if (pend) {
            const pSeat: Seat | null = pend.a === resumedSession ? 0 : pend.b === resumedSession ? 1 : null;
            if (pSeat !== null) {
              const pMe = pSeat === 0 ? pend.a : pend.b;
              const pOpp = pSeat === 0 ? pend.b : pend.a;
              resumedSession.send(matchFoundMsg(pend.gameId, pSeat, pMe, pOpp, pend.stake, potCents(pend.stake), pend.commit));
            }
          }
        }
        // Post-game resume: proactively RE-DELIVER a pending rematch offer. The
        // opponent's `rematch.offer` push (or an earlier `rematch.poll` answer) was
        // lost while THIS socket was down — the loser then sits on the end screen
        // never seeing Accept/Decline until the next 4 s client poll, and on a
        // flaky mobile socket that poll can keep missing. Re-sending here closes
        // the gap the instant the channel is back. Same guard as `rematch.poll`.
        if (!resumedSession.room && !resumedSession.pendingGameId && !resumedSession.rematchWanted) {
          const rematcher = resumedSession.lastOpponentId ? sessions.get(resumedSession.lastOpponentId) : undefined;
          if (
            rematcher &&
            rematcher.alive &&
            rematcher.rematchWanted &&
            rematcher.lastOpponentId === resumedSession.id &&
            !rematcher.room &&
            !rematcher.pendingGameId
          ) {
            resumedSession.send({ t: 'rematch.offer', name: label(rematcher) });
          }
        }
        return;
      }
      // A socket may legitimately re-hello (the web client does it on profile edit
      // and on wallet-connect-after-load), and each one mints a fresh Session below.
      // Only the closure `session` was rebound, so the PREVIOUS record stayed in the
      // global `sessions` map for the process lifetime — the close handler expires
      // the last session only. That leaked one Session per extra hello, unbounded.
      // Drop the superseded record here: one socket owns at most one idle session.
      // A session that is mid-game / mid-stake is left alone — its Room still points
      // at it, and killing it would strand a live (possibly staked) game; that case
      // is bounded by real games, not by message count.
      if (session && session.ws === ws && !session.room && !session.room4 && !session.pendingGameId) {
        sessions.delete(session.id);
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
      session.miniPayOriginOk = miniPayOriginOk; // origin gate for the auto-prove (R-AUTH-1)
      applyHelloCosmetics(session, msg); // frame/avatar/tokenSkin/entranceFx/victoryFx (validated in parse)
      sessions.set(id, session);
      persistSession(session);
      // Key off the NORMALIZED wallet — never raw msg.wallet. normalizeWallet maps a
      // non-address to undefined, so raw input here made a client-chosen string the
      // durable key: it both diverged from idKey (:822, normalized → `anon:<id>`),
      // splitting one player across two identities, and let any client write junk
      // rows under an arbitrary key of its choosing.
      const pid = playerId(wallet, id);
      let challenge = await store.getChallenge(pid, utcToday());
      // Streak is persisted only for wallet-linked players (anon rows are ephemeral).
      const streak = wallet ? await store.recordLogin(pid, utcToday(), utcYesterday(), utcTwoDaysAgo()) : undefined;
      const limits = await store.getLimits(pid, utcToday());
      // Win-back: grant comeback tickets to a returning absent player (RG-gated).
      const comeback = wallet ? await applyWinback(pid, streak, limits) : undefined;
      if (comeback) challenge = await store.getChallenge(pid, utcToday()); // refresh ticket total
      const ownedSkins = await store.getOwnedSkins(pid);
      const claimedSets = await store.getClaimedSets(pid);
      const season = await buildSeasonState(store, pid, new Date().toISOString());
      await recordConsent(session, msg.consent);
      const proof = issueWalletNonce(session);
      // Friends (E-social 2): only for a PROVEN wallet — the graph is durable
      // identity, and an unproven hello could claim any wallet's social circle
      // (same gate as h2h in profile.get). Unproven browser sessions get their
      // lists on the sync after wallet.prove.
      const friendLists = proof.walletProven ? await buildFriendLists(pid) : undefined;
      if (wallet) {
        ftrace(`hello new pid=${pidFor(idKey).slice(0, 6)} proven=${proof.walletProven === true} mini=${session.miniPay === true} orig=${session.miniPayOriginOk !== false} req=${friendLists?.requests.length ?? '-'} fr=${friendLists?.friends.length ?? '-'}`);
      }
      send(ws, {
        t: 'hello.ok',
        sessionToken: id,
        contracts: settlementContracts,
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
        limits,
        ownedSkins,
        claimedSets,
        season,
        race: await raceStateFor(wallet),
        comeback,
        stakingBlocked: isGeoBlocked(country),
        walletNonce: proof.walletNonce,
        walletProven: proof.walletProven,
        consentTosVersion: session.consentTos,
        friends: friendLists?.friends,
        friendRequests: friendLists?.requests,
        friendsOutgoing: friendLists?.outgoing,
      });
      // Living presence: my friends' lobbies flip me to "online now".
      if (proof.walletProven) void notifyFriendsPresence(pid).catch(() => undefined);
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
            // Now that the wallet is proven, this session can hold friends: push
            // the lists so a regular-wallet (non-MiniPay/SIWE) user gets them
            // without a second hello — mirrors the MiniPay resume path.
            void pushFriendsUpdate(playerId(session.wallet, session.id)).catch(() => undefined);
          } else {
            session.send({ t: 'error', code: 'BAD_STATE', message: 'Wallet verification failed.' });
          }
        } catch {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Wallet verification failed.' });
        }
        break;
      }

      case 'queue.join': {
        // A live Room = a real game in progress → refuse. But a PENDING staked
        // match (both stakes not locked yet) whose player is back here ASKING TO
        // QUEUE has plainly been abandoned client-side (their opponent's lock
        // failed and their own client returned to the lobby). Refusing with
        // 'Already in a game.' wedged that player for the rest of the ~2-min
        // stake-lock window; treat the re-queue as an explicit abandon instead —
        // abortPendingStaked refunds any stake already locked (R-SETTLE-1) and
        // frees both seats, then this queue.join proceeds normally.
        if (session.pendingGameId && !session.room) {
          const stale = pendingReveals.get(session.pendingGameId);
          if (stale) {
            abortPendingStaked(stale, 'Match abandoned — back to the lobby. Any locked stake is refunded shortly.', undefined, session);
          } else {
            session.pendingGameId = undefined; // dangling id (already torn down)
          }
        }
        if (session.room || session.pendingGameId) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Already in a game.' });
          break;
        }
        // Reject a duplicate join from a session that's already queued (a double
        // queue.join must not create two entries / self-pair). Checked across ALL
        // stakes, not just the requested one: the daily-limit check below reads a
        // counter that is only debited when a game starts, so one session holding
        // entries in several stake queues could pass every check and then exceed
        // the limit as each entry pairs.
        if (matchmaker.isQueued(session) || freerollMatchmaker.isQueued(session)) {
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
          const blocked4 = await stakeBlock(session, stake4 as StakeCents, !!arbiterN);
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

      // ---- Friends & challenges (E-social 2) ----
      case 'friend.add': {
        // Durable identity required (anon ids evaporate at disconnect) and the
        // wallet must be PROVEN — an unproven hello could graft requests onto
        // any wallet's social graph. Same gate as h2h.
        if (!session.walletProven) {
          ftrace(`add REJECT unproven (wallet=${session.wallet ? 'yes' : 'no'} mini=${session.miniPay === true} orig=${session.miniPayOriginOk !== false})`);
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Connect a wallet to add friends.' });
          break;
        }
        const now = Date.now();
        if (now - (session.lastFriendMsgAt ?? 0) < 1000) {
          ftrace(`add REJECT throttle pid=${msg.pid.slice(0, 6)}`);
          break;
        }
        session.lastFriendMsgAt = now;
        const myId = playerId(session.wallet, session.id);
        const target = await store.getProfileByPid(msg.pid);
        if (!target || target.id === myId) {
          ftrace(`add REJECT ${target ? 'self' : 'unknown-target'} pid=${msg.pid.slice(0, 6)}`);
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Unknown player' });
          break;
        }
        const status = await store.addFriend(myId, target.id);
        telemetry('friend.add', { from: tpid(myId), to: tpid(target.id), status });
        ftrace(`add OK ${pidFor(myId).slice(0, 6)}→${msg.pid.slice(0, 6)} status=${status}`);
        // Ack + my refreshed lists on THE ACTING socket (race-free — see
        // sendFriendsTo). The client's add/accept resolves on this friends.update.
        send(ws, { t: 'friend.added', pid: msg.pid, status });
        await sendFriendsTo(ws, myId);
        // Live-notify the OTHER side on their own socket if connected (else their
        // next hello/sync re-syncs the request/friendship).
        void pushFriendsUpdate(target.id).catch(() => undefined);
        break;
      }

      case 'friend.remove': {
        if (!session.walletProven) {
          ftrace('remove REJECT unproven');
          break;
        }
        const now = Date.now();
        if (now - (session.lastFriendMsgAt ?? 0) < 1000) break;
        session.lastFriendMsgAt = now;
        const myId = playerId(session.wallet, session.id);
        const target = await store.getProfileByPid(msg.pid);
        if (!target) break;
        await store.removeFriend(myId, target.id);
        // My own view refreshes on THE ACTING socket (race-free). SILENT for the
        // other side by design (de-friending must not be a conflict trigger).
        await sendFriendsTo(ws, myId);
        break;
      }

      case 'friend.challenge': {
        if (session.room) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Already in a game.' });
          break;
        }
        if (!session.walletProven) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Connect a wallet to challenge friends.' });
          break;
        }
        const now = Date.now();
        if (now - (session.lastFriendMsgAt ?? 0) < 1000) break;
        session.lastFriendMsgAt = now;
        const myId = playerId(session.wallet, session.id);
        const target = await store.getProfileByPid(msg.pid);
        if (!target) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Unknown player' });
          break;
        }
        // Only MUTUAL friends can be challenged — no challenge-spam to
        // arbitrary pids scraped from profiles.
        const myFriends = await store.getFriendIds(myId);
        if (!myFriends.includes(target.id)) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Not friends yet.' });
          break;
        }
        const blockedChallenge = await stakeBlock(session, msg.stake);
        if (blockedChallenge) {
          session.send({ t: 'error', code: 'LIMIT_REACHED', message: blockedChallenge });
          break;
        }
        // Same machinery as table.create: the code doubles as the WhatsApp deep
        // link for an offline friend, and table.join enforces every existing
        // guard (stake parity, anti-collusion pair cap, RG) on acceptance.
        session.stake = msg.stake;
        const code = generateTableCode();
        privateTables.set(code, { host: session, stake: msg.stake, createdAt: Date.now() });
        session.send({ t: 'table.created', code, stakeCents: msg.stake });
        // Live in-app offer when the friend is connected right now.
        const live = liveSessionFor(target.id);
        if (live && !live.room) {
          const from = await friendInfoOf(myId, false);
          if (from) live.send({ t: 'friend.challenge.offer', code, stakeCents: msg.stake, from });
        }
        telemetry('friend.challenge', { from: tpid(myId), to: tpid(target.id), stakeCents: msg.stake, live: !!live });
        break;
      }

      case 'friend.gift': {
        // Gift a premium cosmetic to a MUTUAL friend, paid with MY tickets
        // (cosmetics phase 2 — Yalla's gift economy, ticket rail only). Same
        // gates as the other friend.* writes: proven wallet + 1/s throttle.
        if (!session.walletProven) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Connect a wallet to send gifts.' });
          break;
        }
        const now = Date.now();
        if (now - (session.lastFriendMsgAt ?? 0) < 1000) break;
        session.lastFriendMsgAt = now;
        const myId = playerId(session.wallet, session.id);
        const target = await store.getProfileByPid(msg.pid);
        if (!target || target.id === myId) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Unknown player' });
          break;
        }
        // Mutual friends only — gifting is a bond, not a spam channel.
        const myFriends = await store.getFriendIds(myId);
        if (!myFriends.includes(target.id)) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Not friends yet.' });
          break;
        }
        const price = PREMIUM_SKINS[msg.id];
        if (price === undefined) {
          session.send({ t: 'error', code: 'BAD_MESSAGE', message: 'Unknown cosmetic.' });
          break;
        }
        const theirSkins = await store.getOwnedSkins(target.id);
        if (theirSkins.includes(msg.id)) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'They already own that one.' });
          break;
        }
        // MY tickets pay; the grant lands on THEIR account (durable either way).
        const left = await store.spendTickets(myId, price);
        if (left === null) {
          session.send({ t: 'error', code: 'LIMIT_REACHED', message: 'Not enough freeroll tickets for this gift.' });
          break;
        }
        const theirOwned = await store.ownSkin(target.id, msg.id);
        session.send({ t: 'friend.gifted', pid: msg.pid, id: msg.id, tickets: left });
        // Live in-app moment when the friend is connected right now; offline
        // friends simply find it owned at their next hello (the giver tells
        // them on WhatsApp — same notification model as challenges).
        const liveFriend = liveSessionFor(target.id);
        if (liveFriend) {
          const from = await friendInfoOf(myId, false);
          if (from) liveFriend.send({ t: 'friend.gift.received', from, id: msg.id, ownedIds: theirOwned });
        }
        telemetry('friend.gift', { from: tpid(myId), to: tpid(target.id), id: msg.id, tickets: price, live: !!liveFriend });
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

      case 'collection.claim': {
        // One-time ticket bonus for a COMPLETED cosmetic set (phase 3). Same
        // wallet-keyed trust model as skin.buy: the claim credits a durable
        // balance, so an unproven wallet-hello can't farm it.
        if (walletKeyedWriteBlocked(session)) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Verify your wallet to claim set bonuses.' });
          break;
        }
        const set = cosmeticSetById(msg.setId);
        if (!set) break; // parse already guarantees this; belt-and-braces
        const setPid = playerId(session.wallet, session.id);
        const alreadyClaimed = await store.getClaimedSets(setPid);
        if (alreadyClaimed.includes(set.id)) {
          // Idempotent: never grant twice, just restate the claimed state.
          const bal = (await store.getChallenge(setPid, utcToday())).tickets;
          session.send({ t: 'collection.claimed', setId: set.id, tickets: bal, claimedSets: alreadyClaimed, granted: 0 });
          break;
        }
        const ownedNow = await store.getOwnedSkins(setPid);
        if (!set.itemIds.every((itemId) => ownedNow.includes(itemId))) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Own every item of the set first.' });
          break;
        }
        // Seasonal rotation (phase 3b): the season's FEATURED set pays ×2 when
        // claimed during its season — the SERVER's season clock decides, with
        // the same deterministic rotation the client renders the ribbon from.
        const seasonNow = await store.getSeason(new Date().toISOString());
        const featured = featuredSetIdFor(seasonNow.id) === set.id;
        const grantTotal = set.rewardTickets * (featured ? FEATURED_SET_MULTIPLIER : 1);
        // Record the claim BEFORE granting so a crash between the two can only
        // under-pay (support-fixable), never open a repeat-grant loop.
        const claimedNow = await store.claimSet(setPid, set.id);
        const newBal = await store.grantTickets(setPid, grantTotal);
        session.send({ t: 'collection.claimed', setId: set.id, tickets: newBal, claimedSets: claimedNow, granted: grantTotal });
        telemetry('collection.claim', { pid: tpid(setPid), setId: set.id, tickets: grantTotal, featured });
        break;
      }

      case 'race.seed': {
        // B1 gas-seed: a burner has a PROVEN wallet but no gas. Send a tiny cUSD
        // amount so it can pay its own mint + join fees (in cUSD via feeCurrency),
        // BEFORE it mints the Pass. Kept small (a few cents of gas) and gated:
        // proven wallet, one seed per WALLET + per DEVICE, pool-capped. Dormant
        // unless seedCents > 0 (only a non-MiniPay burner launch provisions it).
        if (!raceFaucet || raceFaucet.seedCents <= 0) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Race Week gas seed is not available.' });
          break;
        }
        if (!session.walletProven || !session.wallet) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Connect your wallet to join Race Week.' });
          break;
        }
        const sNow = Date.now();
        if (sNow - (session.lastRaceAt ?? 0) < 3000) {
          // Anti-spam window (it sends a tx) — but ALWAYS reply: a silent drop
          // left honest clients (double-tap, quick pre-lock retry) hanging to
          // their own timeout and reporting "Gas seed failed" out of thin air.
          session.send({ t: 'race.seeded', seedCents: 0, alreadySeeded: false, rateLimited: true });
          break;
        }
        session.lastRaceAt = sNow;
        const sWallet = session.wallet;
        const seedKey = `race:seed:${sWallet.toLowerCase()}`;
        const seedFpKey = session.fingerprint ? `race:seedfp:${session.fingerprint}` : null;
        // The top-up keys on the burner's LIVE on-chain balance, not on "was the
        // target ever granted": a failed mint attempt still burns its cUSD gas, so
        // a fully-granted wallet can sit below the mint's gas reservation forever
        // (the drained-burner trap — every retry got `alreadySeeded` and the mint
        // kept failing on funds). `cents` in the meta is the wallet's CUMULATIVE
        // lifetime draw (old records stored the reached target — same value), and
        // bounds abuse (drain-and-reclaim) via SEED_LIFETIME_MULT.
        const priorRaw = await store.getMeta(seedKey);
        const priorCents = priorRaw ? Number((JSON.parse(priorRaw) as { cents?: number }).cents ?? 0) : 0;
        let seedBalCents: number;
        try {
          seedBalCents = await raceFaucet.balanceCentsOf(sWallet as Address);
        } catch (e) {
          // Distinct from the transfer failure below — this is a plain RPC READ
          // that failed, almost always a transient node hiccup.
          console.error('[race] gas-seed balance read failed', e);
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Gas seed failed reading balances — try again in a moment.' });
          break;
        }
        const seedDeficit = seedDeficitCents(raceFaucet.seedCents, seedBalCents);
        if (seedDeficit <= 0) {
          // The wallet already holds the full gas target — nothing to send.
          session.send({ t: 'race.seeded', seedCents: 0, alreadySeeded: true });
          break;
        }
        // Per-DEVICE allowance, cumulative — NOT a one-shot gate. "Clear site
        // data" (e.g. the service-worker recovery steps) wipes the burner KEY but
        // not the device fingerprint, so a returning player shows up with a FRESH
        // 0-balance burner on a device that already drew its seed; the one-shot
        // gate then refused it forever ("This device already received its gas
        // seed") and every mint died on funds. Bounding the device to the same
        // seedCents × SEED_LIFETIME_MULT budget as a wallet re-seeds the
        // replacement burner while capping what any one device can ever draw
        // (fingerprints are spoofable — the pool cap is the real backstop).
        const fpPriorRaw = seedFpKey ? await store.getMeta(seedFpKey) : null;
        const fpDrawn = seedFpDrawCents(fpPriorRaw, raceFaucet.seedCents);
        const seedCap = raceFaucet.seedCents * SEED_LIFETIME_MULT;
        // Gas is the SEED dimension: bound it by the TOTAL budget left (prize +
        // gas) so it can't overrun the faucet, but track it in its OWN counter so
        // it never ticks down the player-facing prize pool.
        const { seed: seedSpent, total: spentTotal } = await raceSpend(store);
        const topUpCents = Math.min(
          seedGrantCents(seedDeficit, priorCents, seedCap, spentTotal, raceFaucet.poolCents),
          Math.max(0, seedCap - fpDrawn),
        );
        if (topUpCents <= 0) {
          // Deficit is real but nothing can be granted: wallet or device at its
          // lifetime cap, or the pool is dry.
          const capped = priorCents >= seedCap || fpDrawn >= seedCap;
          session.send({ t: 'error', code: 'LIMIT_REACHED', message: capped ? 'This device already used its gas-seed allowance.' : 'Race Week funding pool is exhausted.' });
          break;
        }
        // Reserve BEFORE the transfer (same crash-safety as claim): record the new
        // cumulative draws (wallet + device), count only the delta against the
        // pool. Roll back to the prior state on a failed transfer.
        await store.setMeta(seedKey, JSON.stringify({ cents: priorCents + topUpCents, at: sNow, fp: session.fingerprint ?? null }));
        if (seedFpKey) await store.setMeta(seedFpKey, JSON.stringify({ cents: fpDrawn + topUpCents, wallet: sWallet.toLowerCase() }));
        await store.setMeta(SEED_SPENT_KEY, String(seedSpent + topUpCents));
        try {
          const txHash = await raceFaucet.fund(sWallet as Address, topUpCents);
          session.send({ t: 'race.seeded', seedCents: topUpCents, alreadySeeded: false, txHash });
          telemetry('race.seed', { pid: tpid(playerId(sWallet, session.id)), cents: topUpCents, seedSpent: seedSpent + topUpCents });
        } catch (e) {
          await store.setMeta(seedKey, priorRaw ?? '');
          if (seedFpKey) await store.setMeta(seedFpKey, fpPriorRaw ?? '');
          await store.setMeta(SEED_SPENT_KEY, String(seedSpent));
          // Name the cause instead of a blind "try again": the faucet wallet pays
          // grants AND its own gas in cUSD, so the single most likely hard failure
          // is its balance running out — which no retry will ever fix. Read the
          // balance (best-effort) and surface viem's own shortMessage; both also
          // go to the Fly logs for ops.
          const seedCause = String((e as { shortMessage?: string }).shortMessage ?? (e as Error)?.message ?? e);
          const faucetCents = await raceFaucet.faucetBalanceCents().catch(() => null);
          console.error(`[race] gas-seed transfer failed (faucet balance: ${faucetCents ?? 'unreadable'}c, sending ${topUpCents}c)`, e);
          session.send({ t: 'error', code: 'BAD_STATE', message: faucetFailureMessage('seed', faucetCents, topUpCents, seedCause) });
        }
        break;
      }

      case 'race.claim': {
        // Race Week onboarding faucet. Fund a tiny event stake budget to a player
        // who really minted their (soulbound) RacePass. Anti-sybil is layered:
        // proven wallet, one grant per WALLET (the Pass is 1/wallet → 1/phone),
        // one per DEVICE fingerprint, and a hard total pool cap. Amounts are
        // trivial (cents), so "claim & never play" is economically negligible.
        if (!raceFaucet) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Race Week is not active.' });
          break;
        }
        if (!session.walletProven || !session.wallet) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Connect your wallet to join Race Week.' });
          break;
        }
        const rNow = Date.now();
        if (rNow - (session.lastRaceAt ?? 0) < 3000) {
          // Same always-reply contract as race.seed: a silent drop reads as a hang.
          session.send({ t: 'error', code: 'LIMIT_REACHED', message: 'One moment — please try again.' });
          break;
        }
        session.lastRaceAt = rNow;
        const rWallet = session.wallet;
        const walletKey = `race:grant:${rWallet.toLowerCase()}`;
        const fpKey = session.fingerprint ? `race:fp:${session.fingerprint}` : null;
        // Idempotent per wallet: already funded → restate, never re-transfer.
        if (await store.getMeta(walletKey)) {
          session.send({ t: 'race.claimed', fundedCents: 0, alreadyFunded: true });
          break;
        }
        // Per-device allowance: up to SEED_LIFETIME_MULT wallets may claim on one
        // device — NOT a one-shot gate. Same wiped-burner trap as the gas seed
        // (#58): "Clear site data" loses the claiming wallet's KEY, and a one-shot
        // gate then locks the whole device out of the event forever, whatever
        // replacement wallet it shows up with. The cap keeps farming bounded (one
        // device backs at most 3 wallets; fingerprints are spoofable anyway — the
        // soulbound Pass, the JIT drip and the pool cap carry the weight).
        const fpPriorRaw = fpKey ? await store.getMeta(fpKey) : null;
        const fpWallets = claimFpWallets(fpPriorRaw);
        if (fpWallets.length >= SEED_LIFETIME_MULT && !fpWallets.includes(rWallet.toLowerCase())) {
          session.send({ t: 'error', code: 'LIMIT_REACHED', message: 'This device already claimed its Race Week bonus.' });
          break;
        }
        // Verify the mint tx really emitted Minted(thisWallet) from the RacePass.
        const passOk = await raceFaucet.verifyPassMint(msg.passTxHash as Hex, rWallet as Address).catch(() => false);
        if (!passOk) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Could not verify your Race Pass mint.' });
          break;
        }
        const { prize: spent, seed: seedRest } = await raceSpend(store);
        // Balance-aware: a wallet that can already cover a stake self-funds —
        // register it as a participant (leaderboard + the balance-aware per-game
        // top-ups) but grant NOTHING and leave the pool untouched, conserving the
        // faucet for empty wallets. Only when we can CONFIRM the balance; a failed
        // RPC read falls through to the normal grant so a node hiccup never blocks
        // a genuinely empty player.
        const rBal = await raceFaucet.balanceCentsOf(rWallet as Address).catch(() => null);
        if (rBal !== null && rBal >= raceFaucet.perGameCents) {
          await store.setMeta(walletKey, JSON.stringify({ cents: 0, at: rNow, fp: session.fingerprint ?? null }));
          if (fpKey) await store.setMeta(fpKey, JSON.stringify({ wallets: [...new Set([...fpWallets, rWallet.toLowerCase()])] }));
          if (raceFaucet.jit) await store.setMeta(`race:funded:${rWallet.toLowerCase()}`, '0');
          session.send({ t: 'race.claimed', fundedCents: 0, alreadyFunded: true });
          telemetry('race.claim', { pid: tpid(playerId(rWallet, session.id)), cents: 0, poolSpent: spent });
          break;
        }
        // How much to fund NOW. Lump-sum mode grants the whole quota at once.
        // JIT mode (mainnet anti-fund-and-run) grants only one stake + gas buffer;
        // the rest is topped up after each COMPLETED event game (see onResult), so
        // a wallet that claims and vanishes keeps just `perGameCents`, not the quota.
        const grantCents = raceFaucet.jit ? jitClaimCents(raceFaucet.perGameCents, raceFaucet.quotaCents) : raceFaucet.quotaCents;
        // Hard budget cap: never fund past the provisioned budget — checked against
        // the TOTAL draw (prize + gas), but the grant advances only the prize counter.
        if (grantCents > budgetLeftCents(raceFaucet.poolCents, spent, seedRest)) {
          session.send({ t: 'error', code: 'LIMIT_REACHED', message: 'Race Week funding pool is exhausted.' });
          break;
        }
        // Reserve BEFORE the transfer (record grant + debit pool), so a crash
        // mid-transfer can only UNDER-fund (support-fixable), never double-fund.
        await store.setMeta(walletKey, JSON.stringify({ cents: grantCents, at: rNow, fp: session.fingerprint ?? null }));
        if (fpKey) await store.setMeta(fpKey, JSON.stringify({ wallets: [...new Set([...fpWallets, rWallet.toLowerCase()])] }));
        await store.setMeta(POOL_SPENT_KEY, String(spent + grantCents));
        // JIT: track the running total already funded to THIS wallet so the
        // top-up hook knows how much quota is left to drip out over its games.
        if (raceFaucet.jit) await store.setMeta(`race:funded:${rWallet.toLowerCase()}`, String(grantCents));
        try {
          const txHash = await raceFaucet.fund(rWallet as Address, grantCents);
          session.send({ t: 'race.claimed', fundedCents: grantCents, alreadyFunded: false, txHash });
          telemetry('race.claim', { pid: tpid(playerId(rWallet, session.id)), cents: grantCents, poolSpent: spent + grantCents });
        } catch (e) {
          // Transfer failed after reserving → roll back so the player can retry.
          await store.setMeta(walletKey, '');
          if (fpKey) await store.setMeta(fpKey, fpPriorRaw ?? '');
          await store.setMeta(POOL_SPENT_KEY, String(spent));
          if (raceFaucet.jit) await store.setMeta(`race:funded:${rWallet.toLowerCase()}`, '');
          // Same diagnostics as the gas-seed catch: the dry faucet is the one
          // hard failure retries can't fix, and viem's shortMessage names
          // everything else — both belong in the toast and the Fly logs.
          const claimCause = String((e as { shortMessage?: string }).shortMessage ?? (e as Error)?.message ?? e);
          const claimFaucetCents = await raceFaucet.faucetBalanceCents().catch(() => null);
          console.error(`[race] funding transfer failed (faucet balance: ${claimFaucetCents ?? 'unreadable'}c, sending ${grantCents}c)`, e);
          session.send({ t: 'error', code: 'BAD_STATE', message: faucetFailureMessage('claim', claimFaucetCents, grantCents, claimCause) });
        }
        break;
      }

      case 'race.leaderboard': {
        // Public read — the board holds only display names + points (no wallets
        // leave the server). Available whenever the event is armed.
        if (!raceFaucet) break;
        const board = await raceLeaderboard(store, session.wallet?.toLowerCase());
        session.send({ t: 'race.board', top: board.top.map((e) => ({ name: e.name, points: e.points, rank: e.rank })), myRank: board.myRank, myPoints: board.myPoints });
        break;
      }

      case 'season.claim': {
        // Same trust model as skin.buy: an unproven wallet can't claim rewards that
        // credit a durable balance to that address (anon sessions pass — their
        // progress is ephemeral anyway).
        if (walletKeyedWriteBlocked(session)) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Verify your wallet to claim season rewards.' });
          break;
        }
        const clpid = playerId(session.wallet, session.id);
        const res = await claimSeasonTier(store, clpid, msg.tier, msg.lane, utcToday());
        if (!res.ok) {
          const message =
            res.error === 'locked' ? 'That tier is not unlocked yet.'
            : res.error === 'not-premium' ? 'The premium track requires the season pass.'
            : 'That reward was already claimed.';
          const code = res.error === 'already' ? 'BAD_STATE' : 'LIMIT_REACHED';
          session.send({ t: 'error', code, message });
          break;
        }
        // A ticket reward surfaces in the ticket UI; then a fresh season.state marks
        // the tier claimed (the client keeps the static reward table).
        if (res.ticketsGranted && res.ticketsGranted > 0) {
          const total = (await store.getChallenge(clpid, utcToday())).tickets;
          session.send({ t: 'tickets.grant', granted: res.ticketsGranted, total, reason: 'sync' });
          telemetry('tickets', { pid: tpid(clpid), delta: res.ticketsGranted, reason: 'season-claim', total });
        }
        telemetry('season.claim', { pid: tpid(clpid), tier: msg.tier, lane: msg.lane, reward: res.reward?.kind, tickets: res.ticketsGranted ?? 0 });
        // A streak-freeze reward changed the inventory → refresh the streak UI too.
        if (res.reward?.kind === 'streakFreeze') session.send({ t: 'streak.update', streak: await store.getStreak(clpid) });
        // A cosmetic reward granted a real owned skin → push the new owned list.
        if (res.reward?.kind === 'cosmetic') {
          session.send({ t: 'skin.owned', ownedIds: await store.getOwnedSkins(clpid), tickets: (await store.getChallenge(clpid, utcToday())).tickets });
        }
        session.send({ t: 'season.state', season: await buildSeasonState(store, clpid, new Date().toISOString()) });
        break;
      }

      case 'season.buyPremium': {
        // Premium is a USDT purchase → it must credit a proven wallet (the same
        // verified-buyer model as cosmetic.claim). No anon premium.
        if (!cosmeticsVerifier) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'The premium pass is not available yet.' });
          break;
        }
        if (!session.wallet) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Connect a wallet to buy the premium pass.' });
          break;
        }
        const bpid = playerId(session.wallet, session.id);
        const buyerWallet = session.wallet as Address;
        const res = await buySeasonPremium(
          store,
          (txHash) => cosmeticsVerifier.verifyPurchase(txHash as Hex, buyerWallet, SEASON_PREMIUM.itemId),
          bpid,
          msg.txHash,
        );
        if (!res.ok) {
          const message =
            res.error === 'already' ? 'You already own the premium pass this season.'
            : res.error === 'replay' ? 'That purchase was already used.'
            : 'Could not verify that USDT purchase.';
          session.send({ t: 'error', code: res.error === 'already' ? 'BAD_STATE' : 'BAD_MESSAGE', message });
          break;
        }
        // Retroactive tickets surface in the ticket UI; a fresh season.state flips
        // the premium lane on + marks the auto-unlocked tiers claimed.
        if (res.ticketsGranted && res.ticketsGranted > 0) {
          const total = (await store.getChallenge(bpid, utcToday())).tickets;
          session.send({ t: 'tickets.grant', granted: res.ticketsGranted, total, reason: 'sync' });
          telemetry('tickets', { pid: tpid(bpid), delta: res.ticketsGranted, reason: 'season-premium-retro', total });
        }
        telemetry('season.premium', { pid: tpid(bpid), unlocked: res.unlockedTiers?.length ?? 0, tickets: res.ticketsGranted ?? 0 });
        // The retroactive unlock may have granted premium-lane skins → refresh owned.
        session.send({ t: 'skin.owned', ownedIds: await store.getOwnedSkins(bpid), tickets: (await store.getChallenge(bpid, utcToday())).tickets });
        session.send({ t: 'season.state', season: await buildSeasonState(store, bpid, new Date().toISOString()) });
        break;
      }

      case 'streak.buyFreeze': {
        // Buy one streak-freeze with tickets (a sink). Wallet-keyed like skin.buy —
        // an unproven wallet can't spend a durable balance.
        if (walletKeyedWriteBlocked(session)) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Verify your wallet to buy a streak-freeze.' });
          break;
        }
        const sfpid = playerId(session.wallet, session.id);
        const res = await store.buyStreakFreeze(sfpid);
        if (!res.ok) {
          session.send({
            t: 'error',
            code: 'LIMIT_REACHED',
            message: res.reason === 'capped' ? 'You already hold the maximum streak-freezes.' : 'Not enough tickets for a streak-freeze.',
          });
          break;
        }
        telemetry('tickets', { pid: tpid(sfpid), delta: -STREAK_FREEZE.ticketCost, reason: 'streak-freeze', total: res.tickets });
        session.send({ t: 'streak.update', streak: await store.getStreak(sfpid) });
        break;
      }

      case 'game.rematch': {
        // ALWAYS-REPLY contract (same family as the race.seed silent drop): a
        // swallowed rematch click leaves the end screen "searching" forever with
        // no way for the player to tell a dropped request from a slow pairing.
        if (session.room || session.pendingGameId) {
          session.send({ t: 'error', code: 'BAD_STATE', message: 'Already in a game.' });
          break;
        }
        // A repeated game.rematch must not stack queue entries: it falls through to
        // matchmaker.join below, which (unlike queue.join) had no dedupe guard, so
        // the token bucket alone allowed ~30 entries/s for one session — each one
        // pairing into its own staked game past a daily-limit check that reads the
        // still-undebited counter. Ack the duplicate truthfully: they ARE queued.
        if (matchmaker.isQueued(session) || freerollMatchmaker.isQueued(session)) {
          session.send({ t: 'queue.ok', position: 1 });
          break;
        }
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
      case 'rematch.poll': {
        // The end screen just mounted and asks: did my last opponent already
        // request a rematch (a push I may have missed)? If so — and they're
        // still idle and waiting on ME — deliver the offer now. Pull-based, so a
        // dropped `rematch.offer` push no longer strands the pairing.
        if (session.room || session.pendingGameId || session.rematchWanted) break;
        const rematcher = session.lastOpponentId ? sessions.get(session.lastOpponentId) : undefined;
        if (
          rematcher &&
          rematcher.alive &&
          rematcher.rematchWanted &&
          rematcher.lastOpponentId === session.id &&
          !rematcher.room &&
          !rematcher.pendingGameId
        ) {
          session.send({ t: 'rematch.offer', name: label(rematcher) });
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
    // R-RT-1: a resume (double tab / reconnect) rebinds the SAME Session object to
    // a newer socket. If this closing socket is no longer the session's active one,
    // it is stale — do the per-connection cleanup above but NEVER tear down the live
    // session (nulling its ws, dropping its live 4p seat to a bot, forfeiting a
    // locked stake). Only the owning socket's close tears the session down.
    if (session.ws !== ws) return;
    session.ws = null;
    session.alive = false;
    // Living presence: stamp "last seen" and flip me to offline in my friends'
    // lobbies. Only proven sessions can have friends (same gate as friend.*).
    if (session.walletProven) {
      const goneId = playerId(session.wallet, session.id);
      lastSeenByPid.set(goneId, Date.now());
      void notifyFriendsPresence(goneId).catch(() => undefined);
    }
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
    // Abandon a game that was awaiting entropy reveals (Room not created yet) —
    // AFTER a reconnect grace, never instantly. The immediate abandon turned
    // EVERY transient socket loss in the pending window into "Opponent left
    // before the game started" for the innocent player: a mobile blip, and
    // above all the R-RT-1 takeover — a one-shot sync resuming the same token
    // becomes session.ws, then closes a second later, which read here as the
    // session disconnecting (production incident: a MiniPay player pairing
    // while the app was still boot-syncing spuriously aborted the match). A
    // dropped client resumes in ~1s (rebinding ws + alive, and the hello replay
    // restores its match context); only a player STILL gone when the grace
    // expires abandons the match. The pending window stays bounded regardless:
    // stake-lock polling and the re-queue un-wedge tear down stale entries.
    if (session.pendingGameId) {
      const p = pendingReveals.get(session.pendingGameId);
      if (p) {
        const gone = session;
        setTimeout(() => {
          if (pendingReveals.get(p.gameId) !== p) return; // started or aborted meanwhile
          if (gone.alive) return; // resumed within the grace — the match lives on
          pendingReveals.delete(p.gameId);
          const opp = p.a === gone ? p.b : p.a;
          if (gone.pendingGameId === p.gameId) gone.pendingGameId = undefined;
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
          // MATCH_ABORTED so the waiting opponent leaves the staking screen for the
          // lobby (see abortPendingStaked) instead of being stranded on a toast.
          opp.send({ t: 'error', code: 'MATCH_ABORTED', message: 'Opponent left before the game started. Any locked stake is refunded shortly.' });
          console.warn(`[pending] ${p.gameId} abandoned: player still gone after the ${PENDING_DISCONNECT_GRACE_MS / 1000}s reconnect grace`);
        }, PENDING_DISCONNECT_GRACE_MS);
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

/** How long a disconnected player may take to resume before their PENDING
 *  match (Room not created yet) is abandoned. Started rooms already tolerate
 *  absence (clock + auto-move); this extends the same "disconnection is not
 *  desertion" posture to the staking window, where reconnects are routine
 *  (mobile blips, R-RT-1 socket takeovers). Bounded well inside the 2-minute
 *  stake-lock timeout that caps the pending window overall. */
const PENDING_DISCONNECT_GRACE_MS = 15_000;

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
    opponent: { name: oppSession ? label(oppSession) : opp.name, elo: opp.elo, flag: opp.flag, pid: opp.wallet ? pidFor(playerId(opp.wallet, opp.id)) : undefined, frame: opp.frame, avatar: opp.avatar, diceSkin: opp.diceSkin, tokenSkin: opp.tokenSkin, entranceFx: opp.entranceFx, victoryFx: opp.victoryFx },
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
  // MiniPay auto-prove, but only from a trusted Origin (R-AUTH-1 defence-in-depth):
  // a malicious website cannot forge the WS Origin, so it can no longer claim a
  // victim's wallet as proven. Off-origin (or origin not on the allowlist) falls
  // through to the unproven path — MiniPay can't sign, so such a session simply
  // stays unproven and walletKeyedWriteBlocked keeps it out of wallet-keyed writes.
  if (session.miniPay && session.miniPayOriginOk !== false) {
    session.walletProven = true;
    return { walletProven: true };
  }
  if (session.walletProven) return { walletProven: true };
  session.walletNonce = randomBytes(16).toString('hex');
  return { walletNonce: session.walletNonce, walletProven: false };
}

/**
 * @param settlerReady is the arbiter that will settle THIS mode armed? Defaults to
 *   the 1v1 arbiter; the 4p entry passes `!!arbiterN`.
 */
async function stakeBlock(session: Session, stake: StakeCents, settlerReady = !!arbiter): Promise<string | null> {
  if (stake <= 0) return null;
  // The launch gate (R-COMP-2) must fail SAFE. STAKING_ENABLED=false only nulls the
  // arbiter — and `needsLock` is `stake > 0 && wallets && !!arbiter`, so a
  // wallet-backed staked game would then start WITHOUT waiting for the escrow and
  // would never be settled. A client that deposited anyway (its escrow address is
  // baked into its own bundle, not handed out by us) leaves real funds locked until
  // the contract's 24 h refundActive. Turning staking OFF must stop staked play, not
  // silently turn it into unsettled staked play. Staked 4p already refused on
  // `!arbiterN` at its entry (index.ts:1034) — 1v1 had no equivalent. Wallet-less
  // demo players stake simulated balances (no escrow, no settlement) — unaffected.
  if (session.wallet && !settlerReady) {
    return 'Staked games are temporarily unavailable — free practice only.';
  }
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
  // 4-player reattach (G-5): rebind to a Room4 restored from a snapshot at boot.
  if (rec.room4Id && rec.seat4 != null) {
    const room4 = rooms4.get(rec.room4Id);
    if (room4 && !room4.isOver()) {
      session.room4 = room4;
      session.seat4 = rec.seat4;
      room4.attach(rec.seat4, session);
    }
  }
  const inGame =
    (!!session.room && !session.room.isOver()) || (!!session.room4 && !session.room4.isOver());
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
  // Sink events for the ticket-inflation index (both entries left circulation).
  telemetry('tickets', { pid: tpid(pidA), delta: -FREEROLL.entryTickets, reason: 'freeroll-entry', total: spentA });
  telemetry('tickets', { pid: tpid(pidB), delta: -FREEROLL.entryTickets, reason: 'freeroll-entry', total: spentB });
  await startGame(0, a, b, true);
}

async function startGame(stake: StakeCents, a: Session, b: Session, freeroll = false, fromTable = false): Promise<void> {
  // Last-resort guard: never start a game for a seat that is already playing or
  // already staking another one. The 1 s matchmaker sweep calls straight in here
  // without re-running the queue guards, so a stale entry (or a second entry that
  // slipped in) must not open a concurrent staked game — that is how the daily
  // limit gets bypassed, since its counter is only debited once a game starts.
  // Both seats were already spliced out of the queue by the caller, so refusing is
  // enough — do NOT leaveAll() here, that would also drop the innocent seat's other
  // legitimate waits. The queue guards make this unreachable; log if it ever fires.
  if (a.room || b.room || a.pendingGameId || b.pendingGameId) {
    console.warn(`[matchmaking] refused a pairing for a busy seat (a=${!!(a.room || a.pendingGameId)} b=${!!(b.room || b.pendingGameId)})`);
    return;
  }
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
  // NOTE: the daily-stake debit (E5.2) and the pair count (E5.3) are NOT applied
  // here. A match that never becomes Active (the opponent simply never deposits)
  // is aborted+refunded by abortPendingStaked, and `addDailyStake` has no inverse
  // in the Store — so debiting at match time irreversibly consumed the *victim's*
  // daily limit for a game that never happened, letting an attacker who spends
  // nothing lock a victim out of staked play for the rest of the UTC day.
  // Both are applied in startRoom(), which runs only once the escrow is Active.
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
    opponent: { name: label(opp), elo: opp.elo, flag: opp.flag, pid: opp.wallet ? pidFor(playerId(opp.wallet, opp.id)) : undefined, frame: opp.frame, avatar: opp.avatar, diceSkin: opp.diceSkin, tokenSkin: opp.tokenSkin, entranceFx: opp.entranceFx, victoryFx: opp.victoryFx },
    youName: label(me),
    stakeCents: stake,
    potCents: pot,
    fairnessCommit: commit,
  };
}

/** Create the Room from a finalized fairness and start it (match.found already sent). */
function startRoom(gameId: string, stake: StakeCents, a: Session, b: Session, fairness: Fairness, freeroll = false): void {
  // Count the stake toward each player's daily total (E5.2) and the pair count
  // (E5.3) HERE — the game is now really starting. Debiting at match time instead
  // was irreversible (the Store has no decrement) and every abort path refunds the
  // escrow without restoring the counter, so a non-depositing opponent could burn
  // a victim's whole daily limit on a game that never ran. See startGame().
  if (stake > 0) {
    const idA = playerId(a.wallet, a.id);
    const idB = playerId(b.wallet, b.id);
    void Promise.all([
      store.addDailyStake(idA, utcToday(), stake),
      store.addDailyStake(idB, utcToday(), stake),
      a.wallet && b.wallet ? store.bumpPairGame(idA, idB, utcToday()) : Promise.resolve(),
    ]).catch((e) => console.error('[rg] dailyStake', e));
  }
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
function abortPendingStaked(p: PendingReveal, message: string, alert?: string, skipNotify?: Session): void {
  if (pendingReveals.get(p.gameId) !== p) return; // already torn down
  pendingReveals.delete(p.gameId);
  p.a.pendingGameId = undefined;
  p.b.pendingGameId = undefined;
  // MATCH_ABORTED (not INTERNAL): tells the client this pending match is dead so
  // it leaves the "opponent found"/staking screen and returns to the lobby — an
  // INTERNAL only toasted, stranding the waiting player on a frozen screen.
  // `skipNotify` = the player who ABANDONED by re-queuing: sending them the
  // abort would bounce their own fresh queue attempt back to the lobby.
  const err: ServerMsg = { t: 'error', code: 'MATCH_ABORTED', message };
  if (p.a !== skipNotify) p.a.send(err);
  if (p.b !== skipNotify) p.b.send(err);
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
        const want = [p.a.wallet!, p.b.wallet!];
        const got = [playerA, playerB];
        if (!sameDepositors(want, got)) {
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
    const won = seat === winnerSeat && !seats[seat]?.bot;
    store.recordPlayed(pid).catch((e) => console.error('[profile] recordPlayed4', e));
    if (won) store.recordWin(pid).catch((e) => console.error('[profile] recordWin4', e));
    awardSeasonCrowns(pid, h, won);
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
      seats.push({ client: h, bot: false, sessionId: h.id, name, flag: h.flag, pid: h.wallet ? pidFor(playerId(h.wallet, h.id)) : undefined, frame: h.frame, avatar: h.avatar, diceSkin: h.diceSkin, tokenSkin: h.tokenSkin, entranceFx: h.entranceFx, victoryFx: h.victoryFx });
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
  room.onChange = persistRoom4; // survive a restart like every other game (G-5)
  room.onResult = (r) => recordRoom4Stats(humans, r.winnerSeat, r.seats);
  room.onEnd = () => {
    rooms4.delete(gameId);
    detachSessionsFromRoom4(room);
    void store.deleteRoom4(gameId).catch((e) => console.error('[store] deleteRoom4', e));
  };
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
  const players: Player4Info[] = humans.map((h) => ({ name: h.name, flag: h.flag, bot: false, pid: h.wallet ? pidFor(playerId(h.wallet, h.id)) : undefined, frame: h.frame, avatar: h.avatar, diceSkin: h.diceSkin, tokenSkin: h.tokenSkin, entranceFx: h.entranceFx, victoryFx: h.victoryFx }));
  pendingStaked4.set(gameId, { gameId, humans, stake, pot, rake, serverSeed, commit, seatCommits, reveals: humans.map(() => null) });
  // NOTE: the daily-limit debit (E5.2) is applied in startStaked4Room, once all
  // four stakes are Active — not here. A table that never fills (any seat simply
  // never deposits) is cancelled + refunded, and addDailyStake has no inverse, so
  // debiting at match time burned all four players' daily limits for a game that
  // never ran — one no-show could lock three victims out for the UTC day.
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
    .then(async ({ status }) => {
      if (pendingStaked4.get(gameId) !== p) return;
      // Start only when the money is locked AND fairness can be bound to all four
      // revealed entropies. If stakes are Active but a reveal is still missing, keep
      // polling — the MAX_LOCK_POLLS timeout below tears down + refunds a table that
      // never completes (a seat that never reveals).
      if (status === GameStatusN.Active && allRevealed4(p)) {
        // Before dealing, verify the four on-chain depositors ARE the four matched
        // players — the 4p analogue of the 1v1 depositor check (R-SETTLE-3). status
        // Active only means four seats are filled, not BY WHOM: a party that learned
        // the gameId could have deposited into a seat. Play a mismatched escrow and
        // the winner may not be an on-chain seat (settle reverts) — funds stuck.
        // On mismatch: void (refund every depositor, squatter included) and cancel.
        const want = p.humans.map((h) => h.wallet!);
        const seats = await arbiterN!.seatsOf(gameId);
        if (!sameDepositors(want, seats)) {
          if (pendingStaked4.get(gameId) !== p) return; // lost the race to another tick
          pendingStaked4.delete(gameId);
          for (const h of p.humans) {
            h.pendingGameId = undefined;
            h.send({ t: 'error', code: 'INTERNAL', message: 'Stake accounts did not match the table — cancelled. Any locked stake is refunded shortly.' });
          }
          const alert = `[4p stake-gate][ALERT] ${gameId} depositor mismatch: matched {${want.join(', ')}} but escrow holds {${seats.join(', ')}} — voiding.`;
          console.error(alert);
          postOpsAlert(alert);
          // A refund job on an already-Active escrow is routed to voidGame by the
          // settlement queue (returns every stake to its depositor) — see the
          // Active-void branch in settlement4.ts.
          scheduleRefundUnfilled4(gameId, p.humans);
          return;
        }
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
  // Count each seat's stake toward the daily limit (E5.2) — here, where the game
  // really starts (all 4 stakes Active), never at match time. See startStakedRoom4.
  if (p.stake > 0) {
    void Promise.all(p.humans.map((h) => store.addDailyStake(playerId(h.wallet, h.id), utcToday(), p.stake)))
      .catch((e) => console.error('[4p] dailyStake', e));
  }
  // Bind the committed seed to the now-revealed raw seat seeds. allRevealed4 gated
  // this call, so every reveal is present; `?? ''` only satisfies the type.
  const fairness = finalizeFairness4(p.serverSeed, p.commit, p.reveals.map((r) => r ?? ''));
  const seats: Seat4[] = p.humans.map((h) => ({ client: h, bot: false, sessionId: h.id, wallet: h.wallet, name: h.name, flag: h.flag, pid: h.wallet ? pidFor(playerId(h.wallet, h.id)) : undefined, frame: h.frame, avatar: h.avatar, diceSkin: h.diceSkin, tokenSkin: h.tokenSkin, entranceFx: h.entranceFx, victoryFx: h.victoryFx }));
  const room = new Room4(p.gameId, seats, fairness, 0, 0, p.pot, p.rake);
  // Restart-safe lifecycle: persist on every change, settle + record from the seats
  // (not the p.humans closure, which a restart loses) on finish (G-5).
  wireStakedRoom4(room);
  rooms4.set(p.gameId, room);
  p.humans.forEach((h, seat) => {
    h.pendingGameId = undefined;
    h.room4 = room;
    h.seat4 = seat;
  });
  room.start();
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

/**
 * Last-resort handlers. The authoritative state machine drives itself from timers
 * (Room's move clock and auto-play, Room4's equivalents, the reveal timeout) that
 * fire OUTSIDE the try/catch around the message loop — the only one on the request
 * path. Without these, a single throw in one game's timer took the whole process
 * down with it, dropping every concurrent game, staked ones included.
 *
 * A crashed process is still the safest end state (state is written through to the
 * store, so the supervisor restarts and games resume) — but exit only AFTER the
 * room snapshots are flushed, and never on an error we can survive.
 */
let crashing = false;
function lastResort(kind: string, err: unknown): void {
  console.error(`[fatal] ${kind}:`, err instanceof Error ? (err.stack ?? err.message) : err);
  postOpsAlert(`[fatal] ${kind}: ${err instanceof Error ? err.message : String(err)}`);
  if (crashing) return; // a throw while shutting down must not re-enter
  crashing = true;
  for (const room of rooms.values()) room.suspend();
  settlementQueue?.stop();
  void Promise.allSettled([...roomWrites.values()])
    .then(() => store.close())
    .finally(() => process.exit(1)); // non-zero: let the supervisor restart us
}
process.on('uncaughtException', (err) => lastResort('uncaughtException', err));
process.on('unhandledRejection', (reason) => lastResort('unhandledRejection', reason));
