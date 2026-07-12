import { useEffect, useState } from 'react';
import { BLITZ } from '@ludo/game-engine';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { Board } from '../components/Board';
import { DieFace } from '../components/Die';
import { IconMenu, IconShield, IconSoundOff, IconSoundOn } from '../components/icons';
import { skinById } from '../lib/diceSkins';
import { playDice } from '../lib/sound';
import { t } from '../lib/i18n';

/** Opponent always rolls a fixed green die, so their roll is unmistakably theirs. */
const OPP_SKIN = skinById('emerald');

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
  color,
  active,
  deadlineTs,
}: {
  initial: string;
  color: string;
  active: boolean;
  deadlineTs: number | null;
}) {
  const frac = useCountdown(active ? deadlineTs : null);
  const low = active && frac < 0.34;
  const ring = active
    ? `conic-gradient(${low ? 'var(--danger)' : 'var(--accent)'} ${frac * 360}deg, rgba(255,255,255,.35) 0deg)`
    : 'rgba(255,255,255,.4)';
  return (
    <div className={`avcard${active ? ' avcard--turn' : ''}${low ? ' ring--low' : ''}`} style={{ background: ring }}>
      <div className="avcard__face" style={{ background: color }}>
        {initial}
      </div>
    </div>
  );
}

export function GameScreen({ onRoll, onMove }: { onRoll(): void; onMove(token: number): void }) {
  const { game, match, lastDice, turnDeadlineTs, reconnecting, diceSkin, activeTurn, balanceCents, soundOn } =
    useAppState();
  const dispatch = useAppDispatch();
  const skin = skinById(diceSkin);

  const mySeat = match?.seat ?? 0;

  // Keep each side's dice separate so an opponent roll never animates my die.
  const myRollIndex = lastDice && lastDice.seat === mySeat ? lastDice.index : 0;
  const oppRollIndex = lastDice && lastDice.seat !== mySeat ? lastDice.index : 0;
  const myTumble = useTumble(myRollIndex, true);
  const oppTumble = useTumble(oppRollIndex, false);

  // Remember each side's last settled value (lastDice only holds the newest roll).
  const [myVal, setMyVal] = useState(6);
  const [oppVal, setOppVal] = useState(6);
  useEffect(() => {
    if (!lastDice) return;
    if (lastDice.seat === mySeat) setMyVal(lastDice.value);
    else setOppVal(lastDice.value);
  }, [lastDice, mySeat]);

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

  const myFace = myTumble ?? myVal;
  const oppFace = oppTumble ?? oppVal;

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
            {!myTurn && (
              <div
                className={`huddie${oppTumble !== null ? ' huddie--rolling' : ''}`}
                aria-label={`${match.opponent.name} die`}
              >
                <DieFace value={oppFace} skin={OPP_SKIN} />
              </div>
            )}
            <AvatarCard
              initial={match.opponent.name.slice(0, 1).toUpperCase()}
              color="var(--p2)"
              active={!myTurn}
              deadlineTs={turnDeadlineTs}
            />
          </div>
        </div>

        <Board
          game={game}
          mySeat={mySeat}
          onTokenTap={onMove}
          banners={[
            { seat: 0, name: t('you').toUpperCase(), flag: '🌍', active: myTurn },
            { seat: 1, name: match.opponent.name, flag: match.opponent.flag, active: !myTurn },
          ]}
        />

        {/* my corner: avatar bottom-left (my quadrant side), my gold die beside it */}
        <div className="gamecorner gamecorner--bottom">
          <div className="cornerstack">
            <AvatarCard initial={t('you').slice(0, 1).toUpperCase()} color="var(--p1)" active={myTurn} deadlineTs={turnDeadlineTs} />
            {myTurn && !handoff && (
              <button
                className={`dicebtn${myTumble !== null ? ' dicebtn--rolling' : ''}`}
                disabled={!canRoll}
                onClick={() => {
                  playDice(); // immediate feedback; the server result lands ~RTT later
                  onRoll();
                }}
                aria-label={`${t('you')} die`}
              >
                <DieFace value={myFace} skin={skin} />
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
          <button className="gamebar__btn" aria-label="menu" onClick={() => dispatch({ type: 'SETTINGS', open: true })}>
            <IconMenu />
          </button>
        </div>
      </div>
    </div>
  );
}
