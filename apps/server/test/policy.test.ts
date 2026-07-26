import { describe, expect, it, vi } from 'vitest';
import { envBool, envInt, racePolicy, relaxationWarnings, RACE_POLICY_DEFAULTS, type Env } from '../src/policy.js';

// THE HAZARD THIS MODULE EXISTS TO REMOVE. The previous idiom was
// `Number(process.env.X ?? '3')`. A typo in a Fly secret therefore produced NaN
// — and every guard downstream is a `>=` comparison, where NaN is FALSE. A
// mistyped secret could silently switch an anti-farm protection OFF on a
// real-money event, with nothing in the logs to say so.

const quiet = (): void => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
};

describe('envInt — a bad value must never disable a guard', () => {
  it('reads a valid integer', () => {
    expect(envInt({ X: '42' }, 'X', 7)).toBe(42);
  });

  it('falls back when absent or blank', () => {
    expect(envInt({}, 'X', 7)).toBe(7);
    expect(envInt({ X: '' }, 'X', 7)).toBe(7);
    expect(envInt({ X: '   ' }, 'X', 7)).toBe(7);
  });

  it('falls back on GARBAGE instead of yielding NaN (the whole point)', () => {
    quiet();
    expect(envInt({ X: 'abc' }, 'X', 7)).toBe(7);
    expect(envInt({ X: 'ten' }, 'X', 7)).toBe(7);
    // The old idiom is what we must not reproduce: `Number(env.X ?? '7')` keeps
    // the fallback only for a MISSING value — a present-but-garbled one becomes
    // NaN, and `NaN >= n` is false, so the guard downstream stops firing.
    expect(Number.isNaN(Number('abc'))).toBe(true);
  });

  it('rejects the infinities — an unbounded window is not a setting', () => {
    quiet();
    expect(envInt({ X: 'Infinity' }, 'X', 7)).toBe(7);
    expect(envInt({ X: '-Infinity' }, 'X', 7)).toBe(7);
  });

  it('floors at `min` so a hostile 0 or negative cannot open a guard', () => {
    expect(envInt({ X: '0' }, 'X', 7, 1)).toBe(1);
    expect(envInt({ X: '-5' }, 'X', 7, 1)).toBe(1);
    expect(envInt({ X: '-5' }, 'X', 7, 0)).toBe(0);
  });

  it('truncates a fractional value rather than carrying it into a comparison', () => {
    expect(envInt({ X: '2.9' }, 'X', 7)).toBe(2);
  });

  it('warns on a rejected value — a silent fallback is how this stays unnoticed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    envInt({ X: 'abc' }, 'X', 7);
    expect(warn).toHaveBeenCalled();
  });
});

describe('envBool — only explicit words flip a protection', () => {
  it('accepts the usual truthy spellings', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'on', ' On ']) expect(envBool({ X: v }, 'X', false)).toBe(true);
  });

  it('accepts the usual falsy spellings', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'off', ' Off ']) expect(envBool({ X: v }, 'X', true)).toBe(false);
  });

  it('KEEPS the default on anything else — a stray value must not disarm a gate', () => {
    quiet();
    for (const v of ['maybe', 'oui', '2', 'null']) expect(envBool({ X: v }, 'X', true)).toBe(true);
  });

  it('falls back when absent or blank', () => {
    expect(envBool({}, 'X', true)).toBe(true);
    expect(envBool({ X: '  ' }, 'X', false)).toBe(false);
  });
});

describe('racePolicy — defaults are the shipped behaviour', () => {
  it('an empty environment reproduces the defaults exactly', () => {
    expect(racePolicy({})).toEqual(RACE_POLICY_DEFAULTS);
  });

  it('each knob is independently overridable', () => {
    const env: Env = {
      RACE_ACTION_WINDOW_MS: '5000',
      RACE_BOT_FALLBACK_MS: '20000',
      RACE_BOT_HARD_FALLBACK_MS: '120000',
      RACE_COLLUSION_PAIR_CAP: '5',
      RACE_COLLUSION_SAME_IP_PAIR_CAP: '4',
      RACE_MAX_DAILY_VS_SAME: '10',
      STAKE_BLOCK_SAME_DEVICE: 'false',
      STAKE_BLOCK_SAME_NETWORK: 'false',
    };
    expect(racePolicy(env)).toEqual({
      actionWindowMs: 5000,
      botFallbackMs: 20000,
      botHardFallbackMs: 120000,
      collusionPairCap: 5,
      collusionSameIpPairCap: 4,
      maxDailyVsSame: 10,
      blockSameDevice: false,
      blockSameNetwork: false,
    });
  });

  it('a garbled environment yields the DEFAULTS, not a disabled policy', () => {
    quiet();
    const env: Env = {
      RACE_COLLUSION_PAIR_CAP: 'lots',
      RACE_MAX_DAILY_VS_SAME: 'nope',
      STAKE_BLOCK_SAME_DEVICE: 'perhaps',
    };
    expect(racePolicy(env)).toEqual(RACE_POLICY_DEFAULTS);
  });

  it('maxDailyVsSame can never be 0 — that would refuse EVERY rematch', () => {
    expect(racePolicy({ RACE_MAX_DAILY_VS_SAME: '0' }).maxDailyVsSame).toBe(1);
  });

  it('the caller supplies the defaults, so a shared constant stays the authority', () => {
    const mine = { ...RACE_POLICY_DEFAULTS, maxDailyVsSame: 9 };
    expect(racePolicy({}, mine).maxDailyVsSame).toBe(9);
  });
});

describe('relaxationWarnings — a loosened guard is visible in the logs', () => {
  it('says nothing when everything is at its default', () => {
    expect(relaxationWarnings(RACE_POLICY_DEFAULTS)).toEqual([]);
  });

  it('names each disabled device/network gate', () => {
    const p = { ...RACE_POLICY_DEFAULTS, blockSameDevice: false, blockSameNetwork: false };
    const out = relaxationWarnings(p);
    expect(out).toHaveLength(2);
    expect(out.join(' ')).toContain('STAKE_BLOCK_SAME_DEVICE');
    expect(out.join(' ')).toContain('STAKE_BLOCK_SAME_NETWORK');
  });

  it('flags a disabled collusion intercept and a widened opponent cap', () => {
    const p = { ...RACE_POLICY_DEFAULTS, collusionPairCap: 0, maxDailyVsSame: 20 };
    const out = relaxationWarnings(p).join(' ');
    expect(out).toContain('RACE_COLLUSION_PAIR_CAP=0');
    expect(out).toContain('RACE_MAX_DAILY_VS_SAME=20');
  });

  it('does NOT flag a TIGHTENED setting — only relaxations matter here', () => {
    const p = { ...RACE_POLICY_DEFAULTS, maxDailyVsSame: 1, collusionPairCap: 1 };
    expect(relaxationWarnings(p)).toEqual([]);
  });
});
