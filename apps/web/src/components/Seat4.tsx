/**
 * Shared 4-player seat chrome — the grey corner avatar and the white Ludo-Club
 * die shown beside it. Used by both the local practice screen (Game4Screen) and
 * the online Sit&Go screen (Game4OnlineScreen) so the two look identical.
 */
import { Die } from './DiePremium';
import type { DiceSkin } from '../lib/diceSkins';
import { frameRing } from '../lib/avatarFrames';
import { avatarSrc } from '../lib/avatars';
import { PremiumFrame, isPremiumFrame } from './PremiumFrame';

/** The shared table die. Organic pass: paper with sage pips, matching the free
 *  `classic` skin — a pure-white cube with black pips punched a hole in a board
 *  whose lightest paper is #fffdf8. A seat that owns a premium skin still passes
 *  it, so the flagship dice are seen at every corner. */
export const WHITE_DIE: DiceSkin = {
  id: 'ludo-white',
  name: '',
  unlocked: () => true,
  body1: '#fffdf8',
  body2: '#efe2cb',
  pip: '#7a8a5e',
  stroke: 'rgba(32,30,29,.10)',
};

/**
 * Seat chip (design 1d): a paper pill carrying a disc in the seat's own colour
 * with the player's initial, their name, and — while it is their turn — a
 * pulsing dot. The local player's chip is inverted onto the dark surface, which
 * is what makes "which one am I" answerable at a glance.
 */
export function SeatAvatar({
  name,
  flag,
  frame,
  avatar,
  active,
  color,
  onColor,
  you,
}: {
  name: string;
  flag?: string;
  frame?: string;
  avatar?: string;
  active: boolean;
  /** The seat's canonical colour (SEAT_HEX). */
  color: string;
  /** Ink that stays legible on top of `color` (SEAT_ON_HEX). */
  onColor: string;
  you?: boolean;
}) {
  const src = avatarSrc(avatar);
  const premium = isPremiumFrame(frame);
  const disc = (
    <span className={`seatchip__disc ${frameRing(frame)}`} style={{ background: color, color: onColor }} aria-hidden="true">
      {src ? <img className="seatchip__img" src={src} alt="" /> : flag ? flag : name.slice(0, 1).toUpperCase()}
    </span>
  );
  return (
    <div className={`seatchip${active ? ' seatchip--active' : ''}${you ? ' seatchip--you' : ''}`} aria-label={name}>
      {premium ? (
        <span className="seatchip__framed">
          {disc}
          <PremiumFrame frame={frame} />
        </span>
      ) : (
        disc
      )}
      <span className="seatchip__name">{name}</span>
      {active && <span className="seatchip__dot" aria-hidden="true" />}
    </div>
  );
}

/** 3D cube die shown beside a player's avatar; it somersaults on each new roll
 *  (rollKey) and lands on the value. `skin` defaults to the white Ludo-Club die
 *  (bots / no cosmetic), but each seat can pass its RELAYED skin so a premium
 *  die is seen at every corner — the smart Die renders WebGL materials when set. */
export function SeatDie({ value, rollKey, idle = false, skin = WHITE_DIE }: { value: number; rollKey: number; idle?: boolean; skin?: DiceSkin }) {
  // `idle` hides via CSS instead of the caller unmounting: the die animates with
  // a CSS/WebGL transition, and a freshly-mounted element can't transition —
  // swapping the die in at roll time skipped the tumble (the value just popped in).
  return (
    <div className={`ludodie${idle ? ' ludodie--idle' : ''}`} aria-hidden={idle}>
      <Die value={value} rollKey={rollKey} skin={skin} />
    </div>
  );
}
