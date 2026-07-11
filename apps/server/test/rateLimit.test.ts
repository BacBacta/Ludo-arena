import { describe, expect, it } from 'vitest';
import { RateLimiter, type RateLimitConfig } from '../src/rateLimit.js';

const CFG: RateLimitConfig = {
  capacity: 10,
  refillPerSec: 5,
  violationsBeforeBan: 3,
  banMs: 60_000,
};

const T0 = 1_000_000;

function flood(rl: RateLimiter, conn: string, ip: string, n: number, now: number): Array<'ok' | 'drop' | 'ban'> {
  const verdicts: Array<'ok' | 'drop' | 'ban'> = [];
  for (let i = 0; i < n; i++) verdicts.push(rl.allow(conn, ip, now));
  return verdicts;
}

describe('RateLimiter (AC E2.4 abuse)', () => {
  it('allows bursts within capacity and refills over time', () => {
    const rl = new RateLimiter(CFG);
    expect(flood(rl, 'c1', 'ip1', 10, T0).every((v) => v === 'ok')).toBe(true);
    expect(rl.allow('c1', 'ip1', T0)).toBe('drop'); // bucket empty
    // 1 s later: 5 tokens refilled
    const later = flood(rl, 'c1', 'ip1', 6, T0 + 1_000);
    expect(later.filter((v) => v === 'ok')).toHaveLength(5);
  });

  it('counts one violation per drained period, then bans', () => {
    const rl = new RateLimiter(CFG);
    // period 1: drain + violate
    flood(rl, 'c1', 'ip1', 11, T0);
    expect(rl.isBanned('ip1', T0)).toBe(false);
    // extra flooding in the same period does not stack violations
    flood(rl, 'c1', 'ip1', 50, T0);
    expect(rl.isBanned('ip1', T0)).toBe(false);
    // period 2 (recovered then drained again)
    flood(rl, 'c1', 'ip1', 20, T0 + 1_000);
    expect(rl.isBanned('ip1', T0 + 1_000)).toBe(false);
    // period 3: third violation crosses the threshold
    const verdicts = flood(rl, 'c1', 'ip1', 20, T0 + 2_000);
    expect(verdicts).toContain('ban');
    expect(rl.isBanned('ip1', T0 + 2_000)).toBe(true);
  });

  it('banned IPs are dropped even on a fresh connection', () => {
    const rl = new RateLimiter(CFG);
    flood(rl, 'c1', 'ip1', 25, T0);
    flood(rl, 'c1', 'ip1', 20, T0 + 1_000);
    flood(rl, 'c1', 'ip1', 20, T0 + 2_000);
    expect(rl.isBanned('ip1', T0 + 2_000)).toBe(true);
    // cycling to a new socket does not evade the ban
    expect(rl.allow('c2', 'ip1', T0 + 2_001)).toBe('drop');
  });

  it('bans expire', () => {
    const rl = new RateLimiter(CFG);
    for (const dt of [0, 1_000, 2_000]) flood(rl, 'c1', 'ip1', 20, T0 + dt);
    expect(rl.isBanned('ip1', T0 + CFG.banMs + 2_000)).toBe(false);
    expect(rl.allow('c2', 'ip1', T0 + CFG.banMs + 2_001)).toBe('ok');
  });

  it('connections behind the same IP have independent buckets', () => {
    const rl = new RateLimiter(CFG);
    flood(rl, 'c1', 'ip1', 15, T0); // c1 drained
    expect(rl.allow('c2', 'ip1', T0)).toBe('ok'); // c2 untouched
  });

  it('violations accumulate per IP across connections', () => {
    const rl = new RateLimiter(CFG);
    flood(rl, 'c1', 'ip1', 20, T0);
    rl.release('c1'); // abuser reconnects with a fresh socket each time
    flood(rl, 'c2', 'ip1', 20, T0 + 1_000);
    rl.release('c2');
    const verdicts = flood(rl, 'c3', 'ip1', 20, T0 + 2_000);
    expect(verdicts).toContain('ban');
  });

  it('release forgets the bucket, prune forgets idle state', () => {
    const rl = new RateLimiter(CFG);
    flood(rl, 'c1', 'ip1', 15, T0);
    rl.release('c1');
    expect(rl.allow('c1', 'ip1', T0)).toBe('ok'); // fresh bucket
    rl.prune(1_000, T0 + 10_000);
    expect(rl.allow('c1', 'ip1', T0 + 10_000)).toBe('ok');
  });
});
