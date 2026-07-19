/**
 * Game session abstraction: GameScreen consumes the same interface
 * whether it plays the local bot (LocalBotSession) or PvP (RemoteSession).
 */
import {
  applyMove,
  applyRoll,
  newGame,
  pickAutoMove,
} from '@ludo/game-engine';
import type { GameState, Seat } from '@ludo/game-engine';
import { deviceFingerprint } from './fingerprint';
import { setServerContracts } from './settlementGuard';
import { isMiniPay } from './minipay';
import { loadFrameId } from './avatarFrames';
import { loadTokenSkinId, loadEntranceFxId, loadVictoryFxId } from './tokenSkins';
import { loadSkinId } from './diceSkins';
import { loadAvatarId } from './avatars';
import { adoptServerIdentity, loadCustomIdentity } from './profile';
import { sha256Hex } from './fairnessVerify';
import {
  WALK_STEP_MS,
  WALK_TWEEN_MS,
  TURN_BEAT_MS,
  BOT_ROLL_MS,
  BOT_MOVE_MS,
  FORCED_MOVE_MS,
} from './pacing';
import {
  RAKE_BPS,
  walletProofMessage,
  type ChallengeState,
  type ErrorCode,
  type FriendInfo,
  type GameOverReason,
  type OpponentInfo,
  type LeagueState,
  type LimitsState,
  type Comeback,
  type PublicProfile,
  type SeasonState,
  type ServerMsg,
  type StakeCents,
  type StreakState,
} from '@ludo/shared';

/** Auth material the client attaches to a staked session: 18+/ToS consent to send
 *  in hello, and a wallet signer to answer the server's ownership-proof nonce. */
/** Append the QA isolation key (test harnesses only) to a server WS URL.
 *  Real users never have `ludo.qa` set; a wrong value is ignored server-side.
 *  With a valid key the session only ever pairs with other QA sessions and
 *  writes nothing to public ladders. */
export function withQa(url: string): string {
  try {
    const key = localStorage.getItem('ludo.qa');
    if (!key) return url;
    const u = new URL(url);
    u.searchParams.set('qa', key);
    return u.toString();
  } catch {
    return url;
  }
}

export interface WalletAuth {
  consent?: { tosVersion: string; age18: boolean };
  signMessage?: (message: string) => Promise<string>;
}

export interface MatchInfo {
  gameId: string;
  seat: Seat;
  opponent: OpponentInfo;
  /** My label for THIS game, from the server. Normally my own name, but when both
   *  players carry the same one the server disambiguates the pair ("Nia"/"Nia 2")
   *  and both screens must agree — my local profile name can't know about that.
   *  Absent against an older server / the local bot → fall back to the profile. */
  youName?: string;
  stakeCents: StakeCents;
  potCents: number;
  fairnessCommit: string;
  /** Our OWN committed entropy for this game (RemoteSession only). Kept so the
   *  fairness verifier can confirm the server actually bound it at our seat in the
   *  reveal, not silently ignore it (R-DICE-1). Absent for the local bot. */
  myEntropy?: string;
}

export interface GameResult {
  winner: Seat;
  reason: GameOverReason;
  payoutCents: number;
  rakeCents: number;
  eloDelta: number;
  fairnessReveal?: { serverSeed: string; entropies: [string, string] };
}

export interface SessionEvents {
  onMatchFound(info: MatchInfo): void;
  onState(state: GameState): void;
  onDice(value: number, index: number, seat: Seat): void;
  onMoved(state: GameState, capture: boolean, extraTurn: boolean): void;
  onTurn(seat: Seat, deadlineTs: number): void;
  /** The turn clock expired and the server auto-played for `seat`; at `max`
   *  consecutive auto-plays that seat forfeits. Lets the UI explain the pacing. */
  onAutoPlayed(seat: Seat, count: number, max: number): void;
  /** A player (this one or the opponent) sent a quick emote. */
  onEmote(seat: number, id: string): void;
  /** A gift was sent from one seat to another (id in GIFTS). */
  onGift(from: number, to: number, id: string): void;
  onOver(result: GameResult): void;
  /** A server-side notice. `code` is the machine-readable reason when it came from
   *  an `error` message: benign gameplay races (NOT_YOUR_TURN / ILLEGAL_MOVE — a
   *  duplicate or stale intent the authoritative state already superseded) carry it
   *  so the UI can release the input lock WITHOUT a nagging toast, while real errors
   *  (limits, bad state, …) still surface. Absent for purely informational notices. */
  onInfo(message: string, code?: ErrorCode): void;
  /** On-chain settlement confirmed (E3.3): the payout tx is mined. */
  onSettled(txHash: string): void;
  /** Stake refunded on-chain (E3.4): the opponent never joined. */
  onRefunded(txHash: string): void;
  /** Daily challenge progress/tickets from the server (E4.1). */
  onChallenge(challenge: ChallengeState): void;
  /** Login streak from the server on connect (E4.2). */
  onStreak(streak: StreakState): void;
  /** Weekly league standings (E4.3). */
  onLeague(league: LeagueState): void;
  /** Private table created (E4.4): share the code with a friend. */
  onTableCreated(code: string, stakeCents: StakeCents): void;
  /** Freeroll tickets granted (anti-tilt bonus, freeroll win) with the new total. */
  onTickets(granted: number, total: number, reason: 'anti-tilt' | 'freeroll-win' | 'sync'): void;
  /** Premium dice skins the player owns (from hello.ok). */
  onSkins(ownedIds: string[]): void;
  /** Cosmetic-set bonuses already claimed (phase 3, from hello.ok). */
  onClaimedSets?(setIds: string[]): void;
  /** Win-back comeback offer surfaced on return after an absence (Phase 3). */
  onComeback(c: Comeback): void;
  /** Full season pass state (hello.ok, or after a claim). */
  onSeasonState(season: SeasonState): void;
  /** Light per-game season push: crowns earned this game + the reached tier. */
  onSeasonProgress(p: { crowns: number; tier: number; gained: number; dailyGames: number }): void;
  /** Own stable profile from hello.ok: identity (name/flag) + ELO + W/L + public pid. */
  onProfile(p: { name?: string; flag?: string; elo?: number; games?: number; wins?: number; pid?: string }): void;
  /** Responsible-gaming limits (E5.2). */
  onLimits(limits: LimitsState): void;
  /** Geo-gating (E5.4): staked play disabled in this region. */
  onGeo(stakingBlocked: boolean): void;
  /** The socket dropped mid-game; the session is retrying in the background. */
  onReconnecting(): void;
  /** Reconnected: full match context + state resync. */
  onResumed(match: MatchInfo, state: GameState): void;
  /** The in-progress game could not be resumed (gave up / session expired). */
  onGone(): void;
  /** Friends, incoming requests and SENT (outgoing) invitations —
   *  hello.ok snapshot or a live friends.update push. */
  onFriends?(friends: FriendInfo[], requests: FriendInfo[], outgoing?: FriendInfo[]): void;
  /** A friend challenges me RIGHT NOW (live in-app offer; code = their table). */
  onChallengeOffer?(offer: { code: string; stakeCents: StakeCents; from: FriendInfo }): void;
  /** A friend just GIFTED me a cosmetic (live push; ownership already durable). */
  onGiftReceived?(gift: { from: FriendInfo; id: string; ownedIds: string[] }): void;
  /** The last opponent clicked Rematch and is waiting — surface Accept/Decline. */
  onRematchOffer(opponentName: string): void;
  /** A rematch we were waiting on won't happen (opponent declined or left). */
  onRematchCancelled(reason: 'declined' | 'left'): void;
}

export interface GameSession {
  roll(): void;
  move(token: number): void;
  /** Send a quick emote to the opponent (id must be in EMOTES). */
  emote(id: string): void;
  /** Send a directed gift to an opponent seat (id in GIFTS). */
  gift(to: number, id: string): void;
  /** Deliberately forfeit the current match (the opponent wins). */
  resign(): void;
  /** Ask for a rematch on THIS live session (true direct rematch — the server
   *  re-pairs the same opponent if they also asked, else re-queues). Returns
   *  true if handled here; false → the caller should start a fresh session. */
  rematch(): boolean;
  /** Decline the opponent's rematch offer / leave the end screen, so a waiting
   *  opponent is told instead of hanging on "searching…". */
  declineRematch(): void;
  dispose(): void;
}

// ---------------------------------------------------------------- Local (bot)

export class LocalBotSession implements GameSession {
  private state: GameState = newGame();
  private diceIndex = 0;
  private disposed = false;

  constructor(
    private readonly ev: SessionEvents,
    private readonly stakeCents: StakeCents,
  ) {
    const pot = Math.floor(stakeCents * 2 * (1 - RAKE_BPS / 10_000));
    setTimeout(() => {
      if (this.disposed) return;
      ev.onMatchFound({
        gameId: `local-${Date.now()}`,
        seat: 0,
        opponent: { name: 'Kwame', elo: 1255, flag: '🌍' }, // bots show the globe: a flag means "chosen in a profile"
        stakeCents,
        potCents: pot,
        fairnessCommit: 'local-bot (client randomness, unstaked)',
      });
      ev.onState(this.state);
      ev.onTurn(0, Date.now() + 15_000);
    }, 1400);
  }

  roll(): void {
    if (this.disposed || this.state.turn !== 0 || this.state.phase !== 'awaiting-roll') return;
    this.doRoll(0);
  }

  move(token: number): void {
    if (this.disposed || this.state.turn !== 0 || this.state.phase !== 'awaiting-move') return;
    if (!this.state.legal.includes(token)) return;
    this.applyMove(0, token);
  }

  emote(id: string): void {
    // no socket to broadcast to — echo the player's own emote locally (seat 0)
    if (!this.disposed) this.ev.onEmote(0, id);
  }

  gift(to: number, id: string): void {
    // practice: echo the gift locally over the target seat (the bot at seat 1)
    if (!this.disposed) this.ev.onGift(0, to, id);
  }

  resign(): void {
    if (this.disposed) return;
    // forfeit vs the local bot: the opponent (seat 1) wins; no real stake moves.
    const pot = this.stakeCents * 2;
    const rakeCents = Math.floor((pot * RAKE_BPS) / 10_000);
    this.ev.onOver({ winner: 1, reason: 'resign', payoutCents: pot - rakeCents, rakeCents, eloDelta: -14 });
    this.disposed = true;
  }

  rematch(): boolean {
    return false; // local bot: no live socket to reuse — the caller starts fresh
  }

  declineRematch(): void {
    /* local bot: no opponent waiting on us */
  }

  dispose(): void {
    this.disposed = true;
  }

  private die(): number {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return 1 + ((buf[0] ?? 0) % 6);
  }

  private doRoll(seat: Seat): void {
    const value = this.die();
    this.diceIndex += 1;
    this.state = applyRoll(this.state, value);
    this.ev.onDice(value, this.diceIndex, seat);

    if (this.state.phase === 'awaiting-move') {
      if (this.state.legal.length === 1) {
        const only = this.state.legal[0];
        if (only !== undefined) setTimeout(() => this.applyMove(seat, only), FORCED_MOVE_MS);
      } else if (seat === 1) {
        const pick = pickAutoMove(this.state, 1, value) ?? this.state.legal[0];
        if (pick !== undefined) setTimeout(() => this.applyMove(1, pick), BOT_MOVE_MS);
      } else {
        // seat 0 with a REAL choice: the human must pick a token, so the client
        // needs the post-roll state (phase=awaiting-move + legal list) to make
        // tokens tappable. The server (room.ts) broadcasts game.state here for
        // exactly this reason; the local bot has no server, so emit it ourselves.
        // Without it the board shows nothing to tap and the die looks frozen after
        // the player's own roll (only after the opening, once a roll first yields
        // more than one legal move).
        this.ev.onState(this.state);
      }
    } else {
      // Rolled with no legal move (or a three-6 burn): applyRoll ALREADY flipped the
      // turn, but only onTurn (activeTurn) fires below — the store's game.turn stays
      // stale, so when the turn hands BACK to the human (e.g. the bot rolls a no-move)
      // the client's `handoff` guard hides the roll button and the die freezes for
      // good. Publish the flipped state first, mirroring the server's announceTurn
      // (room.ts), which broadcasts game.state on every turn pass for this exact reason.
      this.ev.onState(this.state);
      this.afterTurnChange(0);
    }
  }

  private applyMove(seat: Seat, token: number): void {
    if (this.disposed) return;
    // walk length of the moved pawn drives how long we hold the turn indicator
    const oldRel = this.state.positions[seat]?.[token] ?? -1;
    const { state, events } = applyMove(this.state, token);
    const newRel = state.positions[seat]?.[token] ?? oldRel;
    const steps = oldRel >= 0 ? Math.max(1, newRel - oldRel) : 1; // entering from base = 1 hop
    const animMs = steps * WALK_STEP_MS + WALK_TWEEN_MS;
    this.state = state;
    this.ev.onMoved(state, events.capture, events.extraTurn);
    if (events.won) {
      const pot = this.stakeCents * 2;
      const rakeCents = Math.floor((pot * RAKE_BPS) / 10_000);
      this.ev.onOver({
        winner: seat,
        reason: 'finish',
        payoutCents: pot - rakeCents,
        rakeCents,
        eloDelta: seat === 0 ? 16 : -14,
      });
      return;
    }
    this.afterTurnChange(animMs);
  }

  /**
   * Pass the turn only after the pawn has finished walking (animMs) plus a
   * deliberate beat, so the turn indicator and the next roll don't fire while
   * the piece is still mid-animation.
   */
  private afterTurnChange(animMs: number): void {
    setTimeout(() => {
      if (this.disposed) return;
      this.ev.onTurn(this.state.turn, Date.now() + 15_000);
      if (this.state.turn === 1 && this.state.phase === 'awaiting-roll') {
        setTimeout(() => {
          if (!this.disposed && this.state.turn === 1 && this.state.phase === 'awaiting-roll') {
            this.doRoll(1);
          }
        }, BOT_ROLL_MS);
      }
    }, animMs + TURN_BEAT_MS);
  }
}

// ---------------------------------------------------------------- Remote (ws)

/** What the session does after hello (E4.4 adds private tables). */
export type JoinIntent =
  | { kind: 'queue' }
  | { kind: 'freeroll' } // ticket-gated free 1v1 (entry spent server-side at match)
  | { kind: 'create' }
  | { kind: 'join'; code: string }
  // Challenge a FRIEND (E-social 2): the server creates a private table AND
  // pushes them a live in-app offer when they're connected; the table.created
  // reply drives the same waiting/share UI as a normal private table.
  | { kind: 'challenge'; pid: string };

// R-WEB-2: the resume token lives in localStorage, not sessionStorage, so it
// SURVIVES an OS-initiated webview/tab kill (a routine Android/MiniPay lifecycle
// event when backgrounded). On relaunch the client can resume an in-progress
// staked game instead of being auto-played to a timeout-forfeit and losing the
// escrowed stake. Two tabs now share the token — safe since the server take-over
// (R-RT-1) lets the newest socket own the session and the stale one go quiet.
const TOKEN_KEY = 'ludo.sessionToken';

/** One-shot lobby sync at app open: pulls fresh league standings + daily
 *  challenge/limits over a throwaway hello, so device-cached data self-heals
 *  (weekly rollover, server-side resets) without waiting for the next game.
 *  Resumes the tab's session token when one exists — same identity as the next
 *  game — and adopts the returned token so a fresh guest keeps ONE anon pid
 *  across sync + play. Silent on failure: offline keeps the cache. */
export function syncLobby(
  serverUrl: string,
  walletAddress: string | undefined,
  on: {
    league(league: LeagueState): void;
    challenge(challenge: ChallengeState): void;
    streak(streak: StreakState): void;
    limits(limits: LimitsState): void;
    season?(season: SeasonState): void;
    friends?(friends: FriendInfo[], requests: FriendInfo[], outgoing?: FriendInfo[]): void;
  },
): void {
  let ws: WebSocket;
  try {
    ws = new WebSocket(withQa(serverUrl));
  } catch {
    return;
  }
  const timer = setTimeout(() => ws.close(), 8_000);
  ws.onopen = () => {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    const entropy = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    let token: string | null = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
    ws.send(JSON.stringify({ t: 'hello', entropy, sessionToken: token ?? undefined, wallet: walletAddress, miniPay: isMiniPay(), fingerprint: deviceFingerprint() }));
  };
  ws.onmessage = (e) => {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(String(e.data)) as ServerMsg;
    } catch {
      return;
    }
    if (msg.t !== 'hello.ok') return;
    clearTimeout(timer);
    try {
      if (msg.sessionToken) localStorage.setItem(TOKEN_KEY, msg.sessionToken);
    } catch {
      /* storage unavailable */
    }
    if (msg.league) on.league(msg.league);
    if (msg.challenge) on.challenge(msg.challenge);
    if (msg.streak) on.streak(msg.streak);
    if (msg.limits) on.limits(msg.limits);
    if (msg.season) on.season?.(msg.season);
    if (msg.friends || msg.friendRequests || msg.friendsOutgoing) on.friends?.(msg.friends ?? [], msg.friendRequests ?? [], msg.friendsOutgoing ?? []);
    ws.close();
  };
  ws.onerror = () => clearTimeout(timer);
}

/**
 * One-shot friend action (add = request/accept, remove = silent de-friend).
 * Resumes the tab's session token, includes the MiniPay flag so the wallet is
 * PROVEN (friend.* is gated on walletProven server-side), sends the action and
 * resolves with the refreshed lists from the server's friends.update push (or
 * null on timeout / unproven wallet).
 */
export function sendFriendAction(
  serverUrl: string,
  action: { t: 'friend.add' | 'friend.remove'; pid: string },
  walletAddress?: string,
): Promise<{ friends: FriendInfo[]; requests: FriendInfo[]; outgoing?: FriendInfo[] } | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(withQa(serverUrl));
    } catch {
      resolve(null);
      return;
    }
    const done = (v: { friends: FriendInfo[]; requests: FriendInfo[]; outgoing?: FriendInfo[] } | null): void => {
      resolve(v);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
    // 10 s (was 4 s): on the target audience's slow mobile links, a fresh WS
    // handshake + hello + friend.add + friends.update round-trip legitimately
    // took >4 s, so the accept/add would spuriously report failure ("impossible
    // d'accepter") even though the edge was created server-side.
    const timer = setTimeout(() => done(null), 10_000);
    const entropy = (() => {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    })();
    let token: string | null = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', entropy, sessionToken: token ?? undefined, wallet: walletAddress, miniPay: isMiniPay(), fingerprint: deviceFingerprint() }));
      ws.send(JSON.stringify(action));
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'friends.update') {
        clearTimeout(timer);
        done({ friends: msg.friends, requests: msg.requests, outgoing: msg.outgoing });
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
  });
}

/**
 * One-shot: claim the ticket bonus for a COMPLETED cosmetic set (phase 3).
 * Resumes the player's session, sends collection.claim, resolves with the new
 * balance + claimed list (or null on failure/incomplete set).
 */
export function claimCollection(
  serverUrl: string,
  setId: string,
  walletAddress?: string,
): Promise<{ tickets: number; claimedSets: string[]; granted: number } | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(withQa(serverUrl));
    } catch {
      resolve(null);
      return;
    }
    const done = (v: { tickets: number; claimedSets: string[]; granted: number } | null): void => {
      resolve(v);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
    const timer = setTimeout(() => done(null), 5000);
    const entropy = (() => {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    })();
    let token: string | null = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', entropy, sessionToken: token ?? undefined, wallet: walletAddress, miniPay: isMiniPay(), fingerprint: deviceFingerprint() }));
      ws.send(JSON.stringify({ t: 'collection.claim', setId }));
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'collection.claimed') {
        clearTimeout(timer);
        done({ tickets: msg.tickets, claimedSets: msg.claimedSets, granted: msg.granted });
      } else if (msg.t === 'error') {
        clearTimeout(timer);
        done(null);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
  });
}

/**
 * One-shot cosmetic gift to a MUTUAL friend (cosmetics phase 2). Same lifecycle
 * as sendFriendAction: resume the tab's session, send friend.gift, resolve with
 * the server's ack (new ticket balance) — or the error string, or null on
 * timeout. The grant is durable server-side whether or not the friend is online.
 */
export function sendFriendGift(
  serverUrl: string,
  pid: string,
  cosmeticId: string,
  walletAddress?: string,
): Promise<{ tickets: number } | { error: string } | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(withQa(serverUrl));
    } catch {
      resolve(null);
      return;
    }
    const done = (v: { tickets: number } | { error: string } | null): void => {
      resolve(v);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
    const timer = setTimeout(() => done(null), 4000);
    const entropy = (() => {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    })();
    let token: string | null = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', entropy, sessionToken: token ?? undefined, wallet: walletAddress, miniPay: isMiniPay(), fingerprint: deviceFingerprint() }));
      ws.send(JSON.stringify({ t: 'friend.gift', pid, id: cosmeticId }));
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'friend.gifted') {
        clearTimeout(timer);
        done({ tickets: msg.tickets });
      } else if (msg.t === 'error') {
        clearTimeout(timer);
        done({ error: msg.message });
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
  });
}

/**
 * One-shot profile save (edited name/flag). Resumes the player's session so the
 * server persists it to their wallet row, then resolves with the SERVER-VALIDATED
 * name/flag from hello.ok (the sanitizer may have changed the typed name), or null
 * on timeout. The caller adopts whatever the server returns.
 */
export function pushIdentity(
  serverUrl: string,
  name: string,
  flag: string,
  walletAddress?: string,
  avatar?: string,
): Promise<{ name: string; flag: string } | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(withQa(serverUrl));
    } catch {
      resolve(null);
      return;
    }
    const done = (v: { name: string; flag: string } | null): void => {
      resolve(v);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
    const timer = setTimeout(() => done(null), 4000);
    const entropy = (() => {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    })();
    ws.onopen = () => {
      // NO sessionToken: resuming would rebind (hijack) a live game socket onto
      // this throwaway one. The wallet alone keys the persisted row, so the
      // server saves the edited identity to the right player without a resume.
      ws.send(JSON.stringify({ t: 'hello', entropy, wallet: walletAddress, miniPay: isMiniPay(), name, flag, avatar }));
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'hello.ok') {
        clearTimeout(timer);
        done(msg.name && msg.flag ? { name: msg.name, flag: msg.flag } : null);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
  });
}

/**
 * One-shot public-profile fetch (tap-on-avatar, E-social). Deliberately does
 * NOT resume the session (no sessionToken): a resume rebinds the session's
 * socket server-side, which would hijack a live game connection. A fresh
 * anonymous hello — with the wallet when known, so the server can personalize
 * the head-to-head — is enough for a read.
 */
export function fetchProfile(serverUrl: string, pid: string): Promise<PublicProfile | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(withQa(serverUrl));
    } catch {
      resolve(null);
      return;
    }
    const done = (v: PublicProfile | null): void => {
      resolve(v);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
    const timer = setTimeout(() => done(null), 4000);
    const entropy = (() => {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    })();
    ws.onopen = () => {
      // Anonymous read: no wallet claim → the server never personalizes h2h to an
      // unproven identity (closes the pairwise-history leak). Authenticated h2h
      // will ride the live game session instead (C4).
      ws.send(JSON.stringify({ t: 'hello', entropy }));
      ws.send(JSON.stringify({ t: 'profile.get', pid }));
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      // This socket only ever sends hello + one profile.get, so any error is ours.
      if (msg.t === 'profile.info' && msg.profile.pid === pid) {
        clearTimeout(timer);
        done(msg.profile);
      } else if (msg.t === 'error') {
        clearTimeout(timer);
        done(null);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
  });
}

/**
 * One-shot responsible-gaming update (E5.2): opens a short-lived socket, sends
 * limits.set, resolves with the resulting limits (or null on timeout).
 */
export function sendLimits(
  serverUrl: string,
  payload: { dailyLimitCents?: number; selfExcludeDays?: number },
  walletAddress?: string,
): Promise<LimitsState | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(withQa(serverUrl));
    } catch {
      resolve(null);
      return;
    }
    const done = (v: LimitsState | null): void => {
      resolve(v);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
    const timer = setTimeout(() => done(null), 4000);
    const entropy = (() => {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    })();
    let token: string | null = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', entropy, sessionToken: token ?? undefined, wallet: walletAddress, fingerprint: deviceFingerprint() }));
      ws.send(JSON.stringify({ t: 'limits.set', ...payload }));
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'limits.update') {
        clearTimeout(timer);
        done(msg.limits);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
  });
}

/**
 * One-shot: unlock a premium dice skin by spending tickets (server-authoritative).
 * Resumes the player's session (sessionToken) so their earned tickets are spent,
 * then resolves with the new owned list + ticket total (or null on failure).
 */
export function buySkin(
  serverUrl: string,
  skinId: string,
  walletAddress?: string,
): Promise<{ ownedIds: string[]; tickets: number } | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(withQa(serverUrl));
    } catch {
      resolve(null);
      return;
    }
    const done = (v: { ownedIds: string[]; tickets: number } | null): void => {
      resolve(v);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
    const timer = setTimeout(() => done(null), 5000);
    const entropy = (() => {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    })();
    let token: string | null = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', entropy, sessionToken: token ?? undefined, wallet: walletAddress, fingerprint: deviceFingerprint() }));
      ws.send(JSON.stringify({ t: 'skin.buy', skinId }));
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'skin.owned') {
        clearTimeout(timer);
        done({ ownedIds: msg.ownedIds, tickets: msg.tickets });
      } else if (msg.t === 'error') {
        clearTimeout(timer);
        done(null);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
  });
}

/**
 * One-shot: claim a cosmetic bought with cUSD on-chain (rec 6). Sends the buy tx
 * hash + cosmetic id; the server verifies the tx credited THIS wallet before
 * granting ownership. Resolves with the owned list + ticket total (or null).
 */
export function claimCosmetic(
  serverUrl: string,
  txHash: string,
  id: string,
  walletAddress?: string,
): Promise<{ ownedIds: string[]; tickets: number } | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(withQa(serverUrl));
    } catch {
      resolve(null);
      return;
    }
    const done = (v: { ownedIds: string[]; tickets: number } | null): void => {
      resolve(v);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
    const timer = setTimeout(() => done(null), 20000); // chain read can be slow
    const entropy = (() => {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    })();
    let token: string | null = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', entropy, sessionToken: token ?? undefined, wallet: walletAddress, fingerprint: deviceFingerprint() }));
      ws.send(JSON.stringify({ t: 'cosmetic.claim', txHash, id }));
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'skin.owned') {
        clearTimeout(timer);
        done({ ownedIds: msg.ownedIds, tickets: msg.tickets });
      } else if (msg.t === 'error') {
        clearTimeout(timer);
        done(null);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
  });
}
/**
 * One-shot: claim a season-pass tier reward. Opens a short-lived socket, hellos
 * (so the server resolves this player's pid + wallet proof), sends season.claim,
 * and resolves with the fresh SeasonState the server pushes back — or null on
 * error/timeout. Mirrors buySkin: claims happen from the lobby, outside a game.
 */
export function claimSeasonReward(
  serverUrl: string,
  tier: number,
  lane: 'free' | 'premium',
  walletAddress?: string,
): Promise<SeasonState | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(withQa(serverUrl));
    } catch {
      resolve(null);
      return;
    }
    const done = (v: SeasonState | null): void => {
      resolve(v);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
    const timer = setTimeout(() => done(null), 5000);
    const entropy = (() => {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    })();
    let token: string | null = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', entropy, sessionToken: token ?? undefined, wallet: walletAddress, fingerprint: deviceFingerprint() }));
      ws.send(JSON.stringify({ t: 'season.claim', tier, lane }));
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      // The successful claim ends with a fresh season.state (a preceding
      // tickets.grant, if any, is folded into that state's claimed lists).
      if (msg.t === 'season.state') {
        clearTimeout(timer);
        done(msg.season);
      } else if (msg.t === 'error') {
        clearTimeout(timer);
        done(null);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
  });
}
/**
 * One-shot: unlock the premium season pass. Sends the verified USDT purchase tx;
 * the server confirms it on-chain (like cosmetic.claim), flips premium on, and
 * retro-unlocks reached tiers, then pushes the fresh SeasonState we resolve with.
 */
export function buySeasonPremium(
  serverUrl: string,
  txHash: string,
  walletAddress?: string,
): Promise<SeasonState | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(withQa(serverUrl));
    } catch {
      resolve(null);
      return;
    }
    const done = (v: SeasonState | null): void => {
      resolve(v);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
    const timer = setTimeout(() => done(null), 20000); // chain read can be slow
    const entropy = (() => {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    })();
    let token: string | null = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', entropy, sessionToken: token ?? undefined, wallet: walletAddress, fingerprint: deviceFingerprint() }));
      ws.send(JSON.stringify({ t: 'season.buyPremium', txHash }));
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'season.state') {
        clearTimeout(timer);
        done(msg.season);
      } else if (msg.t === 'error') {
        clearTimeout(timer);
        done(null);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
  });
}
/**
 * One-shot: buy a streak-freeze with tickets. Resolves with the fresh StreakState
 * (freezes + ticket total) the server pushes back, or null on error/timeout.
 */
export function buyStreakFreeze(serverUrl: string, walletAddress?: string): Promise<StreakState | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(withQa(serverUrl));
    } catch {
      resolve(null);
      return;
    }
    const done = (v: StreakState | null): void => {
      resolve(v);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
    const timer = setTimeout(() => done(null), 5000);
    const entropy = (() => {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    })();
    let token: string | null = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', entropy, sessionToken: token ?? undefined, wallet: walletAddress, fingerprint: deviceFingerprint() }));
      ws.send(JSON.stringify({ t: 'streak.buyFreeze' }));
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'streak.update') {
        clearTimeout(timer);
        done(msg.streak);
      } else if (msg.t === 'error') {
        clearTimeout(timer);
        done(null);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
  });
}
/** ~500 ms → 4 s backoff; 12 attempts ≈ 45 s of retrying (covers a 20 s cut). */
const MAX_RECONNECT_ATTEMPTS = 12;
/** The INITIAL connection is retried this many times before we declare the server
 *  unreachable. The target audience is low-end Android on slow 3G, where a single
 *  wss handshake can miss a tight window on jitter/packet loss — one slow attempt
 *  must NOT read as "server unreachable" (private tables have no bot fallback).
 *  Raised from 4 → 7 so a brief server blip (a single-machine redeploy restart is
 *  a few connection-refused seconds) is ridden out silently rather than surfacing
 *  the alarming "Server unreachable" toast + bot drop the moment it happens. */
const MAX_INITIAL_ATTEMPTS = 7;

export class RemoteSession implements GameSession {
  private ws: WebSocket | null = null;
  private disposed = false;
  private inGame = false;
  private attempts = 0;
  private initialAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timestamp of the LAST message received — the liveness signal. A websocket
   *  can die silently (mobile screen off, laptop sleep, NAT timeout): no close
   *  event ever fires, so without an app-level heartbeat the UI freezes on the
   *  last state while the server auto-plays us ("opponent away"). */
  private lastSeen = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** Waking from background: probe immediately; if nothing answers fast, the
   *  socket is a zombie — force-close it so the reconnect path takes over. */
  private readonly onVisible = (): void => {
    if (this.disposed || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    this.send({ t: 'ping' });
    const probeAt = Date.now();
    setTimeout(() => {
      if (!this.disposed && this.lastSeen < probeAt && this.ws) this.ws.close();
    }, 3_500);
  };
  private entropy = ''; // fresh 256-bit value per game (regenerated on rematch)
  private entropyCommit = ''; // sha256(entropy); sent in hello / rematch (anti-grinding)
  private revealedGameId = ''; // gameId we last revealed entropy for (once per game)

  constructor(
    private readonly ev: SessionEvents,
    private readonly stakeCents: StakeCents,
    private readonly serverUrl: string,
    private readonly onUnavailable: () => void,
    /** Wallet address to settle to on-chain (E3.3); sent in hello. */
    private readonly walletAddress?: string,
    /** What to do after hello: join the queue (default) or a private table. */
    private readonly intent: JoinIntent = { kind: 'queue' },
    /** Consent + wallet signer for staked play (18+/ToS + SIWE ownership proof). */
    private readonly auth?: WalletAuth,
  ) {
    this.freshEntropy();
    // Commit to our entropy (hash) BEFORE connecting, so hello can carry the commit
    // and the server binds its seed without ever seeing our raw value first.
    void sha256Hex(this.entropy).then((c) => {
      this.entropyCommit = c;
      this.connect(true);
    });
    // Liveness heartbeat: ping every 10s; if NOTHING has arrived for 25s the
    // socket is silently dead — close it so the reconnect + resume path runs.
    this.heartbeat = setInterval(() => {
      if (this.disposed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.send({ t: 'ping' });
      if (this.lastSeen && Date.now() - this.lastSeen > 25_000) this.ws.close();
    }, 10_000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible);
  }

  /** Draw fresh 256-bit entropy for a new match (first game, or a rematch). */
  private freshEntropy(): void {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    this.entropy = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  private connect(initial: boolean): void {
    const ws = new WebSocket(withQa(this.serverUrl));
    this.ws = ws;
    // Per-attempt handshake budget. Kept generous (not the old 2.5 s) because on a
    // distant/3G link the TCP+TLS+WS upgrade legitimately takes a few seconds; a too
    // tight window turned normal jitter into a false "server unreachable".
    const failTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) ws.close();
    }, 4500);

    ws.onopen = () => {
      clearTimeout(failTimer);
      this.send({
        t: 'hello',
        entropyCommit: this.entropyCommit,
        sessionToken: this.token() ?? undefined,
        wallet: this.walletAddress,
        fingerprint: deviceFingerprint(),
        consent: this.auth?.consent,
        miniPay: isMiniPay(), // trusted address → server accepts it without SIWE
        frame: loadFrameId(), // equipped avatar frame (cosmetic, broadcast to others)
        avatar: loadAvatarId(), // chosen 3D profile avatar (broadcast to others)
        diceSkin: loadSkinId(), // equipped DICE skin (opponent sees my die roll)
        tokenSkin: loadTokenSkinId(), // equipped pawn skin (opponent sees it on my pieces)
        entranceFx: loadEntranceFxId(), // entrance effect (played at match start)
        victoryFx: loadVictoryFxId(), // victory effect (the loser watches it too)
        ...loadCustomIdentity(), // edited display name / country flag
      });
      if (initial) {
        if (this.intent.kind === 'create') this.send({ t: 'table.create', stake: this.stakeCents });
        else if (this.intent.kind === 'join') this.send({ t: 'table.join', code: this.intent.code });
        else if (this.intent.kind === 'challenge') this.send({ t: 'friend.challenge', pid: this.intent.pid, stake: this.stakeCents });
        else if (this.intent.kind === 'freeroll') this.send({ t: 'queue.join', stake: 0, freeroll: true });
        else this.send({ t: 'queue.join', stake: this.stakeCents });
      }
    };
    ws.onclose = () => {
      clearTimeout(failTimer);
      if (this.disposed) return;
      if (!this.inGame) {
        if (!initial) return;
        // Initial connection never reached a game. RETRY a few times before giving
        // up: a single slow/dropped handshake on 3G must not read as "unreachable".
        // Only after the retries are exhausted do we fall back (bot for matchmaking,
        // back-to-lobby for a private table). Re-uses reconnectTimer (idle here).
        this.initialAttempts += 1;
        if (this.initialAttempts < MAX_INITIAL_ATTEMPTS) {
          const delay = Math.min(400 * 2 ** (this.initialAttempts - 1), 2000);
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.disposed) this.connect(true);
          }, delay);
        } else {
          this.onUnavailable();
        }
        return;
      }
      this.scheduleReconnect();
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      this.lastSeen = Date.now(); // any traffic proves the socket is alive
      this.handle(msg);
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.attempts += 1;
    if (this.attempts > MAX_RECONNECT_ATTEMPTS) {
      this.inGame = false;
      this.ev.onGone();
      return;
    }
    if (this.attempts === 1) this.ev.onReconnecting();
    const delay = Math.min(500 * 2 ** (this.attempts - 1), 4000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed) this.connect(false);
    }, delay);
  }

  private token(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'hello.ok': {
        try {
          localStorage.setItem(TOKEN_KEY, msg.sessionToken);
        } catch {
          /* storage unavailable: reconnection within this session still works */
        }
        // Wallet ownership proof (SIWE): the server issued a nonce — sign it so
        // staked play is unlocked. Only prompt when this session is actually for
        // money (staked queue/create, or a private-table join that may be staked)
        // so free/freeroll play never triggers a wallet signature. A rejected
        // signature just leaves staking gated server-side.
        const stakedIntent = this.stakeCents > 0 || this.intent.kind === 'join';
        if (msg.walletNonce && stakedIntent && this.auth?.signMessage) {
          void this.auth
            .signMessage(walletProofMessage(msg.walletNonce))
            .then((signature) => this.send({ t: 'wallet.prove', signature }))
            .catch(() => {
              /* user declined the signature; server keeps staking gated */
            });
        }
        const wasReconnecting = this.attempts > 0;
        this.attempts = 0;
        this.initialAttempts = 0; // server is proven reachable → later drops retry generously, not "unreachable"
        if (msg.challenge) this.ev.onChallenge(msg.challenge);
        if (msg.streak) this.ev.onStreak(msg.streak);
        if (msg.league) this.ev.onLeague(msg.league);
        if (msg.limits) this.ev.onLimits(msg.limits);
        if (msg.ownedSkins) this.ev.onSkins(msg.ownedSkins);
        if (msg.claimedSets) this.ev.onClaimedSets?.(msg.claimedSets);
        if (msg.season) this.ev.onSeasonState(msg.season);
        if (msg.friends || msg.friendRequests || msg.friendsOutgoing) this.ev.onFriends?.(msg.friends ?? [], msg.friendRequests ?? [], msg.friendsOutgoing ?? []);
        if (msg.comeback) this.ev.onComeback(msg.comeback);
        // Guests: pin the FIRST server-assigned identity (no-op once any name is
        // saved). Without this the server derives a NEW name per connection, so
        // friends saw a different name for the same player in every game.
        adoptServerIdentity(msg.name);
        // Only apply the FULL profile from a WALLET-backed session — a wallet-less
        // freeroll/free-table connection carries a throwaway anon identity + 0/0
        // that must not clobber the returning wallet player's cached profile.
        if (this.walletAddress) {
          this.ev.onProfile({ name: msg.name, flag: msg.flag, elo: msg.elo, games: msg.games, wins: msg.wins, pid: msg.pid });
        } else {
          // Surface ONLY the identity (never stats): the banner must show the
          // name opponents see, not a localized "You" that matches nothing.
          const id = loadCustomIdentity();
          if (id.name) this.ev.onProfile({ name: id.name, flag: id.flag });
        }
        if (msg.stakingBlocked !== undefined) this.ev.onGeo(msg.stakingBlocked);
        // Record the escrow addresses the server settles against, so a stake can
        // be refused before deposit if this bundle's addresses drifted (G-2).
        setServerContracts(msg.contracts);
        if (msg.resumed) {
          this.inGame = true;
          this.ev.onResumed(msg.resumed, msg.resumed.state);
        } else if (wasReconnecting && this.inGame) {
          // the game ended (or expired) while we were away
          this.inGame = false;
          this.ev.onGone();
        }
        break;
      }
      case 'match.found':
        this.inGame = true;
        // Anti-grinding reveal: the server has committed its seed (msg.fairnessCommit);
        // now reveal our raw entropy so the dice can be finalized. Keyed by gameId so
        // a rematch (a NEW game on the same socket) re-reveals — otherwise the rematch
        // game never finalizes and the dice stay blocked.
        if (this.revealedGameId !== msg.gameId) {
          this.revealedGameId = msg.gameId;
          this.send({ t: 'game.entropy', entropy: this.entropy });
        }
        // Carry our own entropy so the fairness modal can prove the server bound it
        // at our seat in the reveal (R-DICE-1), not pre-grind the sequence itself.
        this.ev.onMatchFound({ ...msg, myEntropy: this.entropy });
        break;
      case 'game.state':
        this.ev.onState(msg.state);
        break;
      case 'game.dice':
        this.ev.onDice(msg.value, msg.index, msg.seat);
        break;
      case 'game.moved':
        this.ev.onMoved(msg.state, msg.capture, msg.extraTurn);
        break;
      case 'game.turn':
        this.ev.onTurn(msg.seat, msg.deadlineTs);
        break;
      case 'game.auto':
        this.ev.onAutoPlayed(msg.seat, msg.count, msg.max);
        break;
      case 'game.emote':
        this.ev.onEmote(msg.seat, msg.id);
        break;
      case 'game.gift':
        this.ev.onGift(msg.from, msg.to, msg.id);
        break;
      case 'game.over':
        this.inGame = false;
        this.ev.onOver(msg);
        break;
      case 'game.settled':
        this.ev.onSettled(msg.txHash);
        break;
      case 'game.refunded':
        this.ev.onRefunded(msg.txHash);
        break;
      case 'challenge.update':
        this.ev.onChallenge(msg.challenge);
        break;
      case 'league.update':
        this.ev.onLeague(msg.league);
        break;
      case 'table.created':
        this.ev.onTableCreated(msg.code, msg.stakeCents);
        break;
      case 'tickets.grant':
        this.ev.onTickets(msg.granted, msg.total, msg.reason);
        break;
      case 'season.state':
        this.ev.onSeasonState(msg.season);
        break;
      case 'season.progress':
        this.ev.onSeasonProgress({ crowns: msg.crowns, tier: msg.tier, gained: msg.gained, dailyGames: msg.dailyGames });
        break;
      case 'limits.update':
        this.ev.onLimits(msg.limits);
        break;
      case 'streak.update':
        this.ev.onStreak(msg.streak);
        break;
      case 'friends.update':
        this.ev.onFriends?.(msg.friends, msg.requests, msg.outgoing);
        break;
      case 'friend.challenge.offer':
        this.ev.onChallengeOffer?.({ code: msg.code, stakeCents: msg.stakeCents, from: msg.from });
        break;
      case 'friend.gift.received':
        this.ev.onGiftReceived?.({ from: msg.from, id: msg.id, ownedIds: msg.ownedIds });
        break;
      case 'rematch.offer':
        this.ev.onRematchOffer(msg.name);
        break;
      case 'rematch.cancelled':
        this.ev.onRematchCancelled(msg.reason);
        break;
      case 'error':
        this.ev.onInfo(msg.message, msg.code);
        break;
      default:
        break;
    }
  }

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  roll(): void {
    this.send({ t: 'game.roll' });
  }

  move(token: number): void {
    this.send({ t: 'game.move', token });
  }

  emote(id: string): void {
    this.send({ t: 'emote', id });
  }

  gift(to: number, id: string): void {
    this.send({ t: 'gift', to, id });
  }

  resign(): void {
    // server forfeits the room → game.over(reason:'resign') drives the rest.
    this.send({ t: 'game.resign' });
  }

  rematch(): boolean {
    // Reuse the still-open socket: the server re-pairs the same opponent if they
    // also asked (respecting the anti-collusion cap), else re-queues us.
    if (this.disposed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    // Draw FRESH entropy + commit for the next game and send the commit with the
    // request, so the server binds a brand-new seed WITHOUT ever knowing our raw
    // value (same fairness as a first match). We reveal the raw value when the
    // rematch's match.found arrives.
    this.freshEntropy();
    void sha256Hex(this.entropy).then((commit) => {
      this.entropyCommit = commit;
      this.send({ t: 'game.rematch', entropyCommit: commit });
    });
    return true;
  }

  declineRematch(): void {
    this.send({ t: 'rematch.decline' });
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
    this.ws?.close();
  }
}
