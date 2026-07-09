/**
 * Room = une partie 1v1. Le serveur est autoritaire :
 * il execute le moteur, tient l'horloge (auto-move) et gere les deconnexions.
 */
import {
  applyMove,
  applyRoll,
  BLITZ,
  newGame,
  pickAutoMove,
} from '@ludo/game-engine';
import type { GameState, Seat } from '@ludo/game-engine';
import { RAKE_BPS, type GameOverReason, type ServerMsg, type StakeCents } from '@ludo/shared';
import { eloDelta } from './elo.js';
import { createFairness, rollDie, type Fairness } from './fairness.js';

export interface Client {
  send(msg: ServerMsg): void;
  wallet?: string;
  name: string;
  elo: number;
  flag: string;
}

export class Room {
  readonly gameId: string;
  readonly stakeCents: StakeCents;
  readonly fairness: Fairness;
  private state: GameState;
  private clients: [Client, Client];
  private diceIndex = 0;
  private clock: ReturnType<typeof setTimeout> | null = null;
  private autoMoveStreak: [number, number] = [0, 0];
  private over = false;
  onEnd?: (room: Room) => void;

  constructor(gameId: string, stakeCents: StakeCents, a: Client, b: Client, entropyA: string, entropyB: string) {
    this.gameId = gameId;
    this.stakeCents = stakeCents;
    this.clients = [a, b];
    this.fairness = createFairness(entropyA, entropyB);
    this.state = newGame();
  }

  start(): void {
    this.broadcast({ t: 'game.state', state: this.state });
    this.announceTurn();
  }

  /** Le joueur au siege `seat` demande a lancer le de. */
  roll(seat: Seat): void {
    if (this.over) return;
    if (this.state.turn !== seat || this.state.phase !== 'awaiting-roll') {
      this.clients[seat].send({ t: 'error', code: 'NOT_YOUR_TURN', message: 'Pas ton tour.' });
      return;
    }
    this.autoMoveStreak[seat] = 0;
    this.doRoll();
  }

  /** Le joueur au siege `seat` joue le pion `token`. */
  move(seat: Seat, token: number): void {
    if (this.over) return;
    if (this.state.turn !== seat || this.state.phase !== 'awaiting-move') {
      this.clients[seat].send({ t: 'error', code: 'NOT_YOUR_TURN', message: 'Pas ton tour.' });
      return;
    }
    if (!this.state.legal.includes(token)) {
      this.clients[seat].send({ t: 'error', code: 'ILLEGAL_MOVE', message: 'Coup illegal.' });
      return;
    }
    this.autoMoveStreak[seat] = 0;
    this.applyAndBroadcast(seat, token);
  }

  resign(seat: Seat): void {
    if (this.over) return;
    this.finish(seat === 0 ? 1 : 0, 'resign');
  }

  getState(): GameState {
    return this.state;
  }

  client(seat: Seat): Client {
    return this.clients[seat];
  }

  // ---------- interne ----------

  private doRoll(): void {
    const seat = this.state.turn;
    this.diceIndex += 1;
    const die = rollDie(this.fairness, this.diceIndex);
    this.state = applyRoll(this.state, die);
    this.broadcast({ t: 'game.dice', value: die, index: this.diceIndex, seat });

    if (this.state.phase === 'awaiting-move') {
      if (this.state.legal.length === 1) {
        // un seul coup possible : auto-play immediat (fluidite)
        this.applyAndBroadcast(seat, this.state.legal[0]!);
      } else {
        this.armClock();
      }
    } else {
      // aucun coup possible, tour passe par le moteur
      this.announceTurn();
    }
  }

  private applyAndBroadcast(seat: Seat, token: number): void {
    const { state, events } = applyMove(this.state, token);
    this.state = state;
    this.broadcast({
      t: 'game.moved',
      seat,
      token,
      capture: events.capture,
      finished: events.finished,
      extraTurn: events.extraTurn,
      state,
    });
    if (events.won) {
      this.finish(seat, 'finish');
    } else {
      this.announceTurn();
    }
  }

  private announceTurn(): void {
    if (this.over) return;
    const deadlineTs = Date.now() + BLITZ.moveClockMs;
    this.broadcast({ t: 'game.turn', seat: this.state.turn, deadlineTs });
    this.armClock();
  }

  private armClock(): void {
    this.clearClock();
    this.clock = setTimeout(() => this.onClockExpired(), BLITZ.moveClockMs);
  }

  private onClockExpired(): void {
    if (this.over) return;
    const seat = this.state.turn;
    this.autoMoveStreak[seat] += 1;
    if (this.autoMoveStreak[seat] >= BLITZ.forfeitAfterAutoMoves) {
      this.finish(seat === 0 ? 1 : 0, 'timeout-forfeit');
      return;
    }
    if (this.state.phase === 'awaiting-roll') {
      this.doRoll();
      // si le lancer ouvre un choix, on joue aussi automatiquement
      const after: GameState = this.state;
      if (after.phase === 'awaiting-move' && after.turn === seat) {
        const die = after.dice ?? 1;
        const token = pickAutoMove(after, seat, die) ?? after.legal[0];
        if (token !== undefined) this.applyAndBroadcast(seat, token);
      }
    } else if (this.state.phase === 'awaiting-move') {
      const die = this.state.dice ?? 1;
      const token = pickAutoMove(this.state, seat, die) ?? this.state.legal[0];
      if (token !== undefined) this.applyAndBroadcast(seat, token);
    }
  }

  private finish(winner: Seat, reason: GameOverReason): void {
    this.over = true;
    this.clearClock();
    const loser: Seat = winner === 0 ? 1 : 0;
    const pot = this.stakeCents * 2;
    const rakeCents = Math.floor((pot * RAKE_BPS) / 10_000);
    const payoutCents = pot - rakeCents;
    const delta = eloDelta(this.clients[winner].elo, this.clients[loser].elo);
    this.clients[winner].elo += delta;
    this.clients[loser].elo -= delta;

    for (const seat of [0, 1] as const) {
      this.clients[seat].send({
        t: 'game.over',
        winner,
        reason,
        payoutCents,
        rakeCents,
        eloDelta: seat === winner ? delta : -delta,
        fairnessReveal: {
          serverSeed: this.fairness.serverSeed,
          entropies: this.fairness.entropies,
        },
        // txHash : ajoute quand l'arbitre on-chain sera branche (BACKLOG E3.3)
      });
    }
    this.onEnd?.(this);
  }

  private clearClock(): void {
    if (this.clock) {
      clearTimeout(this.clock);
      this.clock = null;
    }
  }

  private broadcast(msg: ServerMsg): void {
    this.clients[0].send(msg);
    this.clients[1].send(msg);
  }
}
