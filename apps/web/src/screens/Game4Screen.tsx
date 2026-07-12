/**
 * 4-player practice screen — fully local (you + three bots), isolated from the
 * staked 2-player PvP path. Drives the ludo4 engine with paced bot turns and
 * renders the Ludo-Club-style 4-player board.
 */
import { useEffect, useRef, useState } from 'react';
import { Board4 } from '../components/Board4';
import { Die3D } from '../components/Die3D';
import { IconMenu } from '../components/icons';
import type { DiceSkin } from '../lib/diceSkins';
import { applyMove4, applyRoll4, newGame4, pickAutoMove4, type Game4 } from '../lib/ludo4';
import { BOT_MOVE_MS, BOT_ROLL_MS, FORCED_MOVE_MS, TURN_BEAT_MS, WALK_STEP_MS, WALK_TWEEN_MS } from '../lib/pacing';
import { playCapture, playDice, playWin } from '../lib/sound';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { t } from '../lib/i18n';

const PLAYERS = [
  { name: 'YOU', flag: '🌍' },
  { name: 'Ana', flag: '🇭🇷' },
  { name: 'Young', flag: '🌍' },
  { name: 'Dragan', flag: '🇷🇸' },
];

/** Ludo Club uses one WHITE die with black pips for everyone; the active player
 *  is identified by the die's POSITION at their corner, not by colour. */
const WHITE_DIE: DiceSkin = {
  id: 'ludo-white',
  name: '',
  unlocked: () => true,
  body1: '#ffffff',
  body2: '#eef0f5',
  pip: '#161b28',
  stroke: '#c7cdd9',
};

const die6 = (): number => 1 + Math.floor(Math.random() * 6);

/** Grey placeholder avatar tile at a board corner; the active seat lifts slightly. */
function SeatAvatar({ name, active }: { name: string; active: boolean }) {
  return (
    <div className={`seatav${active ? ' seatav--active' : ''}`} aria-label={name}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx={12} cy={9} r={4.4} fill="#aab6c9" />
        <path d="M3.5 21c1.4-4 5-6 8.5-6s7.1 2 8.5 6z" fill="#aab6c9" />
      </svg>
    </div>
  );
}

/** White 3D cube die shown beside a player's avatar; it somersaults on each new
 *  roll (rollKey) and lands on the value. */
function Die({ value, rollKey }: { value: number; rollKey: number }) {
  return (
    <div className="ludodie">
      <Die3D value={value} rollKey={rollKey} skin={WHITE_DIE} />
    </div>
  );
}

export function Game4Screen({ onLeave }: { onLeave(): void }) {
  const { balanceCents } = useAppState();
  const dispatch = useAppDispatch();
  const mySeat = 0;

  const [game, setGame] = useState<Game4>(newGame4);
  const gameRef = useRef(game);
  gameRef.current = game;
  const animRef = useRef(0); // ms the last move still needs to animate

  const [roll, setRoll] = useState<{ seat: number; value: number; key: number } | null>(null);

  function doRoll(g: Game4, seat: number): void {
    const value = die6();
    setRoll({ seat, value, key: Date.now() });
    if (seat === mySeat) playDice();
    setGame(applyRoll4(g, value));
  }

  function doMove(g: Game4, seat: number, token: number): void {
    const oldRel = g.positions[seat]?.[token] ?? -1;
    const res = applyMove4(g, token);
    const newRel = res.state.positions[seat]?.[token] ?? oldRel;
    const steps = oldRel >= 0 ? Math.max(1, newRel - oldRel) : 1;
    animRef.current = steps * WALK_STEP_MS + WALK_TWEEN_MS;
    if (res.events.capture) playCapture();
    setGame(res.state);
  }

  // paced turn driver
  useEffect(() => {
    if (game.phase === 'over') return;
    const seat = game.turn;
    const settle = animRef.current;
    animRef.current = 0;
    let id: ReturnType<typeof setTimeout> | undefined;
    if (seat !== mySeat) {
      if (game.phase === 'awaiting-roll') {
        id = setTimeout(() => doRoll(gameRef.current, seat), settle + TURN_BEAT_MS + BOT_ROLL_MS);
      } else if (game.phase === 'awaiting-move') {
        const pick = pickAutoMove4(game, seat, game.dice ?? 6) ?? game.legal[0]!;
        id = setTimeout(() => doMove(gameRef.current, seat, pick), settle + BOT_MOVE_MS);
      }
    } else if (game.phase === 'awaiting-move' && game.legal.length === 1) {
      id = setTimeout(() => doMove(gameRef.current, seat, game.legal[0]!), settle + FORCED_MOVE_MS);
    }
    return () => clearTimeout(id);
  }, [game]);

  const myTurn = game.turn === mySeat;
  const canRoll = myTurn && game.phase === 'awaiting-roll';
  const activeSeat = game.turn;

  const dieValue = roll?.value ?? 6;
  const rollKey = roll?.key ?? 0;

  // Game over: show a win/lose card instead of a frozen board (was a dead end).
  const over = game.phase === 'over';
  const iWon = over && game.winner === mySeat;
  const overFired = useRef(false);
  useEffect(() => {
    if (over && !overFired.current) {
      overFired.current = true;
      if (iWon) playWin();
    }
    if (!over) overFired.current = false;
  }, [over, iWon]);

  function restart(): void {
    setRoll(null);
    setGame(newGame4());
  }

  return (
    <div className="screen screen--game">
      <div className="gamewrap">
        <div className="gametop">
          <button className="chromebtn" aria-label="menu" onClick={() => dispatch({ type: 'SETTINGS', open: true })}>
            <IconMenu />
          </button>
          <div className="coinchip">
            <span className="coinchip__c" />
            {fmtUsd(balanceCents)}
          </div>
          <button className="chromebtn" aria-label="leave" onClick={onLeave}>
            ✕
          </button>
        </div>

        {/* top corner avatars: Ana (left) / Young (right); die appears beside the active one */}
        <div className="avrow">
          <div className="avrow__side">
            <SeatAvatar name="Ana" active={activeSeat === 1} />
            {activeSeat === 1 && <Die value={dieValue} rollKey={rollKey} />}
          </div>
          <div className="avrow__side">
            {activeSeat === 2 && <Die value={dieValue} rollKey={rollKey} />}
            <SeatAvatar name="Young" active={activeSeat === 2} />
          </div>
        </div>

        <Board4
          game={game}
          mySeat={mySeat}
          onTokenTap={(token) => myTurn && game.phase === 'awaiting-move' && doMove(gameRef.current, mySeat, token)}
          banners={PLAYERS.map((p, seat) => ({ seat, name: p.name, flag: p.flag, active: seat === activeSeat }))}
        />

        {/* bottom corner avatars: YOU (left) / Dragan (right) */}
        <div className="avrow">
          <div className="avrow__side">
            <SeatAvatar name="YOU" active={myTurn} />
            {myTurn && (
              <button
                className="ludodie ludodie--tap"
                disabled={!canRoll}
                onClick={() => canRoll && doRoll(gameRef.current, mySeat)}
                aria-label="your die"
              >
                <Die3D value={dieValue} rollKey={rollKey} skin={WHITE_DIE} />
              </button>
            )}
          </div>
          <div className="avrow__side">
            {activeSeat === 3 && <Die value={dieValue} rollKey={rollKey} />}
            <SeatAvatar name="Dragan" active={activeSeat === 3} />
          </div>
        </div>
      </div>

      {over && (
        <div className="g4over" role="dialog" aria-modal="true" aria-label={iWon ? t('victory') : t('defeat')}>
          <div className="g4over__card">
            <div className="g4over__emoji" aria-hidden="true">{iWon ? '🏆' : '🎲'}</div>
            <div className="g4over__title">{iWon ? t('victory') : `${PLAYERS[game.winner ?? 0]?.name ?? ''} — ${t('defeat')}`}</div>
            <div className="g4over__sub">{t('trainingGame')}</div>
            <button className="btn" onClick={restart}>{t('rematch')}</button>
            <button className="btn btn--ghost" onClick={onLeave}>{t('home')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
