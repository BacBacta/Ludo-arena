/**
 * Avatar frames (E-social C3): a cosmetic ring drawn around a player's avatar,
 * visible to everyone (own profile card, the tap-to-view profile sheet). The id
 * set is the shared AVATAR_FRAMES allowlist; the visual is a pure-CSS class
 * (`avframe avframe--<id>`) so no assets ship. Frames unlock through play —
 * client-computed from the same stats the dice skins use — and are equipped
 * locally + sent in hello (client-authoritative, cosmetic-only trust model).
 */
import { AVATAR_FRAMES, type AvatarFrame } from '@ludo/shared';
import type { TKey } from './i18n';

export interface FrameUnlockCtx {
  games: number;
  wins: number;
  streakDays: number;
  division: number; // 0 = top division
}

export interface FrameDef {
  id: AvatarFrame;
  nameKey: TKey;
  /** Unlock hint (undefined = always available). */
  hintKey?: TKey;
  unlocked(ctx: FrameUnlockCtx): boolean;
}

export const FRAMES: FrameDef[] = [
  { id: 'none', nameKey: 'frameNone', unlocked: () => true },
  { id: 'bronze', nameKey: 'frameBronze', hintKey: 'frameBronzeHint', unlocked: (c) => c.games >= 5 },
  { id: 'silver', nameKey: 'frameSilver', hintKey: 'frameSilverHint', unlocked: (c) => c.wins >= 10 },
  { id: 'gold', nameKey: 'frameGold', hintKey: 'frameGoldHint', unlocked: (c) => c.wins >= 25 },
  { id: 'neon', nameKey: 'frameNeon', hintKey: 'frameNeonHint', unlocked: (c) => c.streakDays >= 7 },
  { id: 'champion', nameKey: 'frameChampion', hintKey: 'frameChampionHint', unlocked: (c) => c.division <= 1 },
];

export function frameById(id: string): FrameDef {
  return FRAMES.find((f) => f.id === id) ?? FRAMES[0]!;
}

/** CSS class for a frame id (safe for any avatar wrapper). 'none' → no ring. */
export function frameClass(id: string | undefined): string {
  const fid = id && (AVATAR_FRAMES as readonly string[]).includes(id) ? id : 'none';
  return fid === 'none' ? '' : `avframe avframe--${fid}`;
}

const FRAME_KEY = 'ludo.avatarFrame';

export function loadFrameId(): string {
  try {
    return localStorage.getItem(FRAME_KEY) ?? 'none';
  } catch {
    return 'none';
  }
}

export function saveFrameId(id: string): void {
  try {
    localStorage.setItem(FRAME_KEY, id);
  } catch {
    /* storage unavailable */
  }
}
