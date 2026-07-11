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
import {
  RAKE_BPS,
  type ChallengeState,
  type GameOverReason,
  type OpponentInfo,
  type LeagueState,
  type ServerMsg,
  type StakeCents,
  type StreakState,
} from '@ludo/shared';

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
        if (only !== undefined) setTimeout(() => this.applyMove(seat, only), 420);
      } else if (seat === 1) {
        const pick = pickAutoMove(this.state, 1, value) ?? this.state.legal[0];
        if (pick !== undefined) setTimeout(() => this.applyMove(1, pick), 550);
      }
      // seat 0 with multiple choices: wait for the player's tap
    } else {
      this.afterTurnChange();
    }
  }

  private applyMove(seat: Seat, token: number): void {
    if (this.disposed) return;
    const { state, events } = applyMove(this.state, token);
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
    this.afterTurnChange();
  }

  private afterTurnChange(): void {
    this.ev.onTurn(this.state.turn, Date.now() + 15_000);
    if (this.state.turn === 1 && this.state.phase === 'awaiting-roll') {
      setTimeout(() => {
        if (!this.disposed && this.state.turn === 1 && this.state.phase === 'awaiting-roll') {
          this.doRoll(1);
        }
      }, 800);
    }
  }
}

// ---------------------------------------------------------------- Remote (ws)

const TOKEN_KEY = 'ludo.sessionToken';
/** ~500 ms → 4 s backoff; 12 attempts ≈ 45 s of retrying (covers a 20 s cut). */
const MAX_RECONNECT_ATTEMPTS = 12;

export class RemoteSession implements GameSession {
  private ws: WebSocket | null = null;
  private disposed = false;
  private inGame = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly entropy: string;

  constructor(
    private readonly ev: SessionEvents,
    private readonly stakeCents: StakeCents,
    private readonly serverUrl: string,
    private readonly onUnavailable: () => void,
    /** Wallet address to settle to on-chain (E3.3); sent in hello. */
    private readonly walletAddress?: string,
  ) {
    this.entropy = (() => {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    })();
    this.connect(true);
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
        entropy: this.entropy,
        sessionToken: this.token() ?? undefined,
        wallet: this.walletAddress,
      });
      if (initial) this.send({ t: 'queue.join', stake: this.stakeCents });
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
        const wasReconnecting = this.attempts > 0;
        this.attempts = 0;
        if (msg.challenge) this.ev.onChallenge(msg.challenge);
        if (msg.streak) this.ev.onStreak(msg.streak);
        if (msg.league) this.ev.onLeague(msg.league);
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

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
