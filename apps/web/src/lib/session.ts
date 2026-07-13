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
import { isMiniPay } from './minipay';
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
  type GameOverReason,
  type OpponentInfo,
  type LeagueState,
  type LimitsState,
  type ServerMsg,
  type StakeCents,
  type StreakState,
} from '@ludo/shared';

/** Auth material the client attaches to a staked session: 18+/ToS consent to send
 *  in hello, and a wallet signer to answer the server's ownership-proof nonce. */
export interface WalletAuth {
  consent?: { tosVersion: string; age18: boolean };
  signMessage?: (message: string) => Promise<string>;
}

export interface MatchInfo {
  gameId: string;
  seat: Seat;
  opponent: OpponentInfo;
  stakeCents: StakeCents;
  potCents: number;
  fairnessCommit: string;
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
  onOver(result: GameResult): void;
  onInfo(message: string): void;
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
  /** Own stable profile from hello.ok: identity (name/flag) + ELO + W/L. */
  onProfile(p: { name?: string; flag?: string; elo?: number; games?: number; wins?: number }): void;
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
}

export interface GameSession {
  roll(): void;
  move(token: number): void;
  /** Send a quick emote to the opponent (id must be in EMOTES). */
  emote(id: string): void;
  /** Deliberately forfeit the current match (the opponent wins). */
  resign(): void;
  /** Ask for a rematch on THIS live session (true direct rematch — the server
   *  re-pairs the same opponent if they also asked, else re-queues). Returns
   *  true if handled here; false → the caller should start a fresh session. */
  rematch(): boolean;
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
        opponent: { name: 'Kwame', elo: 1255, flag: '🇨🇲' },
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
      }
      // seat 0 with multiple choices: wait for the player's tap
    } else {
      // rolled with no legal move — no walk, just pass the turn after a beat
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
  | { kind: 'join'; code: string };

const TOKEN_KEY = 'ludo.sessionToken';

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
      ws = new WebSocket(serverUrl);
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
      token = sessionStorage.getItem(TOKEN_KEY);
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
      ws = new WebSocket(serverUrl);
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
      token = sessionStorage.getItem(TOKEN_KEY);
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
      ws = new WebSocket(serverUrl);
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
      token = sessionStorage.getItem(TOKEN_KEY);
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
/** ~500 ms → 4 s backoff; 12 attempts ≈ 45 s of retrying (covers a 20 s cut). */
const MAX_RECONNECT_ATTEMPTS = 12;

export class RemoteSession implements GameSession {
  private ws: WebSocket | null = null;
  private disposed = false;
  private inGame = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly entropy: string;
  private entropyCommit = ''; // sha256(entropy); sent in hello (anti-grinding)
  private revealed = false; // have we revealed our entropy for this match yet?

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
    this.entropy = (() => {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    })();
    // Commit to our entropy (hash) BEFORE connecting, so hello can carry the commit
    // and the server binds its seed without ever seeing our raw value first.
    void sha256Hex(this.entropy).then((c) => {
      this.entropyCommit = c;
      this.connect(true);
    });
  }

  private connect(initial: boolean): void {
    const ws = new WebSocket(this.serverUrl);
    this.ws = ws;
    const failTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) ws.close();
    }, 2500);

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
      });
      if (initial) {
        if (this.intent.kind === 'create') this.send({ t: 'table.create', stake: this.stakeCents });
        else if (this.intent.kind === 'join') this.send({ t: 'table.join', code: this.intent.code });
        else if (this.intent.kind === 'freeroll') this.send({ t: 'queue.join', stake: 0, freeroll: true });
        else this.send({ t: 'queue.join', stake: this.stakeCents });
      }
    };
    ws.onclose = () => {
      clearTimeout(failTimer);
      if (this.disposed) return;
      if (!this.inGame) {
        // never reached a game: initial-connection failure → bot fallback
        if (initial) this.onUnavailable();
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
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'hello.ok': {
        try {
          sessionStorage.setItem(TOKEN_KEY, msg.sessionToken);
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
        if (msg.challenge) this.ev.onChallenge(msg.challenge);
        if (msg.streak) this.ev.onStreak(msg.streak);
        if (msg.league) this.ev.onLeague(msg.league);
        if (msg.limits) this.ev.onLimits(msg.limits);
        if (msg.ownedSkins) this.ev.onSkins(msg.ownedSkins);
        // Only apply the profile from a WALLET-backed session — a wallet-less
        // freeroll/free-table connection carries a throwaway anon identity + 0/0
        // that must not clobber the returning wallet player's cached profile.
        if (this.walletAddress) {
          this.ev.onProfile({ name: msg.name, flag: msg.flag, elo: msg.elo, games: msg.games, wins: msg.wins });
        }
        if (msg.stakingBlocked !== undefined) this.ev.onGeo(msg.stakingBlocked);
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
        // now reveal our raw entropy so the dice can be finalized. Sent once.
        if (!this.revealed) {
          this.revealed = true;
          this.send({ t: 'game.entropy', entropy: this.entropy });
        }
        this.ev.onMatchFound(msg);
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
      case 'limits.update':
        this.ev.onLimits(msg.limits);
        break;
      case 'error':
        this.ev.onInfo(msg.message);
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

  resign(): void {
    // server forfeits the room → game.over(reason:'resign') drives the rest.
    this.send({ t: 'game.resign' });
  }

  rematch(): boolean {
    // Reuse the still-open socket: the server re-pairs the same opponent if they
    // also asked (respecting the anti-collusion cap), else re-queues us.
    if (this.disposed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.send({ t: 'game.rematch' });
    return true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
