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

  // R-WEB-1: a dropped human on a STAKED table must keep their seat during a grace
  // window (their turns auto-play) so a reconnect can resume before the stake is lost.
  function humanSeats(send: (m: { t: string }) => void = () => {}): Seat4[] {
    const human = { id: 'h1', name: 'Me', flag: '🌍', send };
    return [
      { client: human, bot: false, name: 'Me', flag: '🌍' },
      { client: null, bot: true, name: 'B1', flag: '🤖' },
      { client: null, bot: true, name: 'B2', flag: '🤖' },
      { client: null, bot: true, name: 'B3', flag: '🤖' },
    ];
  }

  it('staked table: a dropped human KEEPS their seat (grace), not an instant bot-forfeit', () => {
    vi.useFakeTimers();
    // payoutCents > 0 → staked table.
    const room = new Room4('gs1', humanSeats(), createFairness4(['w', 'x', 'y', 'z']), 0, 0, 200, 20);
    room.start();
    room.drop('h1');
    expect(room.players()[0]!.bot).toBe(false); // seat still human → reconnect can resume
    room.suspend();
  });

  it('free table: a dropped human forfeits to a bot immediately (no money at stake)', () => {
    vi.useFakeTimers();
    const room = new Room4('gf1', humanSeats(), createFairness4(['w', 'x', 'y', 'z']), 1, 3); // payoutCents 0 → free
    room.start();
    room.drop('h1');
    expect(room.players()[0]!.bot).toBe(true); // forfeited at once
    room.suspend();
  });

  it('staked table: reconnect (attach) rebinds the seat and resyncs state + turn', () => {
    vi.useFakeTimers();
    const room = new Room4('gs2', humanSeats(), createFairness4(['w', 'x', 'y', 'z']), 0, 0, 200, 20);
    room.start();
    room.drop('h1');
    const sent: Array<{ t: string }> = [];
    const rejoined = { id: 'h1', name: 'Me', flag: '🌍', send: (m: { t: string }) => sent.push(m) };
    const ok = room.attach(0, rejoined);
    expect(ok).toBe(true);
    expect(sent.some((m) => m.t === 'game.state4')).toBe(true); // full state resync
    expect(sent.some((m) => m.t === 'game.turn4')).toBe(true); // whose turn + deadline
    room.suspend();
  });
});
