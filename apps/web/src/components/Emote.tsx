/** In-game quick emotes: a toggle button that reveals a fixed emoji row, and a
 *  floating emoji that pops over a player's avatar when they emote. */
import { useState } from 'react';
import { EMOTES } from '@ludo/shared';
import { useAppState } from '../state/store';
import { playTap } from '../lib/sound';
import { t } from '../lib/i18n';

/** The emote sender: a 😊 toggle that opens the fixed emote row (popping up by
 *  default, or down when the bar sits at the top of the screen). Client-side
 *  cooldown matches the server's per-seat throttle. */
export function EmoteBar({ onEmote, dir = 'up' }: { onEmote(id: string): void; dir?: 'up' | 'down' }) {
  const [open, setOpen] = useState(false);
  const [cooling, setCooling] = useState(false);
  const send = (id: string): void => {
    if (cooling) return;
    playTap();
    onEmote(id);
    setOpen(false);
    setCooling(true);
    setTimeout(() => setCooling(false), 1200);
  };
  return (
    <div className={`emotebar emotebar--${dir}`}>
      {open && (
        <div className="emotebar__row" role="menu">
          {EMOTES.map((e) => (
            <button key={e} className="emotebar__e" onClick={() => send(e)} aria-label={`Emote ${e}`}>
              {e}
            </button>
          ))}
        </div>
      )}
      <button className="emotebar__toggle" aria-label={t('emote')} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        😊
      </button>
    </div>
  );
}

/** Floating emoji over a seat's avatar. `emotes[seat].n` bumps on each emote, so
 *  re-keying the span remounts it and replays the rise-and-fade animation. */
export function EmoteFloat({ seat }: { seat: number }) {
  const { emotes } = useAppState();
  const e = emotes[seat];
  if (!e) return null;
  return (
    <span key={e.n} className="emotefloat" aria-hidden="true">
      {e.id}
    </span>
  );
}
