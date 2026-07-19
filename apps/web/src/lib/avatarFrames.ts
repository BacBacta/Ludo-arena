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
import { isPremiumFrame } from '../components/PremiumFrame';

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
  // Ultra-premium illustrated + animated frames (SVG overlays) — progression rewards.
  { id: 'laurel', nameKey: 'frameLaurel', hintKey: 'frameLaurelHint', unlocked: (c) => c.wins >= 15 },
  { id: 'ruby', nameKey: 'frameRuby', hintKey: 'frameRubyHint', unlocked: (c) => c.wins >= 30 },
  { id: 'royal', nameKey: 'frameRoyal', hintKey: 'frameRoyalHint', unlocked: (c) => c.wins >= 50 },
  { id: 'flame', nameKey: 'frameFlame', hintKey: 'frameFlameHint', unlocked: (c) => c.streakDays >= 5 },
  { id: 'jade', nameKey: 'frameJade', hintKey: 'frameJadeHint', unlocked: (c) => c.streakDays >= 12 },
  { id: 'frost', nameKey: 'frameFrost', hintKey: 'frameFrostHint', unlocked: (c) => c.games >= 40 },
  { id: 'nebula', nameKey: 'frameNebula', hintKey: 'frameNebulaHint', unlocked: (c) => c.games >= 80 },
  { id: 'circuit', nameKey: 'frameCircuit', hintKey: 'frameCircuitHint', unlocked: (c) => c.division <= 0 },
  // Shop-only animated frames (cosmetics phase 2): never progression-unlocked —
  // ownership comes from the ticket/cUSD purchase (ownedSkins), checked in the shop.
  { id: 'fr-sunburst', nameKey: 'frameSunburst', hintKey: 'frameSunburstHint', unlocked: () => false },
  { id: 'fr-leopard', nameKey: 'frameLeopard', hintKey: 'frameLeopardHint', unlocked: () => false },
];

export function frameById(id: string): FrameDef {
  return FRAMES.find((f) => f.id === id) ?? FRAMES[0]!;
}

/** CSS class for a frame id (safe for any avatar wrapper). 'none' → no ring.
 *  Premium frames render as an SVG overlay (<PremiumFrame>), NOT a CSS ring. */
export function frameClass(id: string | undefined): string {
  if (isPremiumFrame(id)) return '';
  const fid = id && (AVATAR_FRAMES as readonly string[]).includes(id) ? id : 'none';
  return fid === 'none' ? '' : `avframe avframe--${fid}`;
}

/** Ring-only variant (box-shadow, no layout props) — for avatars that already
 *  own their sizing/shape (the in-game corner cards), so the ring is purely
 *  additive and can't disturb the countdown ring or seat scaling. */
export function frameRing(id: string | undefined): string {
  if (isPremiumFrame(id)) return '';
  const fid = id && (AVATAR_FRAMES as readonly string[]).includes(id) ? id : 'none';
  return fid === 'none' ? '' : `avframe--${fid}`;
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
