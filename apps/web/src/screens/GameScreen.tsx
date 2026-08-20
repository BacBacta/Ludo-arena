import { useCallback, useEffect, useRef, useState } from 'react';
import { BLITZ, type Seat } from '@ludo/game-engine';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { tokenSkinById } from '../lib/tokenSkins';
import { EntranceFxOverlay } from '../components/CosmeticFx';
import { Board } from '../components/Board';
import { DieFace } from '../components/Die';
import { Die } from '../components/DiePremium';
import { IconCoins, IconFlag, IconMenu, IconShieldCheck, IconSoundOff, IconSoundOn } from '../components/icons';
import { EmoteBar, EmoteFloat, GiftBar, GiftFlight } from '../components/Emote';
import { DIE_HOLD_MS, DIE_TUMBLE_MS } from '../lib/pacing';
import { skinById, skinSound, type DiceSkin } from '../lib/diceSkins';
import { frameRing } from '../lib/avatarFrames';
import { avatarSrc } from '../lib/avatars';
import { PremiumFrame } from '../components/PremiumFrame';
import { playDice } from '../lib/sound';
import { t } from '../lib/i18n';

/** The die shown for the opponent in my HUD: their REAL equipped skin, relayed
 *  in match.found — premium dice are seen by both players (the flagship flex),
 *  and a skinless opponent shows the plain Classic die, NOT a colour we invent
 *  for them (a fabricated seat-colour die read as "a skin they don't have"). */
function opponentDie(diceSkin: string | undefined): DiceSkin {
  return skinById(diceSkin ?? 'classic');
}

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
  // The ring IS the move clock (design 1c): it drains around a paper disc, on an
  // ink-tinted track. On the candy stage the track was white, which vanished the
  // moment the ground turned to paper.
  const ring = active
    ? `conic-gradient(${low ? 'var(--danger)' : 'var(--accent)'} ${frac * 360}deg, rgba(32,30,29,.12) 0deg)`
    : 'rgba(32,30,29,.12)';
  const src = avatarSrc(avatar);
  return (
    <div
      className={`avcard${active ? ' avcard--turn' : ''}${low ? ' ring--low' : ''} ${frameRing(frame)}`}
      style={{ background: ring, ['--seat-ink' as string]: color }}
    >
      <div className="avcard__face">
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
  const { game, match, lastDice, turnDeadlineTs, reconnecting, diceSkin, tokenSkin, entranceFx, boardTheme, activeTurn, soundOn, profile, avatarFrame, avatar, botMode, pendingAction } =
    useAppState();
  const dispatch = useAppDispatch();
  const skin = skinById(diceSkin);
  const [confirmLeave, setConfirmLeave] = useState(false);

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

  // A die is normally shown only on its owner's turn, but the server sends the
  // roll, the auto-move and the turn change in ONE burst — so the turn has often
  // already flipped by the time the tumble starts, and whoever's die it is loses
  // it instantly. Both sides therefore get a grace window that outlives the turn:
  // long enough for the DIE_TUMBLE_MS somersault plus a beat to actually read the
  // number. Without it the opponent's die was measured visible for 0-32ms.
  // Each hold is cut short the moment the OTHER side rolls (their roll zeroes this
  // side's index), so a stale die never lingers over a fresh one.
  const [myRolling, setMyRolling] = useState(false);
  useEffect(() => {
    if (myRollIndex === 0) {
      setMyRolling(false);
      return;
    }
    setMyRolling(true);
    const id = setTimeout(() => setMyRolling(false), DIE_HOLD_MS);
    return () => clearTimeout(id);
  }, [myRollIndex]);
  const [oppShowing, setOppShowing] = useState(false);
  useEffect(() => {
    if (oppRollIndex === 0) {
      setOppShowing(false);
      return;
    }
    setOppShowing(true);
    const id = setTimeout(() => setOppShowing(false), DIE_HOLD_MS);
    return () => clearTimeout(id);
  }, [oppRollIndex]);

  // Urgency countdown (hook — must run on EVERY render, before the null guard):
  // ticks only while it is genuinely my turn to act.
  const myClockFrac = useCountdown(activeTurn === mySeat && game?.turn === mySeat ? turnDeadlineTs : null);

  // R21 — a pawn must never start walking while MY die is still tumbling: the
  // move reads as the outcome of a roll the player has not been shown yet. The
  // pawns become legal the instant the server's result lands (~80 ms), well
  // inside the ~700 ms tumble, so a quick tapper used to move under a spinning
  // die.
  //
  // Swallowing the tap for 700 ms would make the board feel dead, so the tap is
  // REMEMBERED and replayed the moment the die settles. The replay re-checks the
  // authoritative state — a deferred token that is no longer legal (turn moved
  // on, pawn captured meanwhile) is dropped rather than sent.
  //
  // Gated on the ROLL CLOCK, not on `useTumble`'s sampled face: that hook only
  // produces its first face on its first 90 ms interval tick and returns null
  // until then, so the 80 ms window in which a fast tap actually arrives read as
  // "not tumbling" and sailed straight through.
  const [tumblingMove, setTumblingMove] = useState(false);
  const deferredMove = useRef<number | null>(null);
  useEffect(() => {
    // `myRollIndex` falls back to 0 whenever the last die is no longer MINE —
    // the opponent rolled, or the match was cleared. Returning early there left
    // the gate latched ON (the cleanup had already cancelled the timer that
    // would have lowered it), so every later tap was swallowed into
    // `deferredMove` and a stale token got auto-played at the end of some
    // future roll's tumble. Lower the gate and drop the pending tap instead.
    if (myRollIndex === 0) {
      setTumblingMove(false);
      deferredMove.current = null;
      return;
    }
    setTumblingMove(true);
    const id = setTimeout(() => setTumblingMove(false), DIE_TUMBLE_MS);
    return () => clearTimeout(id);
  }, [myRollIndex]);
  const onTokenTap = useCallback(
    (token: number) => {
      if (tumblingMove) {
        deferredMove.current = token;
        return;
      }
      onMove(token);
    },
    [tumblingMove, onMove],
  );
  useEffect(() => {
    if (tumblingMove) return;
    const token = deferredMove.current;
    if (token === null) return;
    deferredMove.current = null;
    if (game && game.turn === mySeat && game.phase === 'awaiting-move' && game.legal.includes(token)) onMove(token);
  }, [tumblingMove, game, mySeat, onMove]);

  if (!game || !match) return null;

  // The HUD follows activeTurn (deferred until a move finishes animating), while
  // roll validity still checks the authoritative game.turn.
  // An action we've sent to the server and are awaiting the echo for: the die and
  // the movable pawns lock until it resolves, so a slow RTT can't be re-tapped into
  // a duplicate intent. (Always null for the local bot — it resolves synchronously.)
  const locked = pendingAction !== null;

  const myTurn = activeTurn === mySeat;
  const canRoll = myTurn && game.turn === mySeat && game.phase === 'awaiting-roll' && !locked;
  const needPick = myTurn && game.turn === mySeat && game.phase === 'awaiting-move' && game.legal.length > 1;
  // hand-off window: my move is still animating but the engine turn already flipped
  const handoff = myTurn && game.turn !== mySeat;
  const oppRolling = oppTumble !== null;

  // Urgency nudge: with ≤5s left on MY clock, the message counts down and names
  // the consequence — the auto-play rule surprised every MiniPay tester, and
  // this teaches it exactly where it bites (nowhere else is it on screen).
  const secsLeft = Math.ceil((myClockFrac * BLITZ.moveClockMs) / 1000);
  const rush = myTurn && !handoff && (canRoll || needPick) && secsLeft <= 5;

  // Design 1c splits turn state in two: who is acting (Caprasimo headline) and
  // what to do about it (muted sub-line). The candy build crammed both into one
  // white sentence with a 🎲 in it.
  const headline = handoff ? '…' : myTurn ? t('yourTurn') : match.opponent.name;
  const subline = handoff
    ? ''
    : rush
      ? t('hurry').replace('{s}', String(secsLeft))
      : needPick
        ? t('pickToken').replace('{n}', String(myVal))
        : myTurn
          ? t('tapDie')
          : oppRolling
            ? t('oppRolling')
            : t('oppTurn');

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
        {/* one overlay flies each gift from the sender's tile to the recipient's */}
        <GiftFlight />
        {/* Opponent row (design 1c): who they are on the left, what is at stake on
            the right. The pot moved to a dark pill because money gets the dark
            surface, never gold-on-blue. */}
        <div className="gamecorner gamecorner--top">
          <div className="cornerstack" data-seat-anchor={1 - mySeat}>
            <EmoteFloat seat={1 - mySeat} />
            {/* ALWAYS mounted. Die3D animates via a CSS transition, and a freshly
                mounted element cannot transition — gating this on `!myTurn` meant
                the opponent's die mounted at the very moment their roll landed
                (server-driven, no human delay), so the tumble never played and the
                value just popped in. Our own die dodged it only because it mounts
                at turn start and waits for a human tap. Hidden via CSS instead. */}
            <div
              className={`huddie${myTurn && !oppShowing ? ' huddie--idle' : ''}`}
              aria-label={`${match.opponent.name} die`}
              aria-hidden={myTurn && !oppShowing}
            >
              {/* smart Die: renders the opponent's PREMIUM (WebGL) die when they
                  equipped one, else the seat-colour CSS die — so premium dice
                  are visible to both players (the reported gap). */}
              <Die value={oppDieVal} rollKey={oppRollIndex} skin={opponentDie(match.opponent.diceSkin)} />
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
                color="var(--opp)"
                active={!myTurn}
                deadlineTs={turnDeadlineTs}
              />
            </button>
            <div className="pident">
              <b>{match.opponent.name}</b>
              <small>{match.opponent.elo} ELO</small>
            </div>
          </div>
          <div className="potstack">
            <div className="pot">
              {match.stakeCents > 0 ? (
                <>
                  <IconCoins />
                  {`${t('pot')} ${fmtUsd(match.potCents)}`}
                </>
              ) : (
                botMode ? t('training') : t('freeMatch')
              )}
            </div>
            {lastDice && (
              <small className="rollno">
                {t('rollNo')} #{lastDice.index}
              </small>
            )}
          </div>
        </div>

        <Board
          game={game}
          mySeat={mySeat}
          onTokenTap={onTokenTap}
          locked={locked}
          // No name banners painted on the plate: design 1c moves identity into
          // the chrome — the opponent's avatar + name + ELO sit above the board,
          // mine sits below with my turn state, and the local player is always
          // the bottom seat. Two names on the board on top of that was the same
          // fact twice, and it was the board that had to carry the ugly one.
          // Token skins (cosmetics phase 1): mine from local state, the
          // opponent's as relayed by match.found — both sides see both skins.
          tokenPatterns={{
            [mySeat]: tokenSkinById(tokenSkin).pattern,
            [oppSeat]: tokenSkinById(match.opponent.tokenSkin).pattern,
          }}
          // Board theme (phase 2): MY equipped theme — local view only, the
          // opponent plays on theirs (never relayed, like Ludo King).
          themeId={boardTheme}
        />
        <EntranceFxOverlay
          mine={entranceFx}
          others={[match.opponent.entranceFx]}
          gameId={match.gameId}
        />

        {/* my corner: avatar bottom-left (my quadrant side), my gold die beside it */}
        <div className="gamecorner gamecorner--bottom">
          <div className="cornerstack" data-seat-anchor={mySeat}>
            <EmoteFloat seat={mySeat} />
            <AvatarCard initial={myLabel.slice(0, 1).toUpperCase()} flag={profile.flag} frame={avatarFrame} avatar={avatar} color="var(--me)" active={myTurn} deadlineTs={turnDeadlineTs} />
          </div>
          {/* turn state sits between my avatar and my die (design 1c) */}
          <div className={`gamemsg${rush ? ' gamemsg--rush' : ''}`}>
            <span>{headline}</span>
            {subline && <small>{subline}</small>}
          </div>
          <div className="cornerstack cornerstack--die">
            {/* ALWAYS mounted, like the opponent die above: a freshly-mounted element
                cannot run the CSS tumble transition, so unmounting the die between
                turns made the FIRST roll after each remount just pop to the result
                (the bot's always-mounted die tumbled fine). Hidden via CSS when it
                isn't ours to throw. */}
            <button
              className={`dicebtn${(myTurn && !handoff) || myRolling ? '' : ' dicebtn--idle'}`}
              disabled={!canRoll}
              aria-hidden={!((myTurn && !handoff) || myRolling)}
              tabIndex={(myTurn && !handoff) || myRolling ? undefined : -1}
              onClick={() => {
                playDice(skinSound(skin)); // my equipped die's own material sound (premium)
                onRoll();
              }}
              aria-label={`${t('you')} die`}
            >
              <Die value={myDieVal} rollKey={myRollIndex} skin={skin} spinning={pendingAction === 'roll'} />
            </button>
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
            <IconShieldCheck />
          </button>
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
          {/* the design's empty middle: the tray splits into "things you do" and
              "ways out". The balance moved off — it lives on the lobby top bar,
              and mid-match it was only ever a number being clipped. */}
          <span className="gamebar__gap" />
          <button className="gamebar__btn" aria-label="menu" onClick={() => dispatch({ type: 'SETTINGS', open: true })}>
            <IconMenu />
          </button>
          <button
            className="gamebar__btn gamebar__btn--leave"
            aria-label={t('leaveGame')}
            onClick={() => {
              // Leaving a live match forfeits it (opponent wins). A premium
              // in-app confirm (not window.confirm) whenever there's anything to
              // lose — a stake, or the game itself (a free loss still stings).
              setConfirmLeave(true);
            }}
          >
            <IconFlag />
            <span className="gamebar__leavelabel">{t('leaveGame')}</span>
          </button>
        </div>
      </div>
      {confirmLeave && (
        <ForfeitModal
          stakeCents={match?.stakeCents ?? 0}
          onStay={() => setConfirmLeave(false)}
          onLeave={() => {
            setConfirmLeave(false);
            onLeave();
          }}
        />
      )}
    </div>
  );
}

/** Premium forfeit confirmation: a glass modal that names the exact stake at
 *  risk, replacing the browser's flat window.confirm. Escape / backdrop / "keep
 *  playing" all cancel; only the explicit danger button forfeits. */
function ForfeitModal({ stakeCents, onStay, onLeave }: { stakeCents: number; onStay(): void; onLeave(): void }) {
  const staked = stakeCents > 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onStay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onStay]);
  return (
    <div className="modal" onClick={onStay} role="dialog" aria-modal="true" aria-label={t('forfeitTitle')}>
      <div className="modal__card forfeit" onClick={(e) => e.stopPropagation()}>
        <div className="forfeit__glyph" aria-hidden="true">🏳️</div>
        <h3 className="forfeit__title">{t('forfeitTitle')}</h3>
        {staked && (
          <div className="forfeit__stake">
            <span className="forfeit__stakeLabel">{t('stakeAtRisk')}</span>
            <span className="forfeit__stakeAmt">{fmtUsd(stakeCents)}</span>
          </div>
        )}
        <p className="forfeit__body">
          {(staked ? t('forfeitBodyStaked') : t('forfeitBodyFree')).replace('{stake}', fmtUsd(stakeCents))}
        </p>
        <div className="forfeit__actions">
          <button className="btn forfeit__stay" onClick={onStay} autoFocus>
            {t('forfeitStay')}
          </button>
          <button className="btn forfeit__leave" onClick={onLeave}>
            {staked ? t('forfeitLeaveStaked') : t('forfeitLeaveFree')}
          </button>
        </div>
      </div>
    </div>
  );
}
