/** In-game expressions: a toggle button revealing the emoji row + quick-chat
 *  pills, and a floating reaction over a player's avatar when they express.
 *  Emojis get a per-emote animation + sound signature; quick-chats render as a
 *  localized speech bubble. Both travel the same throttled game.emote channel. */
import { useEffect, useState } from 'react';
import { EMOTES, GIFTS, QUICK_CHATS, isQuickChat, type QuickChat } from '@ludo/shared';
import { useAppState } from '../state/store';
import { playEmote, playGift, playTap } from '../lib/sound';
import { t, type TKey } from '../lib/i18n';

/** Someone a gift can be directed at (an opponent seat + how to name them). */
export interface GiftTarget {
  seat: number;
  name: string;
  flag?: string;
}

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

/** The gift sender: a 🎁 toggle opening a grid of sendable treats (coffee, rose,
 *  cake…) directed at a chosen opponent. One opponent (1v1) → the recipient is
 *  implicit; several (4-player) → a chip row picks who receives it. The cooldown
 *  matches the server's per-seat gift throttle. */
export function GiftBar({
  recipients,
  onGift,
  dir = 'up',
}: {
  recipients: GiftTarget[];
  onGift(to: number, id: string): void;
  dir?: 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const target = recipients.some((r) => r.seat === picked) ? picked : recipients[0]?.seat ?? null;
  const send = (id: string): void => {
    if (cooling || target === null) return;
    playTap();
    if (typeof navigator !== 'undefined') navigator.vibrate?.(20); // playful haptic (works when muted)
    onGift(target, id);
    setOpen(false);
    setCooling(true);
    setTimeout(() => setCooling(false), 1500);
  };
  if (recipients.length === 0) return null;
  return (
    <div className={`giftbar emotebar--${dir}`}>
      {open && (
        <div className="giftbar__sheet" role="menu">
          {recipients.length > 1 && (
            <div className="giftbar__to">
              {recipients.map((r) => (
                <button
                  key={r.seat}
                  className={`giftbar__toc${r.seat === target ? ' is-sel' : ''}`}
                  onClick={() => setPicked(r.seat)}
                  aria-pressed={r.seat === target}
                >
                  <span className="giftbar__toflag">{r.flag ?? '🌍'}</span>
                  <span className="giftbar__toname">{r.name}</span>
                </button>
              ))}
            </div>
          )}
          <div className="giftbar__grid">
            {GIFTS.map((g) => (
              <button key={g} className="giftbar__g" onClick={() => send(g)} aria-label={`${t('gift')} ${g}`}>
                {g}
              </button>
            ))}
          </div>
        </div>
      )}
      <button className="giftbar__toggle" aria-label={t('gift')} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        🎁
      </button>
    </div>
  );
}

/** Floating gift over a seat's avatar. `gifts[seat].n` bumps on each received
 *  gift → re-keying the span replays the drop-in animation; the same bump plays
 *  the gift chime (mine and theirs, like the emote channel). */
export function GiftFloat({ seat, dir = 'up' }: { seat: number; dir?: 'up' | 'down' }) {
  const { gifts } = useAppState();
  const g = gifts[seat];
  useEffect(() => {
    if (g) playGift(g.id);
  }, [g]);
  if (!g) return null;
  // `dir` launches the gift TOWARD the recipient: from the top (opponent) corner
  // it flies down toward you; from your corner it flies up toward them. The gift
  // is anchored on the SENDER's corner, so this reads as "sent from X to Y".
  return (
    <span key={g.n} className={`giftfloat giftfloat--${dir}`} aria-hidden="true">
      <span className="giftin">{g.id}</span>
    </span>
  );
}
