import { useEffect, useState } from 'react';
import { BLITZ } from '@ludo/game-engine';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { Board } from '../components/Board';
import { DieFace } from '../components/Die';
import { IconShield } from '../components/icons';
import { skinById } from '../lib/diceSkins';
import { playDice } from '../lib/sound';
import { t } from '../lib/i18n';

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
  const { game, match, lastDice, turnDeadlineTs, reconnecting, diceSkin } = useAppState();
  const dispatch = useAppDispatch();
  const skin = skinById(diceSkin);

  // Dice tumble: on each new roll, cycle random faces briefly before settling.
  const [tumbleFace, setTumbleFace] = useState<number | null>(null);
  const rollIndex = lastDice?.index ?? 0;
  useEffect(() => {
    if (rollIndex === 0) return;
    if (typeof navigator !== 'undefined') navigator.vibrate?.(35);
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      setTumbleFace(1 + Math.floor(Math.random() * 6));
      if (n >= 8) {
        clearInterval(id);
        setTumbleFace(null);
      }
    }, 90);
    return () => {
      clearInterval(id);
      setTumbleFace(null);
    };
  }, [rollIndex]);

  if (!game || !match) return null;

  const mySeat = match.seat;
  const myTurn = game.turn === mySeat;
  const canRoll = myTurn && game.phase === 'awaiting-roll';
  const needPick = myTurn && game.phase === 'awaiting-move' && game.legal.length > 1;

  const message = needPick
    ? `🎲 ${lastDice?.value ?? ''} — ${t('pickToken')}`
    : myTurn
      ? t('yourTurn')
      : `${match.opponent.name} ${t('oppTurn')}`;

  const face = tumbleFace ?? lastDice?.value ?? 6;

  return (
    <div className="screen">
      {reconnecting && <div className="reconnectbar">📡 {t('reconnecting')}</div>}
      <div className="gamewrap">
        <div className="hud">
          <div className={`player${myTurn ? ' player--turn' : ''}`}>
            <TurnChip color="var(--me)" active={myTurn} deadlineTs={turnDeadlineTs} />
            {t('you')}
          </div>
          <div className="pot">
            {match.stakeCents > 0 ? `${t('pot')} ${fmtUsd(match.potCents)}` : t('training')}
          </div>
          <div className={`player${!myTurn ? ' player--turn' : ''}`}>
            <TurnChip color="var(--opp)" active={!myTurn} deadlineTs={turnDeadlineTs} />
            <span>
              {match.opponent.flag} {match.opponent.name}
              <span className="player__elo">{match.opponent.elo}</span>
            </span>
          </div>
        </div>

        <Board game={game} mySeat={mySeat} onTokenTap={onMove} />

        <div className="controls">
          <button
            className={`dicebtn${tumbleFace !== null ? ' dicebtn--rolling' : ''}`}
            disabled={!canRoll}
            onClick={() => {
              playDice(); // immediate feedback; the server result lands ~RTT later
              onRoll();
            }}
          >
            <DieFace value={face} skin={skin} />
          </button>
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
