import { describe, expect, it } from 'vitest';
import { parseZealyProfileId } from '../src/lib/zealyLink';

// The client-side mirror of the server parser: instant form feedback must
// accept exactly what the server will accept.

const UUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

describe('parseZealyProfileId (client)', () => {
  it('extracts the id from a pasted profile link, with query/hash noise', () => {
    expect(parseZealyProfileId(`https://zealy.io/cw/ludoarena/users/${UUID}?invite=x#p`)).toBe(UUID);
  });

  it('accepts a raw id and normalizes the case', () => {
    expect(parseZealyProfileId(UUID.toUpperCase())).toBe(UUID);
  });

  it('rejects junk so the form can toast BEFORE any network call', () => {
    expect(parseZealyProfileId('short')).toBeNull();
    expect(parseZealyProfileId('https://zealy.io/cw/ludoarena')).toBe('ludoarena');
    expect(parseZealyProfileId('two words')).toBeNull();
    expect(parseZealyProfileId('')).toBeNull();
  });
});
