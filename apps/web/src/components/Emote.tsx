/** In-game expressions: a toggle button revealing the emoji row + quick-chat
 *  pills, and a floating reaction over a player's avatar when they express.
 *  Emojis get a per-emote animation + sound signature; quick-chats render as a
 *  localized speech bubble. Both travel the same throttled game.emote channel. */
import { useEffect, useRef, useState } from 'react';
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

/**
 * A single gift-flight overlay: when a gift is sent, it flies from the SENDER's
 * tile to the RECIPIENT's, arcing across the board — so it's unmistakable who
 * sent it and to whom. Mount ONE per game screen inside the positioned wrapper;
 * it locates the two seats via `[data-seat-anchor="<seat>"]` and animates a
 * flying emoji between their measured positions (works for 1v1 and 4p alike).
 */
export function GiftFlight({ anchor = '.gamewrap' }: { anchor?: string }) {
  const { giftFlight } = useAppState();
  const lastN = useRef(0);
  const [fly, setFly] = useState<{ id: string; n: number; style: React.CSSProperties } | null>(null);

  useEffect(() => {
    if (!giftFlight || giftFlight.n === lastN.current) return;
    lastN.current = giftFlight.n;
    playGift(giftFlight.id);
    const root = document.querySelector(anchor) as HTMLElement | null;
    const fromEl = root?.querySelector(`[data-seat-anchor="${giftFlight.from}"]`);
    const toEl = root?.querySelector(`[data-seat-anchor="${giftFlight.to}"]`);
    if (!root || !fromEl || !toEl) return; // nothing to fly between (e.g. laid out oddly)
    const R = root.getBoundingClientRect();
    const f = fromEl.getBoundingClientRect();
    const tt = toEl.getBoundingClientRect();
    const centre = (r: DOMRect, axis: 'x' | 'y') =>
      axis === 'x' ? r.left + r.width / 2 - R.left : r.top + r.height / 2 - R.top;
    const style = {
      ['--fx']: `${centre(f, 'x')}px`,
      ['--fy']: `${centre(f, 'y')}px`,
      ['--tx']: `${centre(tt, 'x')}px`,
      ['--ty']: `${centre(tt, 'y')}px`,
    } as unknown as React.CSSProperties;
    setFly({ id: giftFlight.id, n: giftFlight.n, style });
  }, [giftFlight, anchor]);

  if (!fly) return null;
  return (
    <div className="giftflight-layer" aria-hidden="true">
      <span key={fly.n} className="giftflight" style={fly.style} onAnimationEnd={() => setFly(null)}>
        {fly.id}
      </span>
    </div>
  );
}
