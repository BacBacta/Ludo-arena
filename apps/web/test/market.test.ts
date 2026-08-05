import { describe, expect, it } from 'vitest';
import { resolveMarket } from '../src/lib/market';

// The MARKET mode decides the commercial/legal shape of a build. The stakes:
// a wrong fallback either strips staking from the global product (revenue) or
// ships staking into the Cameroon build (the compliance line the market mode
// exists to hold). Both directions are pinned.
describe('resolveMarket', () => {
  it('defaults to the GLOBAL product when the env is unset or unknown', () => {
    // A missing/typo'd env var must never strip features from the main deploy.
    expect(resolveMarket(undefined).key).toBe('global');
    expect(resolveMarket('').key).toBe('global');
    expect(resolveMarket('nope').key).toBe('global');
    expect(resolveMarket(undefined).staking).toBe(true);
    expect(resolveMarket(undefined).defaultLang).toBe('en');
  });

  it('cm = Cameroon build: NO staking anywhere, French by default', () => {
    const cm = resolveMarket('cm');
    expect(cm.staking).toBe(false);
    expect(cm.defaultLang).toBe('fr');
  });

  it('is case/whitespace tolerant — a Vercel env var edited by hand still resolves', () => {
    expect(resolveMarket(' CM ').key).toBe('cm');
    expect(resolveMarket('Cm').staking).toBe(false);
  });
});
