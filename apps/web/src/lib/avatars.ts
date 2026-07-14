/**
 * Profile avatars (E-social): a premium 3D character picture a player may set as
 * their identity instead of a bare flag. The id set is the shared AVATARS
 * allowlist; the images ship as static assets (`public/avatars/av_<id>.png`,
 * Microsoft Fluent Emoji 3D — MIT). Chosen locally + sent in hello (same
 * client-authoritative, cosmetic-only trust model as avatar frames).
 */
import { AVATARS, isAvatar } from '@ludo/shared';

const BASE = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';

/** Image URL for an avatar id, or null for 'none'/unknown (→ fall back to flag). */
export function avatarSrc(id: string | undefined | null): string | null {
  if (!id || id === 'none' || !isAvatar(id)) return null;
  return `${BASE}avatars/av_${id}.png`;
}

/** True when this id resolves to a real avatar image (not 'none'). */
export function hasAvatar(id: string | undefined | null): boolean {
  return avatarSrc(id) !== null;
}

/** All selectable avatar ids (the shared list minus the 'none' sentinel), in
 *  display order: Person/Man/Woman across skin tones, then character variants. */
export const AVATAR_IDS: string[] = (AVATARS as readonly string[]).filter((id) => id !== 'none');

/** Ids that are one of the base Person/Man/Woman faces (gender × skin tone). */
export const AVATAR_FACES: string[] = AVATAR_IDS.filter((id) =>
  /^(person|man|woman)_/.test(id),
);
/** Character-variant ids (astronaut, artist, ninja…). */
export const AVATAR_CHARACTERS: string[] = AVATAR_IDS.filter((id) => !AVATAR_FACES.includes(id));

const AVATAR_KEY = 'ludo.avatar';

export function loadAvatarId(): string {
  try {
    return localStorage.getItem(AVATAR_KEY) ?? 'none';
  } catch {
    return 'none';
  }
}

export function saveAvatarId(id: string): void {
  try {
    localStorage.setItem(AVATAR_KEY, id);
  } catch {
    /* storage unavailable */
  }
}
