/**
 * Client-side extraction of a Zealy user id from whatever the player pastes:
 * their profile LINK (…zealy.io/cw/<community>/users/<id>, query/hash
 * tolerated) or the raw id. Mirrors the server's parseZealyProfileId — the
 * server re-validates, this only powers instant feedback in the form.
 */
export function parseZealyProfileId(input: string | null | undefined): string | null {
  if (!input) return null;
  let v = input.trim();
  if (v.includes('zealy.io')) {
    const path = v.split(/[?#]/)[0] ?? '';
    const segs = path.split('/').filter(Boolean);
    v = segs[segs.length - 1] ?? '';
  }
  v = v.toLowerCase();
  return /^[a-z0-9_-]{8,64}$/.test(v) ? v : null;
}
