/**
 * Ultra-premium avatar frames: illustrated + animated SVG rings drawn as an
 * overlay AROUND any avatar (the basic bronze/silver/gold/neon/champion frames
 * stay as the lighter CSS `avframe` rings). The generator mirrors the cosmetics
 * lab exactly. Rendered via an SVG string (a fixed closed set of ids, never user
 * input) sized to the parent, so it scales to every avatar (corner, sheet, lobby).
 */
export const PREMIUM_FRAME_IDS = ['laurel', 'flame', 'frost', 'circuit', 'royal', 'nebula', 'ruby', 'jade', 'fr-sunburst', 'fr-leopard'] as const;
export type PremiumFrameId = (typeof PREMIUM_FRAME_IDS)[number];

export function isPremiumFrame(id: string | undefined): id is PremiumFrameId {
  return !!id && (PREMIUM_FRAME_IDS as readonly string[]).includes(id);
}

const S = 96;
const c = S / 2;
const DEFS = `
  <radialGradient id="pfGold" cx=".5" cy=".35"><stop offset="0" stop-color="#fff2b0"/><stop offset=".5" stop-color="#f5b301"/><stop offset="1" stop-color="#8a5e05"/></radialGradient>
  <linearGradient id="pfShine" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`;
const SHINE = `<circle cx="${c}" cy="${c}" r="42" fill="none" stroke="url(#pfShine)" stroke-width="3" stroke-dasharray="30 240" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 ${c} ${c}" to="360 ${c} ${c}" dur="3s" repeatCount="indefinite"/></circle>`;

/** SVG markup for a premium frame id (empty for unknown ids). */
export function frameSvg(id: string): string {
  if (id === 'laurel') {
    let leaves = '';
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const x = c + Math.cos(a) * 42, y = c + Math.sin(a) * 42;
      leaves += `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="7" ry="3.2" fill="url(#pfGold)" transform="rotate(${(a * 180 / Math.PI + 90).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
    }
    return svg(`<defs>${DEFS}</defs>${leaves}<circle cx="${c}" cy="${c}" r="42" fill="none" stroke="url(#pfGold)" stroke-width="3.5"/>${SHINE}<circle cx="${c}" cy="16" r="5" fill="#ff5b7f" stroke="#fff" stroke-width="1"/>`);
  }
  if (id === 'flame') {
    let f = '';
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const x = c + Math.cos(a) * 44, y = c + Math.sin(a) * 44;
      const h = 8 + 6 * Math.sin(i * 1.7);
      f += `<path d="M${x.toFixed(1)} ${y.toFixed(1)} q ${(Math.cos(a) * h).toFixed(1)} ${(Math.sin(a) * h).toFixed(1)} 0 ${(h * 1.4).toFixed(1)}" stroke="#ff7a2e" stroke-width="6" fill="none" stroke-linecap="round" opacity=".9" transform="rotate(${(a * 180 / Math.PI).toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})"><animate attributeName="opacity" values=".5;1;.5" dur="${(0.7 + (i % 3) * 0.2).toFixed(1)}s" repeatCount="indefinite"/></path>`;
    }
    return svg(`<g>${f}</g><circle cx="${c}" cy="${c}" r="41" fill="none" stroke="#ffb14e" stroke-width="3"/><circle cx="${c}" cy="${c}" r="46" fill="none" stroke="#ff3c2e" stroke-width="2" opacity=".5"/>`);
  }
  if (id === 'frost') {
    let sh = '';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const x = c + Math.cos(a) * 42, y = c + Math.sin(a) * 42;
      sh += `<path d="M${x.toFixed(1)} ${y.toFixed(1)} l ${(Math.cos(a) * 8).toFixed(1)} ${(Math.sin(a) * 8).toFixed(1)}" stroke="#dff6ff" stroke-width="3" stroke-linecap="round"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4" fill="#bfefff"/>`;
    }
    return svg(`<circle cx="${c}" cy="${c}" r="42" fill="none" stroke="#8fd8ff" stroke-width="3.5"/>${sh}<circle cx="${c}" cy="${c}" r="42" fill="none" stroke="#eafcff" stroke-width="1.2" stroke-dasharray="2 6"><animateTransform attributeName="transform" type="rotate" from="0 ${c} ${c}" to="360 ${c} ${c}" dur="14s" repeatCount="indefinite"/></circle>`);
  }
  if (id === 'circuit') {
    let seg = '';
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2, a2 = ((i + 0.6) / 16) * Math.PI * 2;
      seg += `<path d="M${(c + Math.cos(a) * 43).toFixed(1)} ${(c + Math.sin(a) * 43).toFixed(1)} A43 43 0 0 1 ${(c + Math.cos(a2) * 43).toFixed(1)} ${(c + Math.sin(a2) * 43).toFixed(1)}" stroke="#39f6d2" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="${(c + Math.cos(a) * 43).toFixed(1)}" cy="${(c + Math.sin(a) * 43).toFixed(1)}" r="2.6" fill="#0affc0"/>`;
    }
    return svg(`<g style="filter:drop-shadow(0 0 4px #39f6d2)"><circle cx="${c}" cy="${c}" r="43" fill="none" stroke="#0e6f63" stroke-width="6"/>${seg}</g><circle cx="${c}" cy="${c}" r="43" fill="none" stroke="#39f6d2" stroke-width="1" stroke-dasharray="4 14"><animateTransform attributeName="transform" type="rotate" from="0 ${c} ${c}" to="360 ${c} ${c}" dur="6s" repeatCount="indefinite"/></circle>`);
  }
  if (id === 'royal') {
    let gems = '';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const x = c + Math.cos(a) * 42, y = c + Math.sin(a) * 42;
      gems += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="#b06ef7" stroke="#ffe27a" stroke-width="1.2"/>`;
    }
    return svg(`<defs>${DEFS}</defs><circle cx="${c}" cy="${c}" r="42" fill="none" stroke="url(#pfGold)" stroke-width="5"/><circle cx="${c}" cy="${c}" r="47" fill="none" stroke="#5b2bbf" stroke-width="2" opacity=".7"/>${gems}<path d="M${c - 9} 14 l4 -7 l5 5 l5 -5 l5 5 l5 -5 l4 7 z" fill="url(#pfGold)" stroke="#7a5300" stroke-width=".6"/>${SHINE}`);
  }
  if (id === 'nebula') {
    let st = '';
    for (let i = 0; i < 14; i++) {
      const ang = (i / 14) * Math.PI * 2 + 0.3;
      const rr = 38 + 8 * Math.sin(i * 2.1);
      const x = c + Math.cos(ang) * rr, y = c + Math.sin(ang) * rr;
      st += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${1 + (i % 3)}" fill="#cbb8ff"><animate attributeName="opacity" values=".3;1;.3" dur="${(1.5 + (i % 4) * 0.5).toFixed(1)}s" repeatCount="indefinite"/></circle>`;
    }
    return svg(`<circle cx="${c}" cy="${c}" r="43" fill="none" stroke="#6a5be0" stroke-width="4"/><circle cx="${c}" cy="${c}" r="43" fill="none" stroke="#c56aff" stroke-width="1.5" opacity=".6"/><g><animateTransform attributeName="transform" type="rotate" from="0 ${c} ${c}" to="360 ${c} ${c}" dur="20s" repeatCount="indefinite"/>${st}</g>`);
  }
  if (id === 'fr-sunburst') {
    // Shop-only (cosmetics phase 2): a slowly-rotating golden ray crown.
    let rays = '';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const x1 = c + Math.cos(a) * 38, y1 = c + Math.sin(a) * 38;
      const x2 = c + Math.cos(a) * (i % 2 ? 46 : 48), y2 = c + Math.sin(a) * (i % 2 ? 46 : 48);
      rays += `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="url(#pfGold)" stroke-width="${i % 2 ? 3 : 5}" stroke-linecap="round"/>`;
    }
    return svg(`<defs>${DEFS}</defs><g><animateTransform attributeName="transform" type="rotate" from="0 ${c} ${c}" to="360 ${c} ${c}" dur="16s" repeatCount="indefinite"/>${rays}</g><circle cx="${c}" cy="${c}" r="38" fill="none" stroke="url(#pfGold)" stroke-width="4"/>${SHINE}`);
  }
  if (id === 'fr-leopard') {
    // Shop-only (cosmetics phase 2): leopard-spot ring with a slow shimmer.
    let spots = '';
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + (i % 2 ? 0.11 : 0);
      const rr = 42 + (i % 3 === 0 ? 2.4 : -1.6);
      const x = c + Math.cos(a) * rr, y = c + Math.sin(a) * rr;
      spots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(2.2 + (i % 3)).toFixed(1)}" fill="#2a1c0e" opacity=".92"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(1 + (i % 3) * 0.6).toFixed(1)}" fill="#c98a3b"/>`;
    }
    return svg(`<circle cx="${c}" cy="${c}" r="42" fill="none" stroke="#e8b96a" stroke-width="8"/>${spots}<circle cx="${c}" cy="${c}" r="42" fill="none" stroke="url(#pfShine)" stroke-width="8" stroke-dasharray="26 260" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 ${c} ${c}" to="360 ${c} ${c}" dur="4.5s" repeatCount="indefinite"/></circle><defs>${DEFS}</defs>`);
  }
  if (id === 'ruby' || id === 'jade') {
    const col = id === 'ruby' ? ['#ffd0d8', '#ff4d6d', '#8a1030'] : ['#c4ffe0', '#3ddc97', '#0f7a4a'];
    let facet = '';
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2, a2 = ((i + 1) / 16) * Math.PI * 2;
      facet += `<path d="M${c} ${c} L${(c + Math.cos(a) * 45).toFixed(1)} ${(c + Math.sin(a) * 45).toFixed(1)} L${(c + Math.cos(a2) * 45).toFixed(1)} ${(c + Math.sin(a2) * 45).toFixed(1)} Z" fill="${i % 2 ? col[1] : col[2]}" opacity="${i % 2 ? '.9' : '.6'}"/>`;
    }
    return svg(`<mask id="pfm${id}"><rect width="${S}" height="${S}" fill="#000"/><circle cx="${c}" cy="${c}" r="46" fill="#fff"/><circle cx="${c}" cy="${c}" r="34" fill="#000"/></mask><g mask="url(#pfm${id})">${facet}</g><circle cx="${c}" cy="${c}" r="45" fill="none" stroke="${col[0]}" stroke-width="1.5"/><circle cx="${c}" cy="${c}" r="35" fill="none" stroke="${col[0]}" stroke-width="1" opacity=".7"/>`);
  }
  return '';
}

function svg(inner: string): string {
  return `<svg viewBox="0 0 ${S} ${S}" width="100%" height="100%" aria-hidden="true">${inner}</svg>`;
}

/** Overlay ring for a premium frame id; renders nothing for basic/none ids. */
export function PremiumFrame({ frame }: { frame: string | undefined }) {
  if (!isPremiumFrame(frame)) return null;
  return <span className="framesvg" aria-hidden="true" dangerouslySetInnerHTML={{ __html: frameSvg(frame) }} />;
}
