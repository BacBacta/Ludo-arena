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
import type { Room4Snapshot } from './store/index.js';

export interface Client4 {
  send(msg: ServerMsg): void;
  id: string;
  name: string;
  flag: string;
  frame?: string;
  avatar?: string;
  tokenSkin?: string;
  entranceFx?: string;
  victoryFx?: string;
}

export interface Seat4 {
  client: Client4 | null; // null = bot seat OR a detached human (staked grace window)
  bot: boolean; // true once a bot drives this seat (empty seat, resign, or drop)
  name: string;
  flag: string;
  /** Owning session id — kept even when `client` is nulled (drop/restore) so the
   *  seat can be snapshotted and reattached after a restart (G-5). Absent for bots. */
  sessionId?: string;
  /** Depositor wallet for a staked seat (settlement reconcile after a restart);
   *  absent for free tables and bots. */
  wallet?: string;
  /** Opaque public id (profile.get); absent for bots. */
  pid?: string;
  /** Equipped avatar frame (cosmetic); absent for bots. */
  frame?: string;
  /** Chosen profile avatar id; absent for bots. */
  avatar?: string;
  /** Equipped cosmetics relayed to every seat (4p extension); absent for bots. */
  tokenSkin?: string;
  entranceFx?: string;
  victoryFx?: string;
}

export interface Room4Result {
  gameId: string;
  winnerSeat: number;
  seats: Seat4[];
  fairness: Fairness4;
}

// Bot pacing ("thinking" before rolling / committing). Env-tunable so a sim /
// load test can accelerate (BOT_ROLL_MS=0 BOT_MOVE_MS=0); prod keeps the beat.
const BOT_ROLL_MS = Number(process.env.BOT_ROLL_MS ?? 700); // bot "thinking" before it rolls
const BOT_MOVE_MS = Number(process.env.BOT_MOVE_MS ?? 900); // then before it commits its move (die settles first)

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
  private lastGiftAt: number[] = [0, 0, 0, 0]; // per-seat gift throttle
  private deadlineTs = 0;
  private over = false;
  onResult?: (r: Room4Result) => void;
  onEnd?: (room: Room4) => void;
  /** Fired on every state transition so the store can snapshot the room (G-5).
   *  Staked 4p carries real money, so — like the 1v1 Room — it must survive a
   *  restart or an in-flight table strands 4 deposits with no record to settle. */
  onChange?: (room: Room4) => void;

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
    return this.seats.map((s) => ({ name: s.name, flag: s.flag, bot: s.bot, pid: s.pid, frame: s.frame, avatar: s.avatar, tokenSkin: s.tokenSkin, entranceFx: s.entranceFx, victoryFx: s.victoryFx }));
  }

  /** Serialize for the store (G-5). Seats persist their identity (not the live
   *  client) so the game restores and reattaches after a restart. */
  toSnapshot(): Room4Snapshot {
    return {
      gameId: this.gameId,
      state: this.state,
      diceIndex: this.diceIndex,
      autoStreak: [...this.autoStreak],
      fairness: { serverSeed: this.fairness.serverSeed, commit: this.fairness.commit, seeds: [...this.fairness.seeds] },
      seats: this.seats.map((s) => ({
        sessionId: s.sessionId ?? '',
        wallet: s.wallet,
        name: s.name,
        flag: s.flag,
        bot: s.bot,
        pid: s.pid,
        frame: s.frame,
        avatar: s.avatar,
        tokenSkin: s.tokenSkin,
        entranceFx: s.entranceFx,
        victoryFx: s.victoryFx,
      })),
      entryTickets: this.entryTickets,
      prizeTickets: this.prizeTickets,
      payoutCents: this.payoutCents,
      rakeCents: this.rakeCents,
      over: this.over,
    };
  }

  /** Rebuild a room from a store snapshot (server restart). Seats come back
   *  detached (client: null) — reattached when their session reconnects. A bot
   *  seat stays a bot; a human seat auto-plays on the clock until it reattaches. */
  static fromSnapshot(snap: Room4Snapshot): Room4 {
    const seats: Seat4[] = snap.seats.map((s) => ({
      client: null,
      bot: s.bot,
      name: s.name,
      flag: s.flag,
      sessionId: s.sessionId || undefined,
      wallet: s.wallet,
      pid: s.pid,
      frame: s.frame,
      avatar: s.avatar,
      tokenSkin: s.tokenSkin,
      entranceFx: s.entranceFx,
      victoryFx: s.victoryFx,
    }));
    const room = new Room4(
      snap.gameId,
      seats,
      { serverSeed: snap.fairness.serverSeed, commit: snap.fairness.commit, seeds: [...snap.fairness.seeds] },
      snap.entryTickets,
      snap.prizeTickets,
      snap.payoutCents,
      snap.rakeCents,
    );
    room.state = snap.state;
    room.diceIndex = snap.diceIndex;
    room.autoStreak = [...snap.autoStreak];
    room.over = snap.over ?? false; // never resurrect a finished game as live
    return room;
  }

  /** Restart the clock after a restore so the game continues (bots roll, humans
   *  auto-play on timeout until they reattach). No-op for a finished game. */
  resume(): void {
    if (this.over) return;
    this.announceTurn();
  }

  seatOf(clientId: string): number {
    return this.seats.findIndex((s) => s.client?.id === clientId);
  }

  /** The owning session id of each non-bot seat (for cleanup after the game). */
  seatSessions(): string[] {
    return this.seats.map((s) => s.sessionId).filter((id): id is string => !!id);
  }

  /** The seat a session owns (by persisted sessionId), or -1. Used to reattach a
   *  reconnecting player to a room restored from a snapshot (its client is null). */
  seatOfSession(sessionId: string): number {
    return this.seats.findIndex((s) => s.sessionId === sessionId);
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
    this.onChange?.(this);
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

  /** Directed gift to a chosen opponent seat (0-3, not self). */
  gift(from: number, to: number, id: string): void {
    if (this.over || from < 0 || from > 3 || this.seats[from]?.bot) return;
    if (to < 0 || to > 3 || to === from) return;
    const now = Date.now();
    if (now - (this.lastGiftAt[from] ?? 0) < 1500) return;
    this.lastGiftAt[from] = now;
    this.broadcast({ t: 'game.gift', from, to, id });
  }

  /** Is this a real-money table? Staked seats get a reconnect grace window; free
   *  seats forfeit to a bot on drop (no funds at risk). */
  private staked(): boolean {
    return this.payoutCents > 0;
  }

  /** A human dropped (socket closed). Free table: hand the seat to a bot at once
   *  (no money at stake). Staked table (R-WEB-1): DETACH the client but KEEP the
   *  seat human — their turns auto-play on the clock, and only the existing
   *  autoStreak forfeit hands it to a bot after repeated no-shows. That leaves a
   *  grace window for a reconnect (attach) to resume before the stake is lost. */
  drop(clientId: string): void {
    const seat = this.seatOf(clientId);
    if (seat < 0) return;
    const s = this.seats[seat];
    if (this.staked() && s && !s.bot) {
      s.client = null; // detach only; seat stays human → clock auto-plays its turns
      return;
    }
    this.handOverToBot(seat, true);
  }

  /** Reconnect (R-WEB-1): rebind a live client to `seat` and resync it. Only while
   *  the seat is still the human's (not yet bot-forfeited) does it forgive the
   *  no-show streak; a seat already handed to a bot can still re-attach to WATCH
   *  the game finish. Returns false if the game is already over (nothing to resume). */
  attach(seat: number, client: Client4): boolean {
    const s = this.seats[seat];
    if (!s || this.over) return false;
    s.client = client;
    if (!s.bot) this.autoStreak[seat] = 0; // still their seat → reset the no-show streak
    client.send({ t: 'game.state4', state: this.state });
    client.send({ t: 'game.turn4', seat: this.state.turn, deadlineTs: this.deadlineTs });
    return true;
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
    this.onChange?.(this); // persist the seat → bot change
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
        // Human with MULTIPLE choices: ship the post-roll state (awaiting-move +
        // legal list) or the client stays on a stale awaiting-roll and the roller
        // freezes until the clock auto-plays. Same fix as the 1v1 room.
        this.broadcast({ t: 'game.state4', state: this.state });
        this.armClock();
      }
    } else {
      // no legal move: applyRoll4 already passed the turn
      this.announceTurn();
    }
    this.onChange?.(this); // persist the post-roll state (diceIndex advanced)
  }

  private doMove(token: number): void {
    const seat = this.state.turn;
    const { state, events } = applyMove4(this.state, token);
    this.state = state;
    this.broadcast({ t: 'game.moved4', seat, token, capture: events.capture, state });
    if (events.won) {
      // Persist the TERMINAL state (over=true) BEFORE onResult's async settle, so a
      // crash in that window still leaves a snapshot the boot reconcile can settle.
      this.over = true;
      this.onChange?.(this);
      this.finish(seat);
    } else {
      this.announceTurn(); // applyMove4 already set the next turn (extraTurn → same seat)
      this.onChange?.(this);
    }
  }

  private announceTurn(): void {
    if (this.over) return;
    const seat = this.state.turn;
    this.deadlineTs = Date.now() + BLITZ.moveClockMs;
    // Send the authoritative state with the turn: a no-legal-move roll passes the
    // turn without a game.moved4, so clients would otherwise keep a stale turn and
    // hide the next player's roll control (game stalls). Same fix as the 1v1 room.
    this.broadcast({ t: 'game.state4', state: this.state });
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
/** Bots show the neutral globe like every other unclaimed identity. Giving them
 *  fixed country flags while human guests show 🌍 would mark out exactly which
 *  seats are bots. A flag only ever means "this player chose it in their
 *  profile". */
export const BOT4_NAMES: ReadonlyArray<{ name: string; flag: string }> = [
  { name: 'Ana', flag: '🌍' },
  { name: 'Young', flag: '🌍' },
  { name: 'Dragan', flag: '🌍' },
  { name: 'Amara', flag: '🌍' },
];

// nextSeat4 is re-exported for callers that want to reason about rotation.
export { nextSeat4 };
