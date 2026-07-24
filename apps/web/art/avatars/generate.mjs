/**
 * Ludo Arena ORIGINAL avatars — first-party brand asset generator.
 *
 * Emits the `ludo_*` SVG masters from ONE shared pawn template + per-character
 * accessories, so the whole set stays visually coherent (same geometry, same
 * face, same light) and reproducible. The shipped assets are 512×512 PNGs
 * rendered from these masters (see render.mjs) into public/avatars/av_<id>.png —
 * the client's avatarSrc() pipeline is untouched.
 *
 * Design language (mirrors icon.svg): cream badge #F4EFE6 like the board on the
 * logo, characters in the brand palette (pion green/orange/gold + player blue),
 * soft deep-tone outlines (no black), Fredoka-round shapes, sticker feel.
 * 100% original work — no third-party art. Licence: project-owned.
 *
 * Run: node apps/web/art/avatars/generate.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));
mkdirSync(OUT, { recursive: true });

// Brand palette (global.css / icon.svg)
const CREAM = '#F4EFE6';
const INK = '#16211C';
const GOLD = '#F5B301';
const GOLD_DEEP = '#B87E00';
const BLUE = '#3E63DD';
const BLUE_DEEP = '#2947A8';
const GREEN = '#2E9E6B';
const GREEN_DEEP = '#1C6B47';
const ORANGE = '#E8833A';
const ORANGE_DEEP = '#A85320';
const RED = '#E05555';
const RED_DEEP = '#A03030';

/** Round-friendly face shared by every character. cy = eye line. */
function face(cy = 172, cx = 256, scale = 1) {
  const s = (n) => n * scale;
  return `
  <circle cx="${cx - s(27)}" cy="${cy}" r="${s(17)}" fill="#fff"/>
  <circle cx="${cx + s(27)}" cy="${cy}" r="${s(17)}" fill="#fff"/>
  <circle cx="${cx - s(23)}" cy="${cy + s(4)}" r="${s(8.5)}" fill="${INK}"/>
  <circle cx="${cx + s(31)}" cy="${cy + s(4)}" r="${s(8.5)}" fill="${INK}"/>
  <circle cx="${cx - s(20)}" cy="${cy}" r="${s(3)}" fill="#fff"/>
  <circle cx="${cx + s(34)}" cy="${cy}" r="${s(3)}" fill="#fff"/>
  <path d="M${cx - s(28)} ${cy + s(32)} Q${cx} ${cy + s(52)} ${cx + s(28)} ${cy + s(32)}" fill="none" stroke="${INK}" stroke-width="${s(9)}" stroke-linecap="round"/>
  <circle cx="${cx - s(52)}" cy="${cy + s(24)}" r="${s(10)}" fill="#FF9D76" opacity="0.45"/>
  <circle cx="${cx + s(52)}" cy="${cy + s(24)}" r="${s(10)}" fill="#FF9D76" opacity="0.45"/>`;
}

/** The Ludo pawn body (head + collar + flared body + base), brand geometry.
 *  opts.noFace lets a character (pirate) draw its own custom face on top. */
function pawn(fill, deep, opts = {}) {
  const headCy = opts.headCy ?? 178;
  return `
  <ellipse cx="256" cy="404" rx="110" ry="36" fill="${deep}"/>
  <ellipse cx="256" cy="396" rx="110" ry="36" fill="${fill}"/>
  <path d="M176 398 C186 322 224 296 230 252 L282 252 C288 296 326 322 336 398 Z" fill="${fill}"/>
  <path d="M186 398 C226 380 286 380 326 398 L326 410 L186 410 Z" fill="${deep}" opacity="0.25"/>
  <ellipse cx="256" cy="250" rx="58" ry="20" fill="${deep}"/>
  <ellipse cx="256" cy="244" rx="58" ry="20" fill="${fill}"/>
  <circle cx="256" cy="${headCy}" r="76" fill="${fill}"/>
  <ellipse cx="222" cy="${headCy - 32}" rx="26" ry="14" fill="#fff" opacity="0.5" transform="rotate(-20 222 ${headCy - 32})"/>
  ${opts.noFace ? '' : face(headCy - 6)}`;
}

/** 512×512 badge wrapper: cream circle + soft per-character ring. */
function badge(inner, ring) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img">
  <circle cx="256" cy="256" r="248" fill="${CREAM}"/>
  <circle cx="256" cy="256" r="238" fill="none" stroke="${ring}" stroke-width="14" opacity="0.28"/>
${inner}
</svg>`;
}

const gem = (cx, cy, r, fill) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${GOLD_DEEP}" stroke-width="4"/>`;

const AVATARS = {
  // — The four classic pawns (board colours in the brand palette) —
  ludo_blue: badge(pawn(BLUE, BLUE_DEEP), BLUE),
  ludo_green: badge(pawn(GREEN, GREEN_DEEP), GREEN),
  ludo_orange: badge(pawn(ORANGE, ORANGE_DEEP), ORANGE),
  ludo_gold: badge(pawn(GOLD, GOLD_DEEP), GOLD),

  // — King: gold crown on the blue pawn —
  ludo_king: badge(`${pawn(BLUE, BLUE_DEEP, { headCy: 192 })}
  <path d="M190 132 L206 74 L236 112 L256 60 L276 112 L306 74 L322 132 Z" fill="${GOLD}" stroke="${GOLD_DEEP}" stroke-width="7" stroke-linejoin="round"/>
  <rect x="188" y="124" width="136" height="22" rx="11" fill="${GOLD}" stroke="${GOLD_DEEP}" stroke-width="7"/>
  ${gem(256, 135, 8, RED)}${gem(214, 135, 6, GREEN)}${gem(298, 135, 6, GREEN)}`, GOLD),

  // — Queen: tiara + heart gem on the green pawn —
  ludo_queen: badge(`${pawn(GREEN, GREEN_DEEP, { headCy: 192 })}
  <path d="M196 138 Q256 108 316 138 L316 120 Q296 96 276 116 Q266 84 256 78 Q246 84 236 116 Q216 96 196 120 Z" fill="${GOLD}" stroke="${GOLD_DEEP}" stroke-width="7" stroke-linejoin="round"/>
  <circle cx="256" cy="84" r="10" fill="#fff" stroke="${GOLD_DEEP}" stroke-width="4"/>
  <path d="M256 128 l7 -8 a5.5 5.5 0 0 1 8 7.6 L256 144 l-15 -16.4 a5.5 5.5 0 0 1 8 -7.6 Z" fill="${RED}"/>`, GOLD),

  // — Racer: checkered helmet cap (Race Week) on the orange pawn. The cap ends
  //   ABOVE the eye line (chord y=164 of the head circle) so the face stays clear;
  //   the checker row is clipped to the cap so squares never spill past the curve. —
  ludo_racer: badge(`${pawn(ORANGE, ORANGE_DEEP, { headCy: 192 })}
  <defs><clipPath id="racercap"><path d="M185 164 A76 76 0 0 1 327 164 Z"/></clipPath></defs>
  <path d="M185 164 A76 76 0 0 1 327 164 Z" fill="#fff" stroke="${INK}" stroke-width="7"/>
  <g clip-path="url(#racercap)">
    <rect x="176" y="140" width="24" height="24" fill="${INK}"/><rect x="224" y="140" width="24" height="24" fill="${INK}"/><rect x="272" y="140" width="24" height="24" fill="${INK}"/><rect x="320" y="140" width="24" height="24" fill="${INK}"/>
    <rect x="200" y="116" width="24" height="24" fill="${INK}"/><rect x="248" y="116" width="24" height="24" fill="${INK}"/><rect x="296" y="116" width="24" height="24" fill="${INK}"/>
  </g>
  <rect x="176" y="158" width="160" height="14" rx="7" fill="${ORANGE_DEEP}"/>`, ORANGE),

  // — Wizard: starry hat on the blue pawn —
  ludo_wizard: badge(`${pawn(BLUE, BLUE_DEEP, { headCy: 200 })}
  <path d="M256 30 L322 138 L190 138 Z" fill="${BLUE_DEEP}" stroke="${BLUE_DEEP}" stroke-width="7" stroke-linejoin="round"/>
  <ellipse cx="256" cy="140" rx="92" ry="22" fill="${BLUE_DEEP}"/>
  <path d="M262 84 l5 12 13 1 -10 9 3 13 -11 -7 -11 7 3 -13 -10 -9 13 -1 Z" fill="${GOLD}"/>
  <circle cx="236" cy="118" r="5" fill="${GOLD}"/><circle cx="286" cy="112" r="4" fill="${GOLD}"/>`, BLUE),

  // — Dice: the lucky die itself, gold pips —
  ludo_dice: badge(`
  <ellipse cx="256" cy="420" rx="120" ry="26" fill="${INK}" opacity="0.12"/>
  <rect x="126" y="112" width="260" height="260" rx="56" fill="#fff" stroke="${INK}" stroke-width="9"/>
  <rect x="126" y="112" width="260" height="130" rx="56" fill="${INK}" opacity="0.04"/>
  <circle cx="176" cy="162" r="17" fill="${GOLD}" stroke="${GOLD_DEEP}" stroke-width="5"/>
  <circle cx="336" cy="162" r="17" fill="${GOLD}" stroke="${GOLD_DEEP}" stroke-width="5"/>
  <circle cx="176" cy="322" r="17" fill="${GOLD}" stroke="${GOLD_DEEP}" stroke-width="5"/>
  <circle cx="336" cy="322" r="17" fill="${GOLD}" stroke="${GOLD_DEEP}" stroke-width="5"/>
  ${face(232, 256, 1.05)}
  <ellipse cx="212" cy="386" rx="26" ry="14" fill="${INK}"/>
  <ellipse cx="300" cy="386" rx="26" ry="14" fill="${INK}"/>`, GOLD),

  // — Champion: the golden trophy, alive —
  ludo_champion: badge(`
  <ellipse cx="256" cy="430" rx="96" ry="24" fill="${GOLD_DEEP}" opacity="0.35"/>
  <path d="M150 118 A50 44 0 0 0 214 196" fill="none" stroke="${GOLD}" stroke-width="20" stroke-linecap="round"/>
  <path d="M362 118 A50 44 0 0 1 298 196" fill="none" stroke="${GOLD}" stroke-width="20" stroke-linecap="round"/>
  <path d="M166 96 L346 96 C346 208 310 258 256 258 C202 258 166 208 166 96 Z" fill="${GOLD}" stroke="${GOLD_DEEP}" stroke-width="8"/>
  <rect x="238" y="252" width="36" height="52" fill="${GOLD}" stroke="${GOLD_DEEP}" stroke-width="7"/>
  <rect x="188" y="300" width="136" height="34" rx="12" fill="${GOLD}" stroke="${GOLD_DEEP}" stroke-width="7"/>
  <rect x="170" y="330" width="172" height="44" rx="14" fill="${GOLD_DEEP}"/>
  <ellipse cx="212" cy="122" rx="20" ry="30" fill="#fff" opacity="0.4" transform="rotate(-12 212 122)"/>
  ${face(168, 256, 0.95)}
  <path d="M256 342 l6 12 13 2 -9.5 9 2.5 13 -12 -6.5 -12 6.5 2.5 -13 -9.5 -9 13 -2 Z" fill="${GOLD}"/>`, GOLD),

  // — Star: the win star, alive —
  ludo_star: badge(`
  <path d="M256 44 L312 172 L450 186 L346 278 L378 414 L256 342 L134 414 L166 278 L62 186 L200 172 Z" fill="${GOLD}" stroke="${GOLD_DEEP}" stroke-width="9" stroke-linejoin="round"/>
  <path d="M256 44 L312 172 L450 186 L346 278 L256 254 L166 278 L62 186 L200 172 Z" fill="#fff" opacity="0.12"/>
  ${face(216, 256, 1.05)}`, GOLD),

  // — Pirate: red bandana + eyepatch on the orange pawn. noFace: the patch
  //   replaces the right eye, so the custom face is drawn here instead. —
  ludo_pirate: badge(`${pawn(ORANGE, ORANGE_DEEP, { headCy: 192, noFace: true })}
  <path d="M182 166 A76 76 0 0 1 330 166 Z" fill="${RED}"/>
  <path d="M182 166 A76 76 0 0 1 330 166" fill="none" stroke="${RED_DEEP}" stroke-width="7"/>
  <path d="M326 158 q30 -6 40 14 q-24 2 -30 22 Z" fill="${RED}" stroke="${RED_DEEP}" stroke-width="6" stroke-linejoin="round"/>
  <circle cx="216" cy="144" r="6" fill="#fff" opacity="0.75"/><circle cx="252" cy="132" r="5" fill="#fff" opacity="0.75"/><circle cx="290" cy="142" r="6" fill="#fff" opacity="0.75"/>
  <path d="M198 176 L324 168" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>
  <circle cx="283" cy="184" r="20" fill="${INK}"/>
  <circle cx="229" cy="184" r="17" fill="#fff"/>
  <circle cx="233" cy="188" r="8.5" fill="${INK}"/>
  <circle cx="236" cy="184" r="3" fill="#fff"/>
  <path d="M228 246 Q258 264 284 240" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>
  <circle cx="203" cy="234" r="10" fill="#FF9D76" opacity="0.45"/>`, RED),
};

for (const [id, svg] of Object.entries(AVATARS)) {
  writeFileSync(join(OUT, `${id}.svg`), svg + '\n');
}
console.log(`[avatars] wrote ${Object.keys(AVATARS).length} SVG masters to ${OUT}`);
