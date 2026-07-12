/**
 * Per-stake waiting queue with an ELO window (E2.3).
 * A player accepts opponents within ±100 ELO, widening by +50 every 5 s of
 * waiting. Two entries pair when their ELO gap fits inside BOTH windows.
 * Pairing happens on join (best candidate) and via sweep() as windows widen.
 */
import type { StakeCents } from '@ludo/shared';

export interface QueueEntry<T> {
  session: T;
  entropy: string;
  elo: number;
  enqueuedAt: number;
  /** True when the player has a connected wallet (locks REAL funds on-chain).
   *  Staked games must be wallet-vs-wallet or demo-vs-demo — a mixed pairing
   *  makes the real staker lock funds against a simulated opponent. */
  walletBacked: boolean;
}

export const BASE_WINDOW = 100;
export const WIDEN_STEP = 50;
export const WIDEN_INTERVAL_MS = 5_000;

/** Acceptable ELO gap for an entry that has been waiting since `enqueuedAt`. */
export function eloWindow(enqueuedAt: number, now: number): number {
  const waited = Math.max(0, now - enqueuedAt);
  return BASE_WINDOW + WIDEN_STEP * Math.floor(waited / WIDEN_INTERVAL_MS);
}

export function compatible<T>(a: QueueEntry<T>, b: QueueEntry<T>, now: number, stake: StakeCents = 0): boolean {
  // A session can never be paired with itself (a double queue.join must not
  // self-match — that would run a one-player game / farm freeroll tickets).
  if (a.session === b.session) return false;
  // Money-mode parity: staked games never mix a real-wallet player with a demo
  // (simulated) player — the real stake would be locked against nothing.
  if (stake > 0 && a.walletBacked !== b.walletBacked) return false;
  const gap = Math.abs(a.elo - b.elo);
  return gap <= eloWindow(a.enqueuedAt, now) && gap <= eloWindow(b.enqueuedAt, now);
}

export class Matchmaker<T> {
  private queues = new Map<StakeCents, QueueEntry<T>[]>();

  /**
   * Pairs `entry` with the closest-ELO compatible opponent, or queues it.
   * Ties on ELO gap go to the longest-waiting opponent.
   */
  join(stake: StakeCents, entry: QueueEntry<T>, now = Date.now()): [QueueEntry<T>, QueueEntry<T>] | null {
    const q = this.queues.get(stake) ?? [];
    let best = -1;
    for (let i = 0; i < q.length; i++) {
      const candidate = q[i]!;
      if (!compatible(candidate, entry, now, stake)) continue;
      if (
        best === -1 ||
        Math.abs(candidate.elo - entry.elo) < Math.abs(q[best]!.elo - entry.elo)
      ) {
        best = i;
      }
    }
    if (best !== -1) {
      const [opponent] = q.splice(best, 1);
      this.queues.set(stake, q);
      return [opponent!, entry];
    }
    q.push(entry);
    this.queues.set(stake, q);
    return null;
  }

  /**
   * Re-checks every queue as windows widen; call periodically.
   * Oldest entries pick first (they waited the longest).
   */
  sweep(now = Date.now()): Array<{ stake: StakeCents; pair: [QueueEntry<T>, QueueEntry<T>] }> {
    const pairs: Array<{ stake: StakeCents; pair: [QueueEntry<T>, QueueEntry<T>] }> = [];
    for (const [stake, q] of this.queues) {
      const remaining = [...q].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
      let s = 0;
      while (s < remaining.length - 1) {
        const seeker = remaining[s]!;
        let best = -1;
        for (let i = s + 1; i < remaining.length; i++) {
          const candidate = remaining[i]!;
          if (!compatible(seeker, candidate, now, stake)) continue;
          if (
            best === -1 ||
            Math.abs(candidate.elo - seeker.elo) < Math.abs(remaining[best]!.elo - seeker.elo)
          ) {
            best = i;
          }
        }
        if (best !== -1) {
          const partner = remaining[best]!;
          remaining.splice(best, 1);
          remaining.splice(s, 1);
          pairs.push({ stake, pair: [seeker, partner] });
          // do not advance s: the next-oldest entry shifted into this slot
        } else {
          s += 1;
        }
      }
      this.queues.set(stake, remaining);
    }
    return pairs;
  }

  leave(stake: StakeCents, session: T): void {
    const q = this.queues.get(stake);
    if (!q) return;
    this.queues.set(
      stake,
      q.filter((e) => e.session !== session),
    );
  }

  leaveAll(session: T): void {
    for (const [stake, q] of this.queues) {
      this.queues.set(
        stake,
        q.filter((e) => e.session !== session),
      );
    }
  }

  position(stake: StakeCents, session: T): number {
    const q = this.queues.get(stake) ?? [];
    return q.findIndex((e) => e.session === session) + 1;
  }
}
