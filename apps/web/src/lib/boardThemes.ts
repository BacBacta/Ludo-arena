/**
 * Board themes — cosmetics phase 2, Organic pass ("the premium table").
 *
 * A theme re-skins ONLY the board's NEUTRAL surfaces (plate, track cells, yard,
 * centre rosette, safe stars) plus how far back the seat-colour quadrant wash is
 * knocked. The four seat colours themselves are untouchable: the pawn, the home
 * column, the start cell and the centre triangles always paint the canonical
 * `--seat-*` value, so token/cell readability never changes (golden rule).
 * Local view only, never relayed — like Ludo King, each player plays on the
 * board THEY bought. Prices/ownership live in PREMIUM_COSMETICS (kind 'board');
 * equipping is client-authoritative like dice skins.
 *
 * The design ships three treatments (1m): ceramic-on-paper (the free default,
 * used by 1c), night table (dark walnut, pairs with the Stakes mode of 1b) and
 * flat high-contrast (free, for 360px entry-level Android in sunlight). The
 * three paid themes that predate the redesign are RETUNED into the Organic
 * palette rather than dropped — removing them would strip boards players paid
 * real money for and break `set-royale`, which counts `brd-serengeti`.
 */

export interface BoardTheme {
  id: string;
  name: string;
  /** Short flavour line for the shop tile. */
  blurb: string;
  /** The plate the whole board sits on. */
  ground: string;
  /** Hairline around the plate, and around the centre dot. */
  edge: string;
  /** Track cell fill. */
  cell: string;
  /** Track cell hairline. */
  cellStroke: string;
  /** The yard (home square) inside each quadrant. */
  yard: string;
  /** Base of the centre rosette, under the seat triangles. */
  centre: string;
  /** The star glyph marking a safe cell. */
  star: string;
  /** Ink for text and marks laid directly on the plate (the player labels). */
  onGround: string;
  /** How strongly the seat-colour quadrant wash reads over the plate. */
  quadOpacity: number;
  /** CSS radius + shadow applied to the board element itself. */
  radius: string;
  shadow: string;
  /**
   * Crisp mode: square-ish corners, heavier strokes, stronger seat fills and no
   * shadow — costs the craft, buys legibility on a cheap panel in sunlight.
   */
  crisp?: boolean;
}

export const BOARD_THEMES: readonly BoardTheme[] = [
  {
    // 1m·A — the free default. Same ground as the rest of the app, so the board
    // never reads as a separate skin dropped onto the page.
    id: 'brd-classic',
    name: 'Ceramic',
    blurb: 'Ceramic on paper',
    ground: '#fffdf8',
    edge: 'rgba(32,30,29,.14)',
    cell: '#fdf6e9',
    cellStroke: '#e2d6c0',
    yard: '#fffdf8',
    centre: '#f0e4cf',
    star: '#645c50',
    onGround: '#3b352c',
    quadOpacity: 0.34,
    radius: '26px',
    shadow: '0 10px 26px rgba(46,43,37,.18)',
  },
  {
    // 1m·C — free, and deliberately not for sale: this is an accessibility and
    // low-end-device affordance, not a cosmetic.
    id: 'brd-flat',
    name: 'High Contrast',
    blurb: 'Solid fills, no shadows',
    ground: '#ffffff',
    edge: '#201e1d',
    cell: '#ffffff',
    cellStroke: '#a19786',
    yard: '#ffffff',
    centre: '#eee7db',
    star: '#201e1d',
    onGround: '#201e1d',
    quadOpacity: 0.55,
    radius: '8px',
    shadow: 'none',
    crisp: true,
  },
  {
    // 1m·B — retuned from the candy-era midnight blue. Same id and price, so
    // everyone who bought "Midnight" keeps it.
    id: 'brd-night',
    name: 'Night Table',
    blurb: 'Dark walnut — the pieces glow',
    ground: '#2e2b25',
    edge: 'rgba(249,244,237,.16)',
    cell: '#3b352c',
    cellStroke: '#4a4338',
    yard: '#26241f',
    centre: '#3b352c',
    star: '#c0b6a5',
    onGround: '#c0b6a5',
    quadOpacity: 0.3,
    radius: '26px',
    shadow: '0 12px 30px rgba(0,0,0,.35)',
  },
  {
    id: 'brd-savanna',
    name: 'Savanna',
    blurb: 'Warm sunset sand',
    ground: '#fbf1dc',
    edge: 'rgba(122,83,20,.18)',
    cell: '#fff8e8',
    cellStroke: '#e0c79b',
    yard: '#fffbf2',
    centre: '#efdcb8',
    star: '#8a6a2f',
    onGround: '#5c4520',
    quadOpacity: 0.34,
    radius: '26px',
    shadow: '0 10px 26px rgba(92,64,18,.20)',
  },
  {
    id: 'brd-royal',
    name: 'Royal Court',
    blurb: 'Muted plum & antique gold',
    ground: '#f6f1f7',
    edge: 'rgba(70,40,90,.16)',
    cell: '#faf6fb',
    cellStroke: '#d3c2da',
    yard: '#fffdf8',
    centre: '#e7dcec',
    star: '#8c6b3f',
    onGround: '#4a3552',
    quadOpacity: 0.34,
    radius: '26px',
    shadow: '0 10px 26px rgba(58,32,74,.20)',
  },
  {
    // Legendary "Savane Royale" line (phase 3): golden-hour savanna dusk.
    id: 'brd-serengeti',
    name: 'Serengeti',
    blurb: 'Golden-hour dusk',
    ground: '#f8e4c4',
    edge: 'rgba(130,78,18,.20)',
    cell: '#fdf0d8',
    cellStroke: '#d9b276',
    yard: '#fff6e4',
    centre: '#eed7a8',
    star: '#a85e1f',
    onGround: '#7a4a12',
    quadOpacity: 0.36,
    radius: '26px',
    shadow: '0 10px 26px rgba(120,72,16,.22)',
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
