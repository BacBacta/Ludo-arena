/**
 * Lightweight device fingerprint (E5.3) for anti multi-accounting. Not a
 * security control — just a signal to refuse obvious same-device staked play.
 */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

let cached: string | null = null;

export function deviceFingerprint(): string {
  if (cached !== null) return cached;
  try {
    const parts = [
      navigator.userAgent,
      navigator.language,
      `${screen.width}x${screen.height}x${screen.colorDepth}`,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      String(navigator.hardwareConcurrency ?? ''),
    ];
    cached = djb2(parts.join('|'));
  } catch {
    cached = '';
  }
  return cached;
}
