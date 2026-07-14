/** In-game expressions: a toggle button revealing the emoji row + quick-chat
 *  pills, and a floating reaction over a player's avatar when they express.
 *  Emojis get a per-emote animation + sound signature; quick-chats render as a
 *  localized speech bubble. Both travel the same throttled game.emote channel. */
import { useEffect, useState } from 'react';
import { EMOTES, QUICK_CHATS, isQuickChat, type QuickChat } from '@ludo/shared';
import { useAppState } from '../state/store';
import { playEmote, playTap } from '../lib/sound';
import { t, type TKey } from '../lib/i18n';

/** Localized label for a quick-chat id (closed set → closed key map). */
const QC_KEY: Record<QuickChat, TKey> = {
  gg: 'qcGg',
  ouch: 'qcOuch',
  hurry: 'qcHurry',
  rematch: 'qcRematch',
  gl: 'qcGl',
  wow: 'qcWow',
};

/** Per-emote entrance animation (the outer float handles rise-and-fade). */
const EMOTE_ANIM: Record<string, string> = {
  '👍': 'pop',
  '😂': 'laugh',
  '😮': 'gasp',
  '😢': 'sad',
  '🔥': 'blaze',
  '💪': 'pump',
  '🍀': 'spin',
  '🎲': 'bounce',
  '😎': 'pop',
  '🎉': 'bounce',
  '👏': 'pump',
  '🤯': 'gasp',
};

/** The expression sender: a 😊 toggle that opens the emoji row + quick-chat
 *  pills (popping up by default, or down when the bar sits at the top of the
 *  screen). Client-side cooldown matches the server's per-seat throttle. */
export function EmoteBar({ onEmote, dir = 'up' }: { onEmote(id: string): void; dir?: 'up' | 'down' }) {
  const [open, setOpen] = useState(false);
  const [cooling, setCooling] = useState(false);
  const send = (id: string): void => {
    if (cooling) return;
    playTap();
    if (typeof navigator !== 'undefined') navigator.vibrate?.(20); // playful haptic (works when muted)
    onEmote(id);
    setOpen(false);
    setCooling(true);
    setTimeout(() => setCooling(false), 1200);
  };
  return (
    <div className={`emotebar emotebar--${dir}`}>
      {open && (
        <div className="emotebar__sheet" role="menu">
          <div className="emotebar__row">
            {EMOTES.map((e) => (
              <button key={e} className="emotebar__e" onClick={() => send(e)} aria-label={`Emote ${e}`}>
                {e}
              </button>
            ))}
          </div>
          <div className="emotebar__row emotebar__row--chat">
            {QUICK_CHATS.map((c) => (
              <button key={c} className="emotebar__qc" onClick={() => send(c)}>
                {t(QC_KEY[c])}
              </button>
            ))}
          </div>
        </div>
      )}
      <button className="emotebar__toggle" aria-label={t('emote')} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        😊
      </button>
    </div>
  );
}

/** Floating reaction over a seat's avatar. `emotes[seat].n` bumps on each
 *  expression, so re-keying remounts the span and replays the animation; the
 *  same bump triggers this expression's sound signature (mine and theirs). */
export function EmoteFloat({ seat }: { seat: number }) {
  const { emotes } = useAppState();
  const e = emotes[seat];
  useEffect(() => {
    if (e) playEmote(e.id);
  }, [e]);
  if (!e) return null;
  if (isQuickChat(e.id)) {
    return (
      <span key={e.n} className="emotefloat emotefloat--chat" aria-hidden="true">
        {t(QC_KEY[e.id])}
      </span>
    );
  }
  return (
    <span key={e.n} className="emotefloat" aria-hidden="true">
      <span className={`emotein emotein--${EMOTE_ANIM[e.id] ?? 'pop'}`}>{e.id}</span>
    </span>
  );
}
