import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickAutoMove } from '@ludo/game-engine';
import type { GameState, Seat } from '@ludo/game-engine';
import { Room } from '../src/room.js';
import { createFairness } from '../src/fairness.js';

// The Room DRIVES a house-bot seat itself (roll + pickAutoMove) instead of
// waiting on a human client. These tests prove: (1) on the bot's turn it acts
// on its own after the think delay — a real die roll for its seat — and (2) a
// full game against a scripted human REACHES a terminal state without freezing
// and without the bot double-playing (which would corrupt the engine).

type Sent = Array<{ t: string; seat?: number }>;
function client(id: string, sent: Sent, bot = false) {
  return { id, wallet: undefined, name: id, flag: '🌍', elo: 1200, isHouseBot: bot, send: (m: { t: string; seat?: number }) => sent.push(m) } as never;
}

// Drive the HUMAN seat (0) one step, mirroring what the Room does for the bot:
// roll, then pick only on a genuine multi-choice (a single legal move is
// auto-settled by the Room). Returns nothing; advances Room state.
function humanStep(room: Room, sent: Sent): void {
  const st = room.getState() as GameState;
  if (st.turn !== 0) return;
  if (st.phase === 'awaiting-roll') room.roll(0);
  const s2 = room.getState() as GameState;
  if (!room.isOver() && s2.turn === 0 && s2.phase === 'awaiting-move' && s2.legal.length > 1) {
    const die = s2.dice ?? 1;
    room.move(0, pickAutoMove(s2, 0, die) ?? s2.legal[0]!);
  }
}

describe('Room house-bot seat driver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('acts on its own turn: rolls a die for the bot seat after the think delay', () => {
    const sentA: Sent = [];
    const sentB: Sent = [];
    // Seat 1 is the bot. Seat 0 (human) plays first (newGame turn = 0); pass the
    // turn to the bot by having the human roll+move until it's the bot's turn.
    const room = new Room('gb1', 0, client('H', sentA), client('B', sentB, true), createFairness('seed-a', 'seed-b'));
    room.start();
    let guard = 0;
    while (room.getState().turn === 0 && !room.isOver() && guard++ < 50) {
      humanStep(room, sentA);
      vi.advanceTimersByTime(1000); // flush any single-move settle timer
    }
    expect(room.isOver()).toBe(false);
    expect(room.getState().turn).toBe(1); // it's the bot's turn now
    const before = sentA.filter((m) => m.t === 'game.dice' && m.seat === 1).length;
    // The bot has NOT rolled yet (still within its think delay).
    vi.advanceTimersByTime(50);
    expect(sentA.filter((m) => m.t === 'game.dice' && m.seat === 1).length).toBe(before);
    // After the think beat it rolls its own die, unprompted.
    vi.advanceTimersByTime(1500);
    expect(sentA.filter((m) => m.t === 'game.dice' && m.seat === 1).length).toBeGreaterThan(before);
  });

  it('plays a FULL game vs a scripted human to a terminal state — no freeze, no double-play', () => {
    const sentA: Sent = [];
    const sentB: Sent = [];
    const room = new Room('gb2', 0, client('H', sentA), client('B', sentB, true), createFairness('alpha', 'omega'));
    let result: { winner: Seat } | null = null;
    (room as unknown as { onResult?: (r: { winner: Seat }) => void }).onResult = (r) => { result = r; };
    room.start();

    // Alternate: drive the human on its turns, and let the bot's timers fire on
    // the bot's turns. A generous guard bounds the loop — a freeze would exhaust
    // it with the game NOT over (the assertion below would then fail loudly).
    let guard = 0;
    while (!room.isOver() && guard++ < 4000) {
      if (room.getState().turn === 0) humanStep(room, sentA);
      vi.advanceTimersByTime(1000); // fire bot think + any settle timers
    }

    expect(room.isOver()).toBe(true);
    expect(result).not.toBeNull();
    // The bot genuinely participated: it rolled dice for its own seat.
    expect(sentA.some((m) => m.t === 'game.dice' && m.seat === 1)).toBe(true);
    // The human's screen (sentA) saw the bot move too.
    expect(sentA.some((m) => m.t === 'game.moved' && m.seat === 1)).toBe(true);
  });
});
