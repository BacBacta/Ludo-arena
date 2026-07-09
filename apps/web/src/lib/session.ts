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
  type GameOverReason,
  type OpponentInfo,
  type ServerMsg,
  type StakeCents,
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

export class RemoteSession implements GameSession {
  private ws: WebSocket;
  private disposed = false;

  constructor(
    private readonly ev: SessionEvents,
    stakeCents: StakeCents,
    serverUrl: string,
    onUnavailable: () => void,
  ) {
    const entropy = (() => {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    })();

    this.ws = new WebSocket(serverUrl);
    const failTimer = setTimeout(() => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        this.ws.close();
        onUnavailable();
      }
    }, 2500);

    this.ws.onopen = () => {
      clearTimeout(failTimer);
      this.send({ t: 'hello', entropy });
      this.send({ t: 'queue.join', stake: stakeCents });
    };
    this.ws.onerror = () => {
      clearTimeout(failTimer);
      if (!this.disposed) onUnavailable();
    };
    this.ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      this.handle(msg);
    };
  }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'match.found':
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
        this.ev.onOver(msg);
        break;
      case 'error':
        this.ev.onInfo(msg.message);
        break;
      default:
        break;
    }
  }

  private send(msg: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  roll(): void {
    this.send({ t: 'game.roll' });
  }

  move(token: number): void {
    this.send({ t: 'game.move', token });
  }

  dispose(): void {
    this.disposed = true;
    this.ws.close();
  }
}
