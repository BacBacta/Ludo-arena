/**
 * Shared cosmetic-effect overlays (phases 1-2, extended to the 4-player board):
 *  - EntranceFxOverlay: emoji bursts at match start — MINE rises from the
 *    bottom, every OPPONENT's falls from the top; all visible to everyone
 *    (that's the point). Plays once per gameId, honours reduced-motion via CSS.
 *  - VictoryFxOverlay: the WINNER's flourish on an end screen, seen by both/all
 *    players (mine if I won, the winner's relayed id otherwise).
 */
import { useEffect, useState } from 'react';
import { entranceFxById, victoryFxById } from '../lib/tokenSkins';

export function EntranceFxOverlay({ mine, others, gameId }: { mine?: string; others?: ReadonlyArray<string | undefined>; gameId: string }) {
  const [playedFor, setPlayedFor] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (playedFor === gameId) return;
    setPlayedFor(gameId);
    setVisible(true);
    const id = setTimeout(() => setVisible(false), 1700);
    return () => clearTimeout(id);
  }, [gameId, playedFor]);
  if (!visible) return null;
  const my = entranceFxById(mine).particles;
  // Interleave every opponent's particles into one falling stream (up to 3 in 4p).
  const th = (others ?? []).flatMap((o) => entranceFxById(o).particles);
  if (my.length === 0 && th.length === 0) return null;
  return (
    <div className="entrancefx" aria-hidden="true">
      {my.map((p, i) => (
        <span key={`m${i}`} className="entrancefx__p entrancefx__p--up" style={{ left: `${8 + i * 11}%`, animationDelay: `${i * 0.07}s` }}>{p}</span>
      ))}
      {th.slice(0, 10).map((p, i) => (
        <span key={`t${i}`} className="entrancefx__p entrancefx__p--down" style={{ left: `${8 + (i % 8) * 11}%`, animationDelay: `${i * 0.07}s` }}>{p}</span>
      ))}
    </div>
  );
}

export function VictoryFxOverlay({ fxId }: { fxId?: string }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const id = setTimeout(() => setVisible(false), 2600);
    return () => clearTimeout(id);
  }, []);
  const particles = victoryFxById(fxId).particles;
  if (!visible || particles.length === 0) return null;
  return (
    <div className="victoryfx" aria-hidden="true">
      {particles.map((p, i) => (
        <span
          key={i}
          className="victoryfx__p"
          style={{ left: `${5 + i * 10}%`, animationDelay: `${i * 0.12}s`, fontSize: `${26 + (i % 3) * 8}px` }}
        >
          {p}
        </span>
      ))}
    </div>
  );
}
