/**
 * Smart die: renders the ultra-premium WebGL die (real PBR material + roll sound)
 * for skins that declare a `material`, and the lightweight CSS `Die3D` for every
 * other skin. The WebGL engine is code-split and lazy-imported, and while it
 * loads (or if WebGL is unavailable) the CSS die shows through — so a die is
 * always visible and the app never blanks on a 3D failure.
 */
import { useEffect, useRef, useState } from 'react';
import { Die3D, type Die3DProps } from './Die3D';
import type { DieEngine } from './diceEngine';

/** Dispatch on the skin: premium material → WebGL; otherwise the CSS die. */
export function Die(props: Die3DProps) {
  return props.skin.material ? <DiePremium3D {...props} /> : <Die3D {...props} />;
}

function DiePremium3D({ value, rollKey, skin, spinning }: Die3DProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<DieEngine | null>(null);
  const [ready, setReady] = useState(false);
  // Latest props for the async engine creation (avoids stale closures).
  const skinRef = useRef(skin);
  skinRef.current = skin;
  const valueRef = useRef(value);
  valueRef.current = value;
  const lastRoll = useRef(rollKey);

  // Create the WebGL engine once; fall back silently to the CSS die on failure.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (!hostRef.current) return;
        const mod = await import('./diceEngine');
        if (!alive || !hostRef.current) return;
        engineRef.current = mod.createDieEngine(hostRef.current, skinRef.current, valueRef.current);
        setReady(true);
      } catch {
        /* WebGL unavailable / chunk failed → the CSS fallback keeps showing */
      }
    })();
    return () => {
      alive = false;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  // Roll (tumble) when a fresh roll arrives; seat quietly on a value-only change.
  useEffect(() => {
    // Engine still loading: the CSS fallback is showing and animates the roll.
    // Crucially do NOT advance lastRoll here — otherwise a roll that lands DURING
    // the WebGL chunk load is "consumed", so when the engine becomes ready it sees
    // rollKey === lastRoll and seats on the value WITHOUT tumbling. That made the
    // FIRST roll(s) of a game just pop to the result on premium (WebGL) skins,
    // while the bot's CSS die tumbled fine. Leaving lastRoll untouched lets the
    // engine tumble the pending roll the moment it comes up.
    if (!ready || !engineRef.current) return;
    const tumble = rollKey !== 0 && rollKey !== lastRoll.current;
    lastRoll.current = rollKey;
    engineRef.current.roll(value, tumble);
  }, [rollKey, value, ready]);

  // Optimistic in-flight spin (online RTT): the WebGL die used to IGNORE
  // `spinning` — it sat frozen through the round-trip, then stacked a full
  // tumble on top when the value landed, leaving the number readable for only
  // ~150ms before the auto-move pulled the turn away. Now it winds through the
  // RTT like the CSS die and roll() lands with the short settle instead.
  // Declared AFTER the roll effect: on the commit where the value arrives
  // (spinning→false + rollKey bump together), roll() consumes the spin first
  // and this call becomes a no-op — the engine's fallback settle only fires
  // when a spin ends with NO roll (cleared intent / server error).
  useEffect(() => {
    if (!ready || !engineRef.current) return;
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    engineRef.current.setSpinning(!!spinning && !reduce);
  }, [spinning, ready]);

  // Re-material on skin swap (keyed on the stable id, not the object identity).
  useEffect(() => {
    if (ready) engineRef.current?.setSkin(skin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skin.id, ready]);

  return (
    <div className="die3d-stage diepremium">
      <div ref={hostRef} className="diepremium__host" style={{ opacity: ready ? 1 : 0 }} />
      {!ready && (
        <div className="diepremium__fallback">
          <Die3D value={value} rollKey={rollKey} skin={skin} spinning={spinning} />
        </div>
      )}
    </div>
  );
}
