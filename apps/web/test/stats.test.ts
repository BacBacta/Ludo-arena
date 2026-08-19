import { describe, expect, it } from 'vitest';
import { fmtRatio, fmtVolume, statsUrl } from '../src/lib/stats';

// The Stats sheet is what MiniPay's review reads. A wrong origin means the
// numbers are simply absent at review time, and a 0% where the figure is
// unmeasurable reads as a collapse — both are pinned here.

describe('statsUrl — ws origin → http stats endpoint', () => {
  it('maps ws to http and wss to https', () => {
    expect(statsUrl('ws://localhost:8787')).toBe('http://localhost:8787/stats/daily?days=30');
    expect(statsUrl('wss://ludo-arena.fly.dev')).toBe('https://ludo-arena.fly.dev/stats/daily?days=30');
  });

  it('does not double the slash when the server URL carries a trailing one', () => {
    expect(statsUrl('wss://ludo-arena.fly.dev/')).toBe('https://ludo-arena.fly.dev/stats/daily?days=30');
  });

  it('carries the requested window', () => {
    expect(statsUrl('ws://localhost:8787', 7)).toContain('days=7');
  });

  it('leaves an already-http origin alone (dev proxies)', () => {
    expect(statsUrl('http://localhost:8787')).toBe('http://localhost:8787/stats/daily?days=30');
  });
});

describe('formatting', () => {
  it('shows cents as money, and compacts past a thousand dollars', () => {
    expect(fmtVolume(1234)).toBe('$12.34');
    expect(fmtVolume(0)).toBe('$0.00');
    expect(fmtVolume(250_000)).toBe('$2.5k');
  });

  it('renders an unmeasurable ratio as a dash, never as 0%', () => {
    expect(fmtRatio(null)).toBe('—');
    expect(fmtRatio(0)).toBe('0%');
    expect(fmtRatio(0.5)).toBe('50%');
  });
});
