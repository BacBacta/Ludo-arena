/**
 * Room = one 1v1 match. The server is authoritative:
 * it runs the engine, keeps the clock (auto-move) and handles disconnections.
 * Every state transition fires onChange so the store can snapshot the room
 * (restart survival, BACKLOG E2.1).
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
import { rollDie, type Fairness } from './fairness.js';
import type { RoomSnapshot } from './store/index.js';

export interface Client {
  send(msg: ServerMsg): void;
  id: string;
  wallet?: string;
  name: string;
  elo: number;
  flag: string;
}

export interface RoomResult {
  gameId: string;
  stakeCents: StakeCents;
  winner: Seat;
  reason: GameOverReason;
  payoutCents: number;
  rakeCents: number;
  eloDelta: number;
  fairness: Fairness;
  players: [Client, Client];
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
  private deadlineTs = 0;
  private over = false;
  onEnd?: (room: Room) => void;
  /** Fired after every state transition; wire to the store for snapshots. */
  onChange?: (room: Room) => void;
  /** Fired once when the game finishes, before onEnd. */
  onResult?: (result: RoomResult) => void;
  /** Fired when `seat` captures an opponent token (daily challenge, E4.1). */
  onCapture?: (seat: Seat) => void;

  constructor(gameId: string, stakeCents: StakeCents, a: Client, b: Client, fairness: Fairness) {
    this.gameId = gameId;
    this.stakeCents = stakeCents;
    this.clients = [a, b];
    this.fairness = fairness;
    this.state = newGame();
  }

  /** Rebuild a room from a store snapshot (server restart). */
  static fromSnapshot(snap: RoomSnapshot, a: Client, b: Client): Room {
    const room = new Room(snap.gameId, snap.stakeCents, a, b, snap.fairness);
    room.state = snap.state;
    room.diceIndex = snap.diceIndex;
    room.autoMoveStreak = [...snap.autoMoveStreak];
    return room;
  }

  toSnapshot(): RoomSnapshot {
    return {
      gameId: this.gameId,
      stakeCents: this.stakeCents,
      state: this.state,
      diceIndex: this.diceIndex,
      autoMoveStreak: [...this.autoMoveStreak],
      fairness: this.fairness,
      players: [this.playerMeta(0), this.playerMeta(1)],
    };
  }

  start(): void {
    this.broadcast({ t: 'game.state', state: this.state });
    this.announceTurn();
    this.onChange?.(this);
  }

  /** Re-announce the turn after a restore (fresh clock, both clients resync). */
  resume(): void {
    if (this.over) return;
    this.broadcast({ t: 'game.state', state: this.state });
    this.announceTurn();
  }

  /** Swap in a live client (reconnection) and resync it. */
  attach(seat: Seat, client: Client): void {
    this.clients[seat] = client;
    if (this.over) return;
    client.send({ t: 'game.state', state: this.state });
    client.send({ t: 'game.turn', seat: this.state.turn, deadlineTs: this.deadlineTs });
  }

  /** The player at `seat` asks to roll the die. */
  roll(seat: Seat): void {
    if (this.over) return;
    if (this.state.turn !== seat || this.state.phase !== 'awaiting-roll') {
      this.clients[seat].send({ t: 'error', code: 'NOT_YOUR_TURN', message: 'Not your turn.' });
      return;
    }
    this.autoMoveStreak[seat] = 0;
    this.doRoll();
  }

  /** The player at `seat` plays token `token`. */
  move(seat: Seat, token: number): void {
    if (this.over) return;
    if (this.state.turn !== seat || this.state.phase !== 'awaiting-move') {
      this.clients[seat].send({ t: 'error', code: 'NOT_YOUR_TURN', message: 'Not your turn.' });
      return;
    }
    if (!this.state.legal.includes(token)) {
      this.clients[seat].send({ t: 'error', code: 'ILLEGAL_MOVE', message: 'Illegal move.' });
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

  isOver(): boolean {
    return this.over;
  }

  /** Stop the clock without finishing (server shutdown). */
  suspend(): void {
    this.clearClock();
  }

  // ---------- internal ----------

  private playerMeta(seat: Seat): RoomSnapshot['players'][number] {
    const c = this.clients[seat];
    return { sessionId: c.id, wallet: c.wallet, name: c.name, flag: c.flag, elo: c.elo };
  }

  private doRoll(): void {
    const seat = this.state.turn;
    this.diceIndex += 1;
    const die = rollDie(this.fairness, this.diceIndex);
    this.state = applyRoll(this.state, die);
    this.broadcast({ t: 'game.dice', value: die, index: this.diceIndex, seat });
    this.onChange?.(this);

    if (this.state.phase === 'awaiting-move') {
      if (this.state.legal.length === 1) {
        // only one possible move: play it immediately (fluidity)
        this.applyAndBroadcast(seat, this.state.legal[0]!);
      } else {
        this.armClock();
      }
    } else {
      // no possible move, engine already passed the turn
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
    this.onChange?.(this);
    if (events.capture) this.onCapture?.(seat);
    if (events.won) {
      this.finish(seat, 'finish');
    } else {
      this.announceTurn();
    }
  }

  private announceTurn(): void {
    if (this.over) return;
    this.deadlineTs = Date.now() + BLITZ.moveClockMs;
    this.broadcast({ t: 'game.turn', seat: this.state.turn, deadlineTs: this.deadlineTs });
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
      // if the roll opened a choice, auto-play as well
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
        // txHash: added once the on-chain arbiter is wired (BACKLOG E3.3)
      });
    }
    this.onResult?.({
      gameId: this.gameId,
      stakeCents: this.stakeCents,
      winner,
      reason,
      payoutCents,
      rakeCents,
      eloDelta: delta,
      fairness: this.fairness,
      players: [this.clients[0], this.clients[1]],
    });
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
