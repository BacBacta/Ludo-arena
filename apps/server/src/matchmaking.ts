/**
 * File d'attente par mise. v1 : premier arrivé, premier servi.
 * BACKLOG E2.3 : fenêtre ELO ± 100 avec élargissement progressif.
 */
import type { StakeCents } from '@ludo/shared';

export interface QueueEntry<T> {
  session: T;
  entropy: string;
  enqueuedAt: number;
}

export class Matchmaker<T> {
  private queues = new Map<StakeCents, QueueEntry<T>[]>();

  join(stake: StakeCents, entry: QueueEntry<T>): [QueueEntry<T>, QueueEntry<T>] | null {
    const q = this.queues.get(stake) ?? [];
    const opponent = q.shift();
    if (opponent) {
      this.queues.set(stake, q);
      return [opponent, entry];
    }
    q.push(entry);
    this.queues.set(stake, q);
    return null;
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
