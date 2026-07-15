import { useEffect, useState } from 'react';
import { BLITZ, type Seat } from '@ludo/game-engine';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { Board } from '../components/Board';
import { DieFace } from '../components/Die';
import { Die3D } from '../components/Die3D';
import { Die } from '../components/DiePremium';
import { IconMenu, IconShield, IconSoundOff, IconSoundOn } from '../components/icons';
import { EmoteBar, EmoteFloat, GiftBar, GiftFloat } from '../components/Emote';
import { skinById, type DiceSkin } from '../lib/diceSkins';
import { frameRing } from '../lib/avatarFrames';
import { avatarSrc } from '../lib/avatars';
import { PremiumFrame } from '../components/PremiumFrame';
import { playDice } from '../lib/sound';
import { t } from '../lib/i18n';

/** The opponent's die carries THEIR seat colour (seat 0 = blue, seat 1 = green),
 *  matching their pawns on the board so a roll is unmistakably theirs. A fixed
 *  green die used to collide with the joining player's own green tokens. */
const OPP_SKINS: Record<Seat, DiceSkin> = {
  0: { id: 'seat-blue', name: 'Blue', body1: '#63C4EC', body2: '#105F97', pip: '#ffffff', stroke: '#0b3f66', unlocked: () => true },
  1: { id: 'seat-green', name: 'Green', body1: '#5FCE79', body2: '#16792E', pip: '#ffffff', stroke: '#0d4a1c', unlocked: () => true },
};

/** Remaining fraction of the move clock (1 → 0), ticking every 100 ms. */
function useCountdown(deadlineTs: number | null): number {
  const [frac, setFrac] = useState(1);
  useEffect(() => {
    if (deadlineTs == null) {
      setFrac(1);
      return;
    }
    const tick = (): void =>
      setFrac(Math.min(1, Math.max(0, (deadlineTs - Date.now()) / BLITZ.moveClockMs)));
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [deadlineTs]);
  return frac;
}

/** Tumble faces briefly when `rollIndex` changes (a new roll for this seat). */
function useTumble(rollIndex: number, vibrate: boolean): number | null {
  const [face, setFace] = useState<number | null>(null);
  useEffect(() => {
    if (rollIndex === 0) return;
    if (vibrate && typeof navigator !== 'undefined') navigator.vibrate?.(35);
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      setFace(1 + Math.floor(Math.random() * 6));
      if (n >= 8) {
        clearInterval(id);
        setFace(null);
      }
    }, 90);
    return () => {
      clearInterval(id);
      setFace(null);
    };
  }, [rollIndex, vibrate]);
  return face;
}

/**
 * Corner avatar card (Ludo-Club style): framed avatar with the player's colour,
 * wrapped in a conic countdown ring while it's this player's turn.
 */
function AvatarCard({
  initial,
  flag,
  frame,
  avatar,
  color,
  active,
  deadlineTs,
}: {
  initial: string;
  /** Country flag emoji; when present it replaces the plain initial for a
   *  framed, identity-rich avatar (Ludo-Club style). */
  flag?: string;
  /** Equipped avatar frame id → a cosmetic ring around the card. */
  frame?: string;
  /** Chosen 3D profile avatar id; takes precedence over the flag/initial. */
  avatar?: string;
  color: string;
  active: boolean;
  deadlineTs: number | null;
}) {
  const frac = useCountdown(active ? deadlineTs : null);
  const low = active && frac < 0.34;
  const ring = active
    ? `conic-gradient(${low ? 'var(--danger)' : 'var(--accent)'} ${frac * 360}deg, rgba(255,255,255,.35) 0deg)`
    : 'rgba(255,255,255,.4)';
  const src = avatarSrc(avatar);
  return (
    <div className={`avcard${active ? ' avcard--turn' : ''}${low ? ' ring--low' : ''} ${frameRing(frame)}`} style={{ background: ring }}>
      <div className="avcard__face" style={{ background: src ? 'transparent' : color }}>
        {src ? <img className="avcard__img" src={src} alt="" /> : flag ? <span className="avcard__flag">{flag}</span> : initial}
      </div>
      <PremiumFrame frame={frame} />
    </div>
  );
}

export function GameScreen({
  onRoll,
  onMove,
  onLeave,
  onEmote,
  onGift,
  onViewProfile,
}: {
  onRoll(): void;
  onMove(token: number): void;
  onLeave(): void;
  onEmote(id: string): void;
  onGift(to: number, id: string): void;
  /** Tap the opponent's avatar → their public profile sheet. */
  onViewProfile(pid: string): void;
}) {
  const { game, match, lastDice, turnDeadlineTs, reconnecting, diceSkin, activeTurn, balanceCents, soundOn, profile, avatarFrame, avatar } =
    useAppState();
  const dispatch = useAppDispatch();
  const skin = skinById(diceSkin);

  const mySeat = match?.seat ?? 0;
  const oppSeat = (1 - mySeat) as Seat;

  // Keep each side's dice separate so an opponent roll never animates my die.
  const myRollIndex = lastDice && lastDice.seat === mySeat ? lastDice.index : 0;
  const oppRollIndex = lastDice && lastDice.seat !== mySeat ? lastDice.index : 0;
  useTumble(myRollIndex, true); // haptic buzz on my roll; the visual is Die3D's
  const oppTumble = useTumble(oppRollIndex, false); // drives the "is rolling…" message

  // Remember each side's last settled value (lastDice only holds the newest roll).
  const [myVal, setMyVal] = useState(6);
  const [oppVal, setOppVal] = useState(6);
  useEffect(() => {
    if (!lastDice) return;
    if (lastDice.seat === mySeat) setMyVal(lastDice.value);
    else setOppVal(lastDice.value);
  }, [lastDice, mySeat]);

  // Grace window that keeps my die button mounted while its tumble plays. A
  // no-legal-move roll or a single-choice auto-move passes the turn the instant
  // the roll lands, and unmounting the button right then cut the animation —
  // the player tapped, their die vanished, and the only tumble they ever saw
  // was the opponent's at the top ("my roll spins at the top").
  const [myRolling, setMyRolling] = useState(false);
  useEffect(() => {
    if (myRollIndex === 0) return;
    setMyRolling(true);
    const id = setTimeout(() => setMyRolling(false), 800);
    return () => clearTimeout(id);
  }, [myRollIndex]);

  if (!game || !match) return null;

  // The HUD follows activeTurn (deferred until a move finishes animating), while
  // roll validity still checks the authoritative game.turn.
  const myTurn = activeTurn === mySeat;
  const canRoll = myTurn && game.turn === mySeat && game.phase === 'awaiting-roll';
  const needPick = myTurn && game.turn === mySeat && game.phase === 'awaiting-move' && game.legal.length > 1;
  // hand-off window: my move is still animating but the engine turn already flipped
  const handoff = myTurn && game.turn !== mySeat;
  const oppRolling = oppTumble !== null;

  const message = handoff
    ? '…'
    : needPick
      ? `🎲 ${myVal} — ${t('pickToken')}`
      : myTurn
        ? t('yourTurn')
        : oppRolling
          ? `${match.opponent.name} ${t('oppRolling')}`
          : `${match.opponent.name} ${t('oppTurn')}`;

  // My label for this game: the server's `youName` wins over the local profile —
  // it is what the OPPONENT's screen shows for me, disambiguated if we both drew
  // the same name. Falls back to the profile (older server / local bot).
  const myLabel = match.youName || profile.name || t('you');

  // Drive the 3D dice straight from lastDice so the value is fresh on the same
  // render the roll index bumps (the derived myVal/oppVal lag by one commit).
  const myDieVal = lastDice && lastDice.seat === mySeat ? lastDice.value : myVal;
  const oppDieVal = lastDice && lastDice.seat !== mySeat ? lastDice.value : oppVal;

  return (
    <div className="screen screen--game">
      {reconnecting && <div className="reconnectbar">📡 {t('reconnecting')}</div>}
      <div className="gamewrap">
        {/* opponent's corner: avatar top-right (their quadrant side), die beside it */}
        <div className="gamecorner gamecorner--top">
          <div className="pot">
            {match.stakeCents > 0 ? `${t('pot')} ${fmtUsd(match.potCents)}` : t('training')}
          </div>
          <div className="cornerstack">
            <EmoteFloat seat={1 - mySeat} />
            <GiftFloat seat={1 - mySeat} />
            {/* ALWAYS mounted. Die3D animates via a CSS transition, and a freshly
                mounted element cannot transition — gating this on `!myTurn` meant
                the opponent's die mounted at the very moment their roll landed
                (server-driven, no human delay), so the tumble never played and the
                value just popped in. Our own die dodged it only because it mounts
                at turn start and waits for a human tap. Hidden via CSS instead. */}
            <div
              className={`huddie${myTurn ? ' huddie--idle' : ''}`}
              aria-label={`${match.opponent.name} die`}
              aria-hidden={myTurn}
            >
              <Die3D value={oppDieVal} rollKey={oppRollIndex} skin={OPP_SKINS[oppSeat]} />
            </div>
            <button
              className="avtap"
              aria-label={`${match.opponent.name} profile`}
              onClick={() => match.opponent.pid && onViewProfile(match.opponent.pid)}
            >
              <AvatarCard
                initial={match.opponent.name.slice(0, 1).toUpperCase()}
                flag={match.opponent.flag}
                frame={match.opponent.frame}
                avatar={match.opponent.avatar}
                color="var(--p2)"
                active={!myTurn}
                deadlineTs={turnDeadlineTs}
              />
            </button>
          </div>
        </div>

        <Board
          game={game}
          mySeat={mySeat}
          onTokenTap={onMove}
          // Name banners follow the REAL seats. The board never rotates (seat 0 is
          // always bottom-left/blue, seat 1 top-right/green), and the joining
          // player is seat 1 — so hardcoding "me" to seat 0 mislabelled every
          // seat-1 player's board: their own tokens carried the opponent's name
          // and they tapped the opponent's tokens, which did nothing ("frozen die").
          // `youName` is the server's label for me (it disambiguates two players
          // who drew the same name); the local profile is only a fallback.
          banners={[
            { seat: mySeat, name: myLabel.toUpperCase(), flag: profile.flag || '🌍', active: myTurn },
            { seat: oppSeat, name: match.opponent.name, flag: match.opponent.flag, active: !myTurn },
          ]}
        />

        {/* my corner: avatar bottom-left (my quadrant side), my gold die beside it */}
        <div className="gamecorner gamecorner--bottom">
          <div className="cornerstack">
            <EmoteFloat seat={mySeat} />
            <GiftFloat seat={mySeat} />
            <AvatarCard initial={myLabel.slice(0, 1).toUpperCase()} flag={profile.flag} frame={avatarFrame} avatar={avatar} color="var(--p1)" active={myTurn} deadlineTs={turnDeadlineTs} />
            {((myTurn && !handoff) || myRolling) && (
              <button
                className="dicebtn"
                disabled={!canRoll}
                onClick={() => {
                  playDice(skin.sound); // my equipped die's own material sound (premium)
                  onRoll();
                }}
                aria-label={`${t('you')} die`}
              >
                <Die value={myDieVal} rollKey={myRollIndex} skin={skin} />
              </button>
            )}
          </div>
          <div className="gamemsg">
            <span>{message}</span>
            {lastDice && (
              <small>
                {t('rollNo')} #{lastDice.index}
              </small>
            )}
          </div>
        </div>

        {/* bottom action bar (Ludo-Club structure): sound · verify · balance · dice skins · menu */}
        <div className="gamebar">
          <button className="gamebar__btn" aria-label="sound" onClick={() => dispatch({ type: 'TOGGLE_SOUND' })}>
            {soundOn ? <IconSoundOn /> : <IconSoundOff />}
          </button>
          <button
            className="gamebar__btn"
            aria-label={t('verify')}
            onClick={() => dispatch({ type: 'FAIR_MODAL', open: true })}
          >
            <IconShield />
          </button>
          <div className="gamebar__coins">
            <span className="gamebar__coin" />
            {fmtUsd(balanceCents)}
          </div>
          <button
            className="gamebar__btn"
            aria-label={t('diceTitle')}
            onClick={() => dispatch({ type: 'DICE_MODAL', open: true })}
          >
            <span className="gamebar__die">
              <DieFace value={5} skin={skin} />
            </span>
          </button>
          <EmoteBar onEmote={onEmote} />
          <GiftBar
            recipients={[{ seat: 1 - mySeat, name: match.opponent.name, flag: match.opponent.flag }]}
            onGift={onGift}
          />
          <button className="gamebar__btn" aria-label="menu" onClick={() => dispatch({ type: 'SETTINGS', open: true })}>
            <IconMenu />
          </button>
          <button
            className="gamebar__btn gamebar__btn--leave"
            aria-label={t('leaveGame')}
            onClick={() => {
              // leaving a live match forfeits it (opponent wins); confirm when a real stake is at risk
              const staked = (match?.stakeCents ?? 0) > 0;
              if (!staked || window.confirm(t('forfeitConfirm'))) onLeave();
            }}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
