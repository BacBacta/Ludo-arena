import { describe, expect, it } from 'vitest';
import { miniPayOriginTrusted } from '../src/originTrust.js';

// R-AUTH-1 defence-in-depth: a MiniPay auto-prove is only trusted from an allowed
// WS Origin once an allowlist is configured. Browsers forbid JS from setting
// Origin, so this closes the malicious-website vector.

const ALLOW = new Set(['https://minipay.opera.com', 'https://ludo.example']);

describe('miniPayOriginTrusted', () => {
  it('allows any origin when no allowlist is configured (dev/testnet)', () => {
    expect(miniPayOriginTrusted('https://evil.example', new Set())).toBe(true);
    expect(miniPayOriginTrusted(undefined, new Set())).toBe(true);
  });

  it('trusts an origin on the allowlist', () => {
    expect(miniPayOriginTrusted('https://minipay.opera.com', ALLOW)).toBe(true);
    expect(miniPayOriginTrusted('https://ludo.example', ALLOW)).toBe(true);
  });

  it('rejects an origin NOT on the allowlist (the malicious-website vector)', () => {
    expect(miniPayOriginTrusted('https://evil.example', ALLOW)).toBe(false);
  });

  it('rejects a missing origin when an allowlist is configured', () => {
    expect(miniPayOriginTrusted(undefined, ALLOW)).toBe(false);
  });

  it('is exact — no substring or scheme confusion', () => {
    expect(miniPayOriginTrusted('https://minipay.opera.com.evil.example', ALLOW)).toBe(false);
    expect(miniPayOriginTrusted('http://ludo.example', ALLOW)).toBe(false); // wrong scheme
  });
});
