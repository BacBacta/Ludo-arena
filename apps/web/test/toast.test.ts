import { describe, expect, it } from 'vitest';
import { toastDurationMs } from '../src/lib/toast';

// The toast auto-dismissed after a flat 2400ms — too short to READ a long
// diagnostic ("Stake not locked — match cancelled — transfer amount exceeds
// balance") before it vanished ("appears and disappears, can't catch it").
// Dwell now scales with length so a long cause stays on screen long enough to
// read or screenshot, while short confirmations stay snappy.

describe('toastDurationMs', () => {
  it('keeps a short confirmation snappy (>= the old floor)', () => {
    expect(toastDurationMs('Copied')).toBeGreaterThanOrEqual(2400);
    expect(toastDurationMs('Copied')).toBeLessThanOrEqual(4000);
  });

  it('gives a long diagnostic clearly MORE time than a short toast', () => {
    const short = toastDurationMs('Saved');
    const long = toastDurationMs('Stake not locked — match cancelled — transfer amount exceeds balance');
    expect(long).toBeGreaterThan(short);
    expect(long).toBeGreaterThanOrEqual(6000); // enough to read ~65 chars
  });

  it('caps very long messages so a toast can never get stuck for minutes', () => {
    expect(toastDurationMs('x'.repeat(1000))).toBeLessThanOrEqual(12000);
  });

  it('is robust to an empty string', () => {
    expect(toastDurationMs('')).toBeGreaterThanOrEqual(2400);
  });
});
