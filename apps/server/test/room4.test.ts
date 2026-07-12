import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room4, type Room4Result, type Seat4 } from '../src/room4.js';
import { createFairness4 } from '../src/fairness.js';

function botSeats(): Seat4[] {
  return [0, 1, 2, 3].map((i) => ({ client: null, bot: true, name: `Bot${i}`, flag: '🤖' }));
}

describe('Room4 (4-player online)', () => {
  afterEach(() => vi.useRealTimers());

  it('runs an all-bot game to a winner and reports the result', () => {
    vi.useFakeTimers();
    const room = new Room4('g4', botSeats(), createFairness4(['a', 'b', 'c', 'd']), 1, 3);
    let result: Room4Result | undefined;
    room.onResult = (r) => {
      result = r;
    };
    room.start();
    vi.runAllTimers(); // drive every scheduled bot roll/move until the game ends
    expect(room.isOver()).toBe(true);
    expect(result).toBeDefined();
    expect(result!.winnerSeat).toBeGreaterThanOrEqual(0);
    expect(result!.winnerSeat).toBeLessThan(4);
    // the winner really finished all four tokens
    expect(room.getState().positions[result!.winnerSeat]!.every((p) => p === 56)).toBe(true);
  });

  it('a resigner stays connected and still sees the game finish (game.over4)', () => {
    vi.useFakeTimers();
    const sent: Array<{ t: string }> = [];
    const human = { id: 'h1', name: 'Me', flag: '🌍', send: (m: { t: string }) => sent.push(m) };
    const seats: Seat4[] = [
      { client: human, bot: false, name: 'Me', flag: '🌍' },
      { client: null, bot: true, name: 'B1', flag: '🤖' },
      { client: null, bot: true, name: 'B2', flag: '🤖' },
      { client: null, bot: true, name: 'B3', flag: '🤖' },
    ];
    const room = new Room4('g5', seats, createFairness4(['w', 'x', 'y', 'z']), 1, 3);
    let done = false;
    room.onResult = () => {
      done = true;
    };
    room.start();
    room.resign(0); // gives up control but stays connected → a bot plays the seat
    vi.runAllTimers();
    expect(room.isOver()).toBe(true);
    expect(done).toBe(true);
    // resigner keeps their client, so they receive the game-over broadcast
    expect(sent.some((m) => m.t === 'game.over4')).toBe(true);
  });

  it('finishes even after the one human disconnects (drop → bot seat)', () => {
    vi.useFakeTimers();
    const human = { id: 'h1', name: 'Me', flag: '🌍', send: () => {} };
    const seats: Seat4[] = [
      { client: human, bot: false, name: 'Me', flag: '🌍' },
      { client: null, bot: true, name: 'B1', flag: '🤖' },
      { client: null, bot: true, name: 'B2', flag: '🤖' },
      { client: null, bot: true, name: 'B3', flag: '🤖' },
    ];
    const room = new Room4('g6', seats, createFairness4(['w', 'x', 'y', 'z']), 1, 3);
    let done = false;
    room.onResult = () => {
      done = true;
    };
    room.start();
    room.drop('h1');
    vi.runAllTimers();
    expect(room.isOver()).toBe(true);
    expect(done).toBe(true);
  });
});
