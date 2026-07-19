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

/** Ludo Club uses one WHITE die with black pips for everyone; the active player
 *  is identified by the die's POSITION at their corner, not by colour. */
export const WHITE_DIE: DiceSkin = {
  id: 'ludo-white',
  name: '',
  unlocked: () => true,
  body1: '#ffffff',
  body2: '#eef0f5',
  pip: '#161b28',
  stroke: '#c7cdd9',
};

/** Grey placeholder avatar tile at a board corner; the active seat lifts slightly.
 *  A chosen 3D avatar takes precedence over the flag. */
export function SeatAvatar({ name, flag, frame, avatar, active }: { name: string; flag?: string; frame?: string; avatar?: string; active: boolean }) {
  const src = avatarSrc(avatar);
  const premium = isPremiumFrame(frame);
  // A premium frame turns the tile circular so the ornamental ring fits snugly.
  const tile = (
    <div className={`seatav${active ? ' seatav--active' : ''}${premium ? ' seatav--circ' : ''} ${frameRing(frame)}`} aria-label={name}>
      {src ? (
        <img className="seatav__img" src={src} alt="" />
      ) : flag ? (
        <span className="seatav__flag">{flag}</span>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx={12} cy={9} r={4.4} fill="#aab6c9" />
          <path d="M3.5 21c1.4-4 5-6 8.5-6s7.1 2 8.5 6z" fill="#aab6c9" />
        </svg>
      )}
    </div>
  );
  // The frame overlay lives OUTSIDE the tile (which clips its content) so the
  // ornamental ring is never cut off by the tile's overflow.
  if (!premium) return tile;
  return (
    <span className="seatav-framed">
      {tile}
      <PremiumFrame frame={frame} />
    </span>
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
