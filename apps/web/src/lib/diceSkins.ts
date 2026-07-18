/**
 * Dice skins: cosmetic styles for the die, unlocked through play (progression
 * rewards). Equipped skin persists locally; local stats (games/wins) feed the
 * unlock rules. Paid premium skins land with the payments rail (marked soon).
 */
import type { TKey } from './i18n';

export interface PlayerStats {
  games: number;
  wins: number;
}

export interface UnlockCtx extends PlayerStats {
  streakDays: number;
  tickets: number;
  division: number;
}

/** Ultra-premium dice are rendered in real 3D (WebGL/PBR) with a dedicated roll
 *  sound; `material` drives both the WebGL shader and the richer static preview. */
export type DieMaterial = 'metal' | 'glass' | 'gem' | 'irid' | 'cyber' | 'molten';

export interface DiceSkin {
  id: string;
  name: string;
  body1: string;
  body2: string;
  pip: string;
  stroke: string;
  glow?: string;
  /** Premium 3D material (undefined = flat CSS die, the default). */
  material?: DieMaterial;
  /** Dedicated roll sound key → public/sfx/dice/<sound>.mp3 (undefined = default). */
  sound?: string;
  hintKey?: TKey; // unlock hint (undefined = free)
  unlocked(ctx: UnlockCtx): boolean;
  soon?: boolean; // future paid skin
  /** Season-exclusive (Phase 4): grantable ONLY via the season track — never
   *  progression-unlockable or purchasable. The picker labels it accordingly. */
  season?: boolean;
}

export const DICE_SKINS: DiceSkin[] = [
  {
    id: 'classic',
    name: 'Classic',
    body1: '#ffffff',
    body2: '#e8e2d2',
    pip: '#1b241f',
    stroke: 'rgba(0,0,0,.15)',
    unlocked: () => true,
  },
  {
    id: 'emerald',
    name: 'Emerald',
    body1: '#6fe0a8',
    body2: '#1d7c50',
    pip: '#ffffff',
    stroke: '#0f3d28',
    hintKey: 'skinHintGames',
    unlocked: (c) => c.games >= 3,
  },
  {
    id: 'amber',
    name: 'Amber',
    body1: '#ffd94d',
    body2: '#dd9d00',
    pip: '#24312a',
    stroke: '#8a6200',
    hintKey: 'skinHintStreak',
    unlocked: (c) => c.streakDays >= 3,
  },
  {
    id: 'midnight',
    name: 'Midnight',
    body1: '#3a4a42',
    body2: '#141d18',
    pip: '#ffd94d',
    stroke: '#000000',
    hintKey: 'skinHintTicket',
    unlocked: (c) => c.tickets >= 1,
  },
  {
    id: 'royal',
    name: 'Royal',
    body1: '#b06ef7',
    body2: '#5b2bbf',
    pip: '#ffffff',
    stroke: '#3a1580',
    hintKey: 'skinHintWins',
    unlocked: (c) => c.wins >= 3,
  },
  {
    // Free progression skin, upgraded to a real 3D 'cyber' material + sound.
    id: 'neon',
    name: 'Neon',
    body1: '#59f7d2',
    body2: '#0aa07a',
    pip: '#083328',
    stroke: '#03614a',
    glow: 'rgba(89,247,210,.55)',
    material: 'cyber',
    sound: 'neon',
    hintKey: 'skinHintLeague',
    unlocked: (c) => c.division >= 2,
  },
  // ---- Ultra-premium 3D dice (PREMIUM_COSMETICS): real WebGL PBR materials +
  //      a dedicated roll sound. unlocked() stays false — ownership drives the UI.
  {
    id: 'obsidian',
    name: 'Obsidian',
    body1: '#3a3a44',
    body2: '#0a0a0e',
    pip: '#ff2d55',
    stroke: '#000000',
    glow: 'rgba(255,45,85,.5)',
    material: 'glass',
    sound: 'obsidian',
    unlocked: () => false,
  },
  {
    id: 'aurora',
    name: 'Aurora',
    body1: '#c9b8ff',
    body2: '#6a5be0',
    pip: '#0b1030',
    stroke: '#3a2f8a',
    glow: 'rgba(150,140,255,.55)',
    material: 'irid',
    sound: 'aurora',
    unlocked: () => false,
  },
  {
    id: 'crystal',
    name: 'Diamond',
    body1: '#f2ffff',
    body2: '#5fa8d8',
    pip: '#1b3a5a',
    stroke: '#8fc6e6',
    glow: 'rgba(120,220,255,.55)',
    material: 'gem',
    sound: 'crystal',
    unlocked: () => false,
  },
  {
    id: 'ember',
    name: 'Ember',
    body1: '#ffe1a0',
    body2: '#8a1418',
    pip: '#fff2d8',
    stroke: '#5a0a0a',
    glow: 'rgba(255,90,40,.55)',
    material: 'molten',
    sound: 'ember',
    unlocked: () => false,
  },
  {
    id: 'gold',
    name: 'Gold',
    body1: '#fff2b0',
    body2: '#a9760a',
    pip: '#4a3400',
    stroke: '#7a5300',
    glow: 'rgba(245,179,1,.55)',
    material: 'metal',
    sound: 'gold',
    unlocked: () => false,
  },
  // ---- Season-exclusive skins (Phase 4 content pool: SEASON_SKINS). Pass-only:
  // never progression-unlockable or purchasable → only granted by the season track.
  // Procedural (colour/material only), so new seasons add ids here with no art step.
  { id: 'season-aurora', name: 'Borealis', body1: '#8ef0d0', body2: '#5a2fb0', pip: '#ffffff', stroke: '#2a1560', glow: 'rgba(140,240,210,.5)', material: 'irid', season: true, unlocked: () => false },
  { id: 'season-crimson', name: 'Crimson', body1: '#ff8a7a', body2: '#8a0f24', pip: '#fff0ec', stroke: '#500810', glow: 'rgba(255,70,70,.5)', material: 'molten', season: true, unlocked: () => false },
  { id: 'season-abyss', name: 'Abyss', body1: '#5a7fb0', body2: '#0a1830', pip: '#cfe4ff', stroke: '#050c1a', glow: 'rgba(60,120,220,.45)', material: 'glass', season: true, unlocked: () => false },
  { id: 'season-verdant', name: 'Verdant', body1: '#a6f08a', body2: '#1c6a2e', pip: '#f0fff0', stroke: '#0d3316', glow: 'rgba(120,230,120,.45)', season: true, unlocked: () => false },
  { id: 'season-solar', name: 'Solar', body1: '#ffe08a', body2: '#c85a10', pip: '#3a1e00', stroke: '#7a3a08', glow: 'rgba(255,170,50,.55)', material: 'metal', season: true, unlocked: () => false },
  { id: 'season-frost', name: 'Frost', body1: '#dff2ff', body2: '#5aa0d8', pip: '#0a2a44', stroke: '#2a5a80', glow: 'rgba(150,210,255,.5)', material: 'gem', season: true, unlocked: () => false },
  { id: 'season-void', name: 'Void', body1: '#9a7fd0', body2: '#1a0a30', pip: '#e0d0ff', stroke: '#0a0518', glow: 'rgba(150,90,230,.5)', material: 'irid', season: true, unlocked: () => false },
  { id: 'season-royal', name: 'Royal', body1: '#f0d68a', body2: '#4a1a70', pip: '#fff6d8', stroke: '#2a0e42', glow: 'rgba(240,200,120,.5)', material: 'gem', season: true, unlocked: () => false },
];

export function skinById(id: string): DiceSkin {
  return DICE_SKINS.find((s) => s.id === id) ?? DICE_SKINS[0]!;
}

const SKIN_KEY = 'ludo.diceSkin';
const STATS_KEY = 'ludo.stats';

export function loadSkinId(): string {
  try {
    return localStorage.getItem(SKIN_KEY) ?? 'classic';
  } catch {
    return 'classic';
  }
}
export function saveSkinId(id: string): void {
  try {
    localStorage.setItem(SKIN_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

export function loadStats(): PlayerStats {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    return raw ? (JSON.parse(raw) as PlayerStats) : { games: 0, wins: 0 };
  } catch {
    return { games: 0, wins: 0 };
  }
}
export function recordGameResult(won: boolean): PlayerStats {
  const s = loadStats();
  const next = { games: s.games + 1, wins: s.wins + (won ? 1 : 0) };
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
  return next;
}
