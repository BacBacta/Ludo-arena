import { describe, expect, it } from 'vitest';
import { describeTxError } from '../src/lib/txError';

// The "Stake not locked — match cancelled" toast hid WHY the lock failed (the
// cause only went to a console that page auto-reloads keep wiping). Same lesson
// as the race-claim path: surface the short viem cause in the toast itself so a
// failure report carries its own diagnosis.

describe('describeTxError (toast-sized failure cause)', () => {
  it('prefers viem shortMessage — it names the exact revert/RPC cause', () => {
    const e = Object.assign(new Error('long dump\nRequest Arguments: …'), { shortMessage: 'transfer amount exceeds balance' });
    expect(describeTxError(e)).toBe('transfer amount exceeds balance');
  });
  it('falls back to Error.message', () => {
    expect(describeTxError(new Error('boom'))).toBe('boom');
  });
  it('stringifies non-Error throws', () => {
    expect(describeTxError('raw string')).toBe('raw string');
  });
  it('truncates to stay toast-sized', () => {
    expect(describeTxError(new Error('x'.repeat(500))).length).toBeLessThanOrEqual(120);
  });
});
