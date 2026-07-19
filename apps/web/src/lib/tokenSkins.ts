/**
 * Token (pawn) skins — cosmetics phase 1. The piece the OPPONENT stares at all
 * game, i.e. the highest-visibility social cosmetic surface. Every skin is pure
 * SVG geometry (a pattern overlay + material tweaks inside PegShape), TINTED BY
 * THE SEAT COLOUR so gameplay readability is never affected (golden rule: the
 * four seat hues stay recognisable). Prices/ownership live in the shared
 * PREMIUM_COSMETICS catalog (kind 'token'); equipping is client-authoritative
 * like dice skins and travels to the opponent via hello → match.found.
 */

export type TokenPattern = 'none' | 'wax' | 'kente' | 'bogolan' | 'gilded' | 'lion';

export interface TokenSkin {
  id: string;
  name: string;
  pattern: TokenPattern;
  /** Short flavour line for the shop tile. */
  blurb: string;
}

export const TOKEN_SKINS: readonly TokenSkin[] = [
  { id: 'tok-classic', name: 'Classic', pattern: 'none', blurb: 'The original glossy peg' },
  { id: 'tok-wax', name: 'Wax Print', pattern: 'wax', blurb: 'Ankara dots' },
  { id: 'tok-kente', name: 'Kente', pattern: 'kente', blurb: 'Woven gold bands' },
  { id: 'tok-bogolan', name: 'Bogolan', pattern: 'bogolan', blurb: 'Mudcloth zigzag' },
  { id: 'tok-gilded', name: 'Gilded', pattern: 'gilded', blurb: 'Gold-foil finish' },
  // Legendary "Savane Royale" line (phase 3).
  { id: 'tok-lion', name: 'Lion', pattern: 'lion', blurb: 'Golden mane' },
] as const;

export function tokenSkinById(id: string | undefined): TokenSkin {
  return TOKEN_SKINS.find((s) => s.id === id) ?? TOKEN_SKINS[0]!;
}

/** Entrance effects (played at match start, seen by BOTH players). Emoji-burst
 *  CSS animations — zero asset bytes. Ids live in PREMIUM_COSMETICS ('entrance'). */
export interface EntranceFx {
  id: string;
  name: string;
  /** The emoji particles the burst is made of. */
  particles: readonly string[];
}

export const ENTRANCE_FX: readonly EntranceFx[] = [
  { id: 'fx-none', name: 'None', particles: [] },
  { id: 'fx-sparkle', name: 'Sparkle', particles: ['✨', '⭐', '✨', '💫', '✨', '⭐', '💫', '✨'] },
  { id: 'fx-goldrain', name: 'Gold Rain', particles: ['🪙', '🪙', '💰', '🪙', '🪙', '💰', '🪙', '🪙'] },
] as const;

export function entranceFxById(id: string | undefined): EntranceFx {
  return ENTRANCE_FX.find((f) => f.id === id) ?? ENTRANCE_FX[0]!;
}

/** Victory effects (cosmetics phase 2): the WINNER's flourish on the end screen,
 *  seen by both players — relayed like entranceFx so the loser watches it too.
 *  Same zero-asset emoji-burst tech as the entrance effects. */
export interface VictoryFx {
  id: string;
  name: string;
  particles: readonly string[];
}

export const VICTORY_FX: readonly VictoryFx[] = [
  { id: 'vx-none', name: 'None', particles: [] },
  { id: 'vx-fireworks', name: 'Fireworks', particles: ['🎆', '🎇', '✨', '🎆', '🎇', '✨', '🎆', '🎇', '✨', '🎆'] },
  { id: 'vx-crown', name: 'Coronation', particles: ['👑', '✨', '💛', '👑', '✨', '💛', '👑', '✨', '👑', '✨'] },
  // Legendary "Savane Royale" line (phase 3): the savanna parades for the winner.
  { id: 'vx-stampede', name: 'Stampede', particles: ['🦁', '🦓', '🐘', '🦒', '🦁', '🦓', '🐘', '🦒', '🦁', '✨'] },
] as const;

export function victoryFxById(id: string | undefined): VictoryFx {
  return VICTORY_FX.find((f) => f.id === id) ?? VICTORY_FX[0]!;
}

const TOKEN_KEY = 'ludo.tokenSkin';
const FX_KEY = 'ludo.entranceFx';
const VX_KEY = 'ludo.victoryFx';

export function loadTokenSkinId(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? 'tok-classic';
  } catch {
    return 'tok-classic';
  }
}
export function saveTokenSkinId(id: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, id);
  } catch {
    /* storage unavailable */
  }
}
export function loadEntranceFxId(): string {
  try {
    return localStorage.getItem(FX_KEY) ?? 'fx-none';
  } catch {
    return 'fx-none';
  }
}
export function saveEntranceFxId(id: string): void {
  try {
    localStorage.setItem(FX_KEY, id);
  } catch {
    /* storage unavailable */
  }
}
export function loadVictoryFxId(): string {
  try {
    return localStorage.getItem(VX_KEY) ?? 'vx-none';
  } catch {
    return 'vx-none';
  }
}
export function saveVictoryFxId(id: string): void {
  try {
    localStorage.setItem(VX_KEY, id);
  } catch {
    /* storage unavailable */
  }
}
