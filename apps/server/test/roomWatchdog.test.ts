import { describe, expect, it } from 'vitest';
import { Room } from '../src/room.js';
import { createFairness } from '../src/fairness.js';

// Regression — the mid-game FREEZE ("Rudo is playing…" forever, dice dead,
// resign unreachable). If an exception escapes inside a room's timer callback
// the room is left with NO clock: no auto-play, no forfeit, both players
// trapped. The watchdog declares a long-overdue turn deadline a LOST CLOCK and
// forces the expiry, so the game self-heals into auto-play — and a permanently
// stuck seat still terminates through the normal 3-miss forfeit.

type Sent = Array<{ t: string }>;
function client(id: string, sent: Sent) {
  return { id, wallet: undefined, name: id, flag: '🌍', elo: 1200, send: (m: { t: string }) => sent.push(m) } as never;
}

function stuckRoom() {
  const sentA: Sent = [];
  const sentB: Sent = [];
  const room = new Room('gwd', 0, client('A', sentA), client('B', sentB), createFairness('aa', 'bb'));
  room.start();
  // Simulate the lost clock: whatever timer should advance the game is gone.
  (room as unknown as { clearClock(): void }).clearClock();
  const deadline = (room as unknown as { deadlineTs: number }).deadlineTs;
  return { room, sentA, sentB, deadline };
}

describe('Room.watchdog (lost-clock self-healing)', () => {
  it('leaves a HEALTHY room alone (deadline not yet overdue)', () => {
    const { room, deadline } = stuckRoom();
    expect(room.watchdog(deadline - 1)).toBe(false); // still inside the turn window
    expect(room.watchdog(deadline + 5_000)).toBe(false); // overdue but within grace
  });

  it('force-expires a room whose deadline is long past — the game moves again', () => {
    const { room, sentA, deadline } = stuckRoom();
    const recovered = room.watchdog(deadline + 60_000);
    expect(recovered).toBe(true);
    expect(room.isOver()).toBe(false); // one miss ≠ forfeit — the game continues
    // The forced expiry auto-played: the stalled player saw the die move again
    // and the auto-play counter, not a frozen board.
    expect(sentA.some((m) => m.t === 'game.dice' || m.t === 'game.moved')).toBe(true);
    expect(sentA.some((m) => m.t === 'game.auto')).toBe(true);
  });

  it('a PERMANENTLY stuck seat still terminates: repeated recoveries reach the 3-miss forfeit', () => {
    const { room } = stuckRoom();
    for (let i = 0; i < 10 && !room.isOver(); i++) {
      // Re-lose the clock after each recovery and jump past the fresh deadline.
      (room as unknown as { clearClock(): void }).clearClock();
      const d = (room as unknown as { deadlineTs: number }).deadlineTs;
      room.watchdog(d + 60_000);
    }
    expect(room.isOver()).toBe(true); // timeout-forfeit — never an eternal freeze
  });

  it('is a no-op on a finished room', () => {
    const { room } = stuckRoom();
    room.resign(0);
    expect(room.isOver()).toBe(true);
    expect(room.watchdog(Date.now() + 10_000_000)).toBe(false);
  });
});
