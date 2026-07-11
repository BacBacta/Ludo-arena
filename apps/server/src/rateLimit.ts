/**
 * Rate limiting with temporary bans (E2.4).
 * Token bucket PER CONNECTION (players behind carrier NAT share an IP and
 * must not throttle each other), violations and bans PER IP (an abuser
 * cycling sockets still accumulates violations on their IP).
 * Frame size is enforced separately (ws maxPayload 1 KB + parseClientMsg).
 */

export interface RateLimitConfig {
  capacity: number;
  refillPerSec: number;
  violationsBeforeBan: number;
  banMs: number;
}

/** Generous for real players and fast bots; spam floods drain it in <1 s. */
export const DEFAULT_LIMITS: RateLimitConfig = {
  capacity: 100,
  refillPerSec: 30,
  violationsBeforeBan: 3,
  banMs: 5 * 60_000,
};

interface Bucket {
  tokens: number;
  lastRefill: number;
  inViolation: boolean;
  lastSeen: number;
}

interface Penalty {
  violations: number;
  bannedUntil: number;
  lastSeen: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private penalties = new Map<string, Penalty>();

  constructor(private readonly cfg: RateLimitConfig = DEFAULT_LIMITS) {}

  isBanned(ip: string, now = Date.now()): boolean {
    const p = this.penalties.get(ip);
    return p !== undefined && p.bannedUntil > now;
  }

  /**
   * Consumes one token from the connection's bucket. Returns 'ok', 'drop'
   * (over rate or banned: discard the message) or 'ban' (this call crossed
   * the ban threshold: close the connection).
   */
  allow(connKey: string, ip: string, now = Date.now()): 'ok' | 'drop' | 'ban' {
    if (this.isBanned(ip, now)) return 'drop';
    const b = this.bucket(connKey, now);
    b.lastSeen = now;

    const elapsed = (now - b.lastRefill) / 1000;
    b.tokens = Math.min(this.cfg.capacity, b.tokens + elapsed * this.cfg.refillPerSec);
    b.lastRefill = now;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      b.inViolation = false;
      return 'ok';
    }
    // one violation per drained period, not per flooded message
    if (!b.inViolation) {
      b.inViolation = true;
      const p = this.penalty(ip, now);
      p.violations += 1;
      p.lastSeen = now;
      if (p.violations >= this.cfg.violationsBeforeBan) {
        p.bannedUntil = now + this.cfg.banMs;
        p.violations = 0;
        return 'ban';
      }
    }
    return 'drop';
  }

  /** Forget a closed connection's bucket immediately. */
  release(connKey: string): void {
    this.buckets.delete(connKey);
  }

  /** Drop idle buckets and expired penalties (call periodically). */
  prune(idleMs = 30 * 60_000, now = Date.now()): void {
    for (const [key, b] of this.buckets) {
      if (now - b.lastSeen > idleMs) this.buckets.delete(key);
    }
    for (const [ip, p] of this.penalties) {
      if (p.bannedUntil <= now && now - p.lastSeen > idleMs) this.penalties.delete(ip);
    }
  }

  private bucket(key: string, now: number): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.cfg.capacity, lastRefill: now, inViolation: false, lastSeen: now };
      this.buckets.set(key, b);
    }
    return b;
  }

  private penalty(ip: string, now: number): Penalty {
    let p = this.penalties.get(ip);
    if (!p) {
      p = { violations: 0, bannedUntil: 0, lastSeen: now };
      this.penalties.set(ip, p);
    }
    return p;
  }
}
