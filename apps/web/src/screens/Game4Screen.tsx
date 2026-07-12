/**
 * 4-player practice screen — fully local (you + three bots), isolated from the
 * staked 2-player PvP path. Drives the ludo4 engine with paced bot turns and
 * renders the Ludo-Club-style 4-player board.
 */
import { useEffect, useRef, useState } from 'react';
import { Board4 } from '../components/Board4';
import { DieFace } from '../components/Die';
import { IconMenu } from '../components/icons';
import type { DiceSkin } from '../lib/diceSkins';
import { applyMove4, applyRoll4, newGame4, pickAutoMove4, type Game4 } from '../lib/ludo4';
import { BOT_MOVE_MS, BOT_ROLL_MS, FORCED_MOVE_MS, TURN_BEAT_MS, WALK_STEP_MS, WALK_TWEEN_MS } from '../lib/pacing';
import { playCapture, playDice } from '../lib/sound';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';

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

/** Black ink-splat overlay shown while the die tumbles (Ludo Club roll cue). */
function InkSplat() {
  return (
    <svg className="inksplat" viewBox="0 0 100 100" aria-hidden="true">
      <path
        fill="#12151d"
        d="M50 12c7 0 9 8 15 9s11-4 15 1-2 12 1 18 9 8 6 15-11 3-14 9 1 13-5 16-11-5-18-4-10 8-16 5-3-11-8-15-13-1-15-8 7-9 7-16-6-11-2-16 12 1 17-3 4-13 14-13z"
      />
      <circle cx="30" cy="34" r="7" fill="#12151d" />
      <circle cx="72" cy="66" r="8" fill="#12151d" />
      <circle cx="66" cy="26" r="5" fill="#12151d" />
    </svg>
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
  const [tumble, setTumble] = useState<number | null>(null);

  // tumble the active die briefly on each new roll
  useEffect(() => {
    if (!roll) return;
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      setTumble(die6());
      if (n >= 8) {
        clearInterval(id);
        setTumble(null);
      }
    }, 90);
    return () => {
      clearInterval(id);
      setTumble(null);
    };
  }, [roll]);

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

  const dieValue = tumble ?? roll?.value ?? 6;
  const activeName = PLAYERS[activeSeat]?.name ?? '';
  // die sits at the active seat's board corner (blue bottom-left, red top-left,
  // green top-right, yellow bottom-right) — like Ludo Club's per-player die.
  const cornerCls = ['bl', 'tl', 'tr', 'br'][activeSeat] ?? 'bl';

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

        <div className="gamestage">
          <Board4
            game={game}
            mySeat={mySeat}
            onTokenTap={(token) => myTurn && game.phase === 'awaiting-move' && doMove(gameRef.current, mySeat, token)}
            banners={PLAYERS.map((p, seat) => ({ seat, name: p.name, flag: p.flag, active: seat === activeSeat }))}
          />
          <div className={`dcorner dcorner--${cornerCls}`}>
            {myTurn ? (
              <button
                className={`ludodie ludodie--tap${tumble !== null ? ' ludodie--rolling' : ''}`}
                disabled={!canRoll}
                onClick={() => canRoll && doRoll(gameRef.current, mySeat)}
                aria-label="your die"
              >
                <DieFace value={dieValue} skin={WHITE_DIE} />
                {tumble !== null && <InkSplat />}
              </button>
            ) : (
              <div className={`ludodie${tumble !== null ? ' ludodie--rolling' : ''}`} aria-label={`${activeName} die`}>
                <DieFace value={dieValue} skin={WHITE_DIE} />
                {tumble !== null && <InkSplat />}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
