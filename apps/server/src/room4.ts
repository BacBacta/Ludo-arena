/**
 * Room4 = one 4-player online Ludo Sit&Go (ticket entry). Server-authoritative,
 * like the 2-player Room but for the ludo4 engine and 4 seats. Empty seats are
 * filled with bots; a human who times out is auto-played, and after too many
 * auto-moves (or on resign) their seat is handed to a bot so the game always
 * finishes and someone wins. In-memory only (v1): a server restart drops the
 * game — acceptable for TICKET games (no on-chain money).
 */
import { BLITZ } from '@ludo/game-engine';
import { applyMove4, applyRoll4, newGame4, nextSeat4, pickAutoMove4, type Game4 } from '@ludo/game-engine';
import type { Player4Info, ServerMsg } from '@ludo/shared';
import { rollDie4, type Fairness4 } from './fairness.js';

export interface Client4 {
  send(msg: ServerMsg): void;
  id: string;
  name: string;
  flag: string;
}

export interface Seat4 {
  client: Client4 | null; // null = bot seat
  bot: boolean; // true once a bot drives this seat (empty seat, resign, or drop)
  name: string;
  flag: string;
}

export interface Room4Result {
  gameId: string;
  winnerSeat: number;
  seats: Seat4[];
  fairness: Fairness4;
}

const BOT_ROLL_MS = 700; // bot "thinking" before it rolls
const BOT_MOVE_MS = 900; // then before it commits its move (die settles first)

export class Room4 {
  readonly gameId: string;
  readonly entryTickets: number;
  readonly prizeTickets: number;
  /** cUSD payout to the winner + rake (0 for free/ticket tables). */
  readonly payoutCents: number;
  readonly rakeCents: number;
  readonly fairness: Fairness4;
  private state: Game4 = newGame4();
  private seats: Seat4[];
  private diceIndex = 0;
  private clock: ReturnType<typeof setTimeout> | null = null;
  private autoStreak: number[] = [0, 0, 0, 0];
  private lastEmoteAt: number[] = [0, 0, 0, 0]; // per-seat emote throttle
  private deadlineTs = 0;
  private over = false;
  onResult?: (r: Room4Result) => void;
  onEnd?: (room: Room4) => void;

  constructor(
    gameId: string,
    seats: Seat4[],
    fairness: Fairness4,
    entryTickets: number,
    prizeTickets: number,
    payoutCents = 0,
    rakeCents = 0,
  ) {
    this.gameId = gameId;
    this.seats = seats;
    this.fairness = fairness;
    this.entryTickets = entryTickets;
    this.prizeTickets = prizeTickets;
    this.payoutCents = payoutCents;
    this.rakeCents = rakeCents;
  }

  players(): Player4Info[] {
    return this.seats.map((s) => ({ name: s.name, flag: s.flag, bot: s.bot }));
  }

  seatOf(clientId: string): number {
    return this.seats.findIndex((s) => s.client?.id === clientId);
  }

  client(seat: number): Client4 | null {
    return this.seats[seat]?.client ?? null;
  }

  isOver(): boolean {
    return this.over;
  }

  getState(): Game4 {
    return this.state;
  }

  start(): void {
    this.broadcast({ t: 'game.state4', state: this.state });
    this.announceTurn();
  }

  /** A human at `seat` rolls. */
  roll(seat: number): void {
    if (this.over || this.state.turn !== seat || this.state.phase !== 'awaiting-roll') return;
    if (this.seats[seat]?.bot) return; // bot seats are server-driven
    this.autoStreak[seat] = 0;
    this.doRoll();
  }

  /** A human at `seat` moves `token`. */
  move(seat: number, token: number): void {
    if (this.over || this.state.turn !== seat || this.state.phase !== 'awaiting-move') return;
    if (!this.state.legal.includes(token)) return;
    this.autoStreak[seat] = 0;
    this.doMove(token);
  }

  /** A human forfeits: a bot drives the seat, but they STAY connected (keep their
   *  client) so they still watch the game finish and receive game.over4. */
  resign(seat: number): void {
    const s = this.seats[seat];
    if (this.over || !s || s.bot) return;
    this.handOverToBot(seat, false);
  }

  /** Quick emote broadcast to the table, throttled per seat (anti-spam). A seat
   *  handed to a bot (resigned/dropped) can't emote — its human forfeited. */
  emote(seat: number, id: string): void {
    if (this.over || seat < 0 || seat > 3 || this.seats[seat]?.bot) return;
    const now = Date.now();
    if (now - (this.lastEmoteAt[seat] ?? 0) < 1200) return;
    this.lastEmoteAt[seat] = now;
    this.broadcast({ t: 'game.emote', seat, id });
  }

  /** A human dropped (socket closed): a bot drives the seat and the client is
   *  removed (they no longer receive broadcasts). */
  drop(clientId: string): void {
    const seat = this.seatOf(clientId);
    if (seat >= 0) this.handOverToBot(seat, true);
  }

  private handOverToBot(seat: number, disconnected: boolean): void {
    const s = this.seats[seat];
    if (!s) return;
    s.bot = true;
    if (disconnected) s.client = null;
    // if it's their turn right now, let the bot take over immediately
    if (!this.over && this.state.turn === seat) {
      this.clearClock();
      this.scheduleBot();
    }
  }

  suspend(): void {
    this.clearClock();
  }

  // ---------- internals ----------

  private broadcast(msg: ServerMsg): void {
    for (const s of this.seats) s.client?.send(msg);
  }

  private doRoll(): void {
    const seat = this.state.turn;
    this.diceIndex += 1;
    const die = rollDie4(this.fairness, this.diceIndex);
    this.broadcast({ t: 'game.dice4', value: die, index: this.diceIndex, seat });
    this.state = applyRoll4(this.state, die);
    if (this.state.phase === 'awaiting-move') {
      // legal moves exist for this seat
      if (this.seats[seat]?.bot || this.state.legal.length === 1) {
        this.clearClock();
        this.clock = setTimeout(() => {
          if (this.over) return;
          const token = this.state.legal.length === 1 ? this.state.legal[0]! : pickAutoMove4(this.state, seat, die) ?? this.state.legal[0]!;
          this.doMove(token);
        }, BOT_MOVE_MS);
      } else {
        this.armClock();
      }
    } else {
      // no legal move: applyRoll4 already passed the turn
      this.announceTurn();
    }
  }

  private doMove(token: number): void {
    const seat = this.state.turn;
    const { state, events } = applyMove4(this.state, token);
    this.state = state;
    this.broadcast({ t: 'game.moved4', seat, token, capture: events.capture, state });
    if (events.won) {
      this.finish(seat);
    } else {
      this.announceTurn(); // applyMove4 already set the next turn (extraTurn → same seat)
    }
  }

  private announceTurn(): void {
    if (this.over) return;
    const seat = this.state.turn;
    this.deadlineTs = Date.now() + BLITZ.moveClockMs;
    this.broadcast({ t: 'game.turn4', seat, deadlineTs: this.deadlineTs });
    if (this.seats[seat]?.bot) this.scheduleBot();
    else this.armClock();
  }

  /** Bot seat: roll after a beat; the move is scheduled by doRoll. */
  private scheduleBot(): void {
    this.clearClock();
    this.clock = setTimeout(() => {
      if (this.over || !this.seats[this.state.turn]?.bot) return;
      if (this.state.phase === 'awaiting-roll') this.doRoll();
    }, BOT_ROLL_MS);
  }

  private armClock(): void {
    this.clearClock();
    this.clock = setTimeout(() => this.onClockExpired(), BLITZ.moveClockMs);
  }

  private onClockExpired(): void {
    if (this.over) return;
    const seat = this.state.turn;
    this.autoStreak[seat] = (this.autoStreak[seat] ?? 0) + 1;
    if (this.autoStreak[seat]! >= BLITZ.forfeitAfterAutoMoves) {
      // give up on this human — hand the seat to a bot for the rest of the game
      const s = this.seats[seat];
      if (s) {
        s.bot = true;
        s.client = null;
      }
    }
    if (this.state.phase === 'awaiting-roll') {
      this.doRoll();
    } else if (this.state.phase === 'awaiting-move') {
      const token = pickAutoMove4(this.state, seat, this.state.dice ?? 6) ?? this.state.legal[0];
      if (token !== undefined) this.doMove(token);
    }
  }

  private finish(winnerSeat: number): void {
    this.over = true;
    this.clearClock();
    this.broadcast({
      t: 'game.over4',
      winner: winnerSeat,
      prizeTickets: this.prizeTickets,
      payoutCents: this.payoutCents,
      rakeCents: this.rakeCents,
      fairnessReveal: { serverSeed: this.fairness.serverSeed, seeds: this.fairness.seeds },
    });
    this.onResult?.({ gameId: this.gameId, winnerSeat, seats: this.seats, fairness: this.fairness });
    this.onEnd?.(this);
  }

  private clearClock(): void {
    if (this.clock) {
      clearTimeout(this.clock);
      this.clock = null;
    }
  }
}

/** Bot names/flags for filling empty 4-player seats. */
export const BOT4_NAMES: ReadonlyArray<{ name: string; flag: string }> = [
  { name: 'Ana', flag: '🇭🇷' },
  { name: 'Young', flag: '🌍' },
  { name: 'Dragan', flag: '🇷🇸' },
  { name: 'Amara', flag: '🇳🇬' },
];

// nextSeat4 is re-exported for callers that want to reason about rotation.
export { nextSeat4 };
