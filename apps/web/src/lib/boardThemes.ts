/**
 * Board themes — cosmetics phase 2. A theme re-skins ONLY the board's NEUTRAL
 * surfaces (plate, track cells, safe cells, home squares, resting slots): the
 * four seat colours are untouchable so token/cell readability never changes
 * (golden rule). Local view only, never relayed — like Ludo King, each player
 * plays on the board THEY bought. Prices/ownership live in PREMIUM_COSMETICS
 * (kind 'board'); equipping is client-authoritative like dice skins.
 */

export interface BoardTheme {
  id: string;
  name: string;
  /** Short flavour line for the shop tile. */
  blurb: string;
  /** Board plate + track cell fill. */
  cell: string;
  /** Hairline grid stroke between cells. */
  cellStroke: string;
  /** Safe-cell fill (the star cells). */
  safe: string;
  /** The star glyph on safe cells. */
  safeStar: string;
  /** White home-square fill inside each quadrant. */
  home: string;
  /** The four resting discs inside the home square. */
  slot: string;
  /** Soft drop-edge under the home square. */
  homeEdge: string;
}

export const BOARD_THEMES: readonly BoardTheme[] = [
  {
    id: 'brd-classic',
    name: 'Classic',
    blurb: 'The original bright plate',
    cell: '#ffffff',
    cellStroke: '#a6b0c0',
    safe: '#c9d1de',
    safeStar: '#ffffff',
    home: '#ffffff',
    slot: '#d4dae6',
    homeEdge: 'rgba(16,24,48,.16)',
  },
  {
    id: 'brd-night',
    name: 'Midnight',
    blurb: 'Deep-blue night board',
    cell: '#1d2748',
    cellStroke: '#3a4671',
    safe: '#2e3a63',
    safeStar: '#8fa3d9',
    home: '#232e54',
    slot: '#39456e',
    homeEdge: 'rgba(0,0,0,.35)',
  },
  {
    id: 'brd-savanna',
    name: 'Savanna',
    blurb: 'Warm sunset sand',
    cell: '#fdf3dc',
    cellStroke: '#d9b98a',
    safe: '#f0dcac',
    safeStar: '#fffaf0',
    home: '#fff8ea',
    slot: '#e8d3a4',
    homeEdge: 'rgba(122,83,0,.22)',
  },
  {
    // Legendary "Savane Royale" line (phase 3): golden-hour savanna dusk.
    id: 'brd-serengeti',
    name: 'Serengeti',
    blurb: 'Golden-hour dusk',
    cell: '#fbe7c3',
    cellStroke: '#d9a55e',
    safe: '#f2d69e',
    safeStar: '#b4641f',
    home: '#fff3dc',
    slot: '#e9cf9c',
    homeEdge: 'rgba(140,84,15,.25)',
  },
  {
    id: 'brd-royal',
    name: 'Royal Court',
    blurb: 'Velvet purple & gold',
    cell: '#f4efff',
    cellStroke: '#c3aee8',
    safe: '#e2d4f8',
    safeStar: '#f5b301',
    home: '#faf6ff',
    slot: '#ddcdf5',
    homeEdge: 'rgba(64,22,128,.22)',
  },
] as const;

export function boardThemeById(id: string | undefined): BoardTheme {
  return BOARD_THEMES.find((b) => b.id === id) ?? BOARD_THEMES[0]!;
}

const THEME_KEY = 'ludo.boardTheme';

export function loadBoardThemeId(): string {
  try {
    return localStorage.getItem(THEME_KEY) ?? 'brd-classic';
  } catch {
    return 'brd-classic';
  }
}
export function saveBoardThemeId(id: string): void {
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    /* storage unavailable */
  }
}
