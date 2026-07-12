import { useEffect, useState } from 'react';
import { BLITZ } from '@ludo/game-engine';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { Board } from '../components/Board';
import { DieFace } from '../components/Die';
import { IconShield } from '../components/icons';
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

/** Player chip with a conic turn-timer ring when it's this player's turn. */
function TurnChip({ color, active, deadlineTs }: { color: string; active: boolean; deadlineTs: number | null }) {
  const frac = useCountdown(active ? deadlineTs : null);
  const low = active && frac < 0.34;
  const ring = active
    ? `conic-gradient(${low ? 'var(--danger)' : 'var(--accent)'} ${frac * 360}deg, var(--line) 0deg)`
    : 'var(--line)';
  return (
    <div className={`ringwrap${low ? ' ring--low' : ''}`} style={{ background: ring }}>
      <div className="player__chip" style={{ background: color }} />
    </div>
  );
}

export function GameScreen({ onRoll, onMove }: { onRoll(): void; onMove(token: number): void }) {
  const { game, match, lastDice, turnDeadlineTs, reconnecting, diceSkin, activeTurn } = useAppState();
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
  const oppRolling = oppTumble !== null;

  const message = needPick
    ? `🎲 ${myVal} — ${t('pickToken')}`
    : myTurn
      ? t('yourTurn')
      : oppRolling
        ? `${match.opponent.name} ${t('oppRolling')}`
        : `${match.opponent.name} ${t('oppTurn')}`;

  const myFace = myTumble ?? myVal;
  const oppFace = oppTumble ?? oppVal;

  return (
    <div className="screen">
      {reconnecting && <div className="reconnectbar">📡 {t('reconnecting')}</div>}
      <div className="gamewrap">
        <div className="hud">
          <div className={`player${myTurn ? ' player--turn' : ''}`}>
            <TurnChip color="var(--p1)" active={myTurn} deadlineTs={turnDeadlineTs} />
            {t('you')}
          </div>
          <div className="pot">
            {match.stakeCents > 0 ? `${t('pot')} ${fmtUsd(match.potCents)}` : t('training')}
          </div>
          <div className={`player${!myTurn ? ' player--turn' : ''}`}>
            <TurnChip color="var(--p2)" active={!myTurn} deadlineTs={turnDeadlineTs} />
            <span>
              {match.opponent.flag} {match.opponent.name}
              <span className="player__elo">{match.opponent.elo}</span>
            </span>
          </div>
        </div>

        <Board game={game} mySeat={mySeat} onTokenTap={onMove} />

        <div className="controls">
          {myTurn ? (
            <button
              className={`dicebtn${myTumble !== null ? ' dicebtn--rolling' : ''}`}
              disabled={!canRoll}
              onClick={() => {
                playDice(); // immediate feedback; the server result lands ~RTT later
                onRoll();
              }}
            >
              <DieFace value={myFace} skin={skin} />
            </button>
          ) : (
            <div
              className={`dicebtn dicebtn--opp${oppTumble !== null ? ' dicebtn--rolling' : ''}`}
              aria-label={`${match.opponent.name} die`}
            >
              <DieFace value={oppFace} skin={OPP_SKIN} />
            </div>
          )}
          <div className="gamemsg">
            <span>{message}</span>
            <small>
              {t('rollNo')} #{lastDice?.index ?? 0} ·{' '}
              <a onClick={() => dispatch({ type: 'FAIR_MODAL', open: true })}>
                <IconShield className="icon--me" /> {t('verify')}
              </a>
            </small>
          </div>
        </div>
      </div>
    </div>
  );
}
