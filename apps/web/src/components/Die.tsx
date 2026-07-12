/** Shared skinnable SVG die face (game screen + skin picker previews). */
import type { DiceSkin } from '../lib/diceSkins';

const PIPS: Record<number, Array<[number, number]>> = {
  1: [[50, 50]],
  2: [[31, 31], [69, 69]],
  3: [[29, 29], [50, 50], [71, 71]],
  4: [[31, 31], [69, 31], [31, 69], [69, 69]],
  5: [[31, 31], [69, 31], [50, 50], [31, 69], [69, 69]],
  6: [[31, 27], [69, 27], [31, 50], [69, 50], [31, 73], [69, 73]],
};

export function DieFace({ value, skin }: { value: number; skin: DiceSkin }) {
  const gid = `dg-${skin.id}`;
  return (
    <svg viewBox="0 0 100 100" className="die" aria-label={`die ${value}`}>
      <defs>
        <radialGradient id={gid} cx="32%" cy="26%" r="95%">
          <stop offset="0%" stopColor={skin.body1} />
          <stop offset="100%" stopColor={skin.body2} />
        </radialGradient>
      </defs>
      {skin.glow && <rect x={2} y={2} width={96} height={96} rx={26} fill={skin.glow} opacity={0.6} />}
      <rect x={5} y={7} width={90} height={90} rx={22} fill="rgba(0,0,0,.3)" />
      <rect x={5} y={5} width={90} height={90} rx={22} fill={`url(#${gid})`} stroke={skin.stroke} strokeWidth={2} />
      <rect x={9} y={8} width={82} height={38} rx={19} fill="#ffffff" opacity={0.22} />
      {(PIPS[value] ?? []).map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={8.5} fill={skin.pip} />
      ))}
    </svg>
  );
}
