/**
 * Shared 4-player seat chrome — the grey corner avatar and the white Ludo-Club
 * die shown beside it. Used by both the local practice screen (Game4Screen) and
 * the online Sit&Go screen (Game4OnlineScreen) so the two look identical.
 */
import { Die3D } from './Die3D';
import type { DiceSkin } from '../lib/diceSkins';
import { frameRing } from '../lib/avatarFrames';
import { avatarSrc } from '../lib/avatars';

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
  return (
    <div className={`seatav${active ? ' seatav--active' : ''} ${frameRing(frame)}`} aria-label={name}>
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
}

/** White 3D cube die shown beside a player's avatar; it somersaults on each new
 *  roll (rollKey) and lands on the value. */
export function SeatDie({ value, rollKey }: { value: number; rollKey: number }) {
  return (
    <div className="ludodie">
      <Die3D value={value} rollKey={rollKey} skin={WHITE_DIE} />
    </div>
  );
}
