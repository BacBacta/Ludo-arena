/** Shared skinnable SVG die face (game screen + skin picker previews).
 *  Premium skins (with a `material`) get a richer static face — metallic sheen,
 *  gem facets, or glowing edges/pips — so they read as premium even in the small
 *  picker where the full WebGL die isn't rendered. */
import type { DiceSkin } from '../lib/diceSkins';

const PIPS: Record<number, Array<[number, number]>> = {
  1: [[50, 50]],
  2: [[31, 31], [69, 69]],
  3: [[29, 29], [50, 50], [71, 71]],
  4: [[31, 31], [69, 31], [31, 69], [69, 69]],
  5: [[31, 31], [69, 31], [50, 50], [31, 69], [69, 69]],
  6: [[31, 27], [69, 27], [31, 50], [69, 50], [31, 73], [69, 73]],
};

/** Materials whose pips glow (emissive look) rather than sit as flat ink. */
const GLOW_PIP = new Set(['glass', 'cyber', 'molten']);

export function DieFace({ value, skin }: { value: number; skin: DiceSkin }) {
  const gid = `dg-${skin.id}`;
  const glowPip = skin.material ? GLOW_PIP.has(skin.material) : false;
  const metal = skin.material === 'metal';
  const gem = skin.material === 'gem';
  return (
    <svg viewBox="0 0 100 100" className="die" aria-label={`die ${value}`}>
      <defs>
        <radialGradient id={gid} cx="32%" cy="26%" r="95%">
          <stop offset="0%" stopColor={skin.body1} />
          <stop offset="100%" stopColor={skin.body2} />
        </radialGradient>
        {metal && (
          <linearGradient id={`${gid}-sheen`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
            <stop offset="44%" stopColor="#ffffff" stopOpacity="0.6" />
            <stop offset="54%" stopColor="#ffffff" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
        )}
        {glowPip && (
          <filter id={`${gid}-glow`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="2.2" />
          </filter>
        )}
      </defs>
      {skin.glow && <rect x={2} y={2} width={96} height={96} rx={26} fill={skin.glow} opacity={0.6} />}
      <rect x={5} y={7} width={90} height={90} rx={22} fill="rgba(0,0,0,.3)" />
      <rect x={5} y={5} width={90} height={90} rx={22} fill={`url(#${gid})`} stroke={skin.stroke} strokeWidth={2} />
      {metal && <rect x={5} y={5} width={90} height={90} rx={22} fill={`url(#${gid}-sheen)`} />}
      {gem && (
        <>
          <path d="M5 42 L50 9 L95 42 L50 30 Z" fill="rgba(255,255,255,.28)" />
          <path d="M22 95 L50 56 L78 95 Z" fill="rgba(120,200,255,.18)" />
        </>
      )}
      {/* premium skins get a brighter inner bevel; the classic look keeps its gloss bar */}
      {skin.material ? (
        <rect x={8} y={8} width={84} height={84} rx={18} fill="none" stroke="rgba(255,255,255,.4)" strokeWidth={1.3} />
      ) : (
        <rect x={9} y={8} width={82} height={38} rx={19} fill="#ffffff" opacity={0.22} />
      )}
      {(PIPS[value] ?? []).map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={8.5} fill={skin.pip} filter={glowPip ? `url(#${gid}-glow)` : undefined} />
      ))}
    </svg>
  );
}
