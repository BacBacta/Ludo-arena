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

export interface DiceSkin {
  id: string;
  name: string;
  body1: string;
  body2: string;
  pip: string;
  stroke: string;
  glow?: string;
  hintKey?: TKey; // unlock hint (undefined = free)
  unlocked(ctx: UnlockCtx): boolean;
  soon?: boolean; // future paid skin
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
    id: 'neon',
    name: 'Neon',
    body1: '#59f7d2',
    body2: '#0aa07a',
    pip: '#083328',
    stroke: '#03614a',
    glow: 'rgba(89,247,210,.55)',
    hintKey: 'skinHintLeague',
    unlocked: (c) => c.division >= 2,
  },
  {
    // Premium (PREMIUM_SKINS): unlocked by spending freeroll tickets, tracked
    // server-side. unlocked() stays false — ownership drives the UI, not stats.
    id: 'obsidian',
    name: 'Obsidian',
    body1: '#2b2b33',
    body2: '#0c0c10',
    pip: '#ff4d6d',
    stroke: '#000000',
    glow: 'rgba(255,77,109,.4)',
    unlocked: () => false,
  },
  {
    id: 'aurora',
    name: 'Aurora',
    body1: '#7ef0ff',
    body2: '#6a5be0',
    pip: '#0b1030',
    stroke: '#2a2170',
    glow: 'rgba(126,240,255,.5)',
    unlocked: () => false,
  },
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
