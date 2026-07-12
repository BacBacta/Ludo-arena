/**
 * 4-player practice screen — fully local (you + three bots), isolated from the
 * staked 2-player PvP path. Drives the ludo4 engine with paced bot turns and
 * renders the Ludo-Club-style 4-player board.
 */
import { useEffect, useRef, useState } from 'react';
import { Board4 } from '../components/Board4';
import { DieFace } from '../components/Die';
import { IconMenu, IconShield, IconSoundOff, IconSoundOn } from '../components/icons';
import type { DiceSkin } from '../lib/diceSkins';
import { applyMove4, applyRoll4, newGame4, pickAutoMove4, type Game4 } from '../lib/ludo4';
import { BOT_MOVE_MS, BOT_ROLL_MS, FORCED_MOVE_MS, TURN_BEAT_MS, WALK_STEP_MS, WALK_TWEEN_MS } from '../lib/pacing';
import { playCapture, playDice } from '../lib/sound';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { t } from '../lib/i18n';

const PLAYERS = [
  { name: 'YOU', flag: '🌍' },
  { name: 'Ana', flag: '🇭🇷' },
  { name: 'Young', flag: '🌍' },
  { name: 'Dragan', flag: '🇷🇸' },
];

function seatSkin(seat: number): DiceSkin {
  const S = [
    { body1: '#8AAEFF', body2: '#3E63DD', pip: '#ffffff', stroke: '#2540A8' },
    { body1: '#FF9A8F', body2: '#E5484D', pip: '#ffffff', stroke: '#B02E33' },
    { body1: '#7BDD84', body2: '#46A758', pip: '#ffffff', stroke: '#2E7A3C' },
    { body1: '#FFE07A', body2: '#F4B400', pip: '#7a5300', stroke: '#C08900' },
  ][seat] ?? { body1: '#8AAEFF', body2: '#3E63DD', pip: '#ffffff', stroke: '#2540A8' };
  return { id: `seat${seat}`, name: '', unlocked: () => true, ...S };
}

const die6 = (): number => 1 + Math.floor(Math.random() * 6);
/** Active-die halo colour per seat (blue/red/green/yellow), lightly translucent. */
const seatHex = (seat: number): string =>
  ['rgba(62,99,221,.7)', 'rgba(229,72,77,.7)', 'rgba(70,167,88,.7)', 'rgba(244,180,0,.75)'][seat] ?? 'rgba(62,99,221,.7)';

export function Game4Screen({ onLeave }: { onLeave(): void }) {
  const { soundOn, balanceCents } = useAppState();
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
  const needPick = myTurn && game.phase === 'awaiting-move' && game.legal.length > 1;
  const activeSeat = game.turn;
  const rolling = tumble !== null;

  const dieValue = tumble ?? roll?.value ?? 6;
  const activeName = PLAYERS[activeSeat]?.name ?? '';
  const message =
    game.phase === 'over'
      ? game.winner === mySeat
        ? '🏆 You win!'
        : `${PLAYERS[game.winner ?? 0]?.name} wins`
      : needPick
        ? `🎲 ${roll?.value ?? ''} — ${t('pickToken')}`
        : myTurn
          ? t('yourTurn')
          : `${activeName} ${rolling ? t('oppRolling') : t('oppTurn')}`;

  return (
    <div className="screen screen--game">
      <div className="gamewrap">
        <div className="gamecorner gamecorner--top">
          <div className="pot">{t('training')} · 4P</div>
          <button className="linkbtn" onClick={onLeave}>
            ✕
          </button>
        </div>

        <Board4
          game={game}
          mySeat={mySeat}
          onTokenTap={(token) => myTurn && game.phase === 'awaiting-move' && doMove(gameRef.current, mySeat, token)}
          banners={PLAYERS.map((p, seat) => ({ seat, name: p.name, flag: p.flag, active: seat === activeSeat }))}
        />

        <div className="gamecorner gamecorner--bottom">
          <div className="cornerstack">
            {myTurn ? (
              <button
                className={`dicebtn${tumble !== null ? ' dicebtn--rolling' : ''}`}
                disabled={!canRoll}
                onClick={() => canRoll && doRoll(gameRef.current, mySeat)}
                aria-label="your die"
              >
                <DieFace value={dieValue} skin={seatSkin(0)} />
              </button>
            ) : (
              <div
                className={`huddie huddie--big${tumble !== null ? ' huddie--rolling' : ''}`}
                aria-label={`${activeName} die`}
                style={{
                  boxShadow: `0 4px 10px rgba(15,26,68,.35), 0 0 0 3px ${seatHex(activeSeat)}, inset 0 1px 0 rgba(255,255,255,.5)`,
                }}
              >
                <DieFace value={dieValue} skin={seatSkin(activeSeat)} />
              </div>
            )}
          </div>
          <div className="gamemsg">
            <span>{message}</span>
          </div>
        </div>

        <div className="gamebar">
          <button className="gamebar__btn" aria-label="sound" onClick={() => dispatch({ type: 'TOGGLE_SOUND' })}>
            {soundOn ? <IconSoundOn /> : <IconSoundOff />}
          </button>
          <button className="gamebar__btn" aria-label={t('verify')} onClick={() => dispatch({ type: 'FAIR_MODAL', open: true })}>
            <IconShield />
          </button>
          <div className="gamebar__coins">
            <span className="gamebar__coin" />
            {fmtUsd(balanceCents)}
          </div>
          <button className="gamebar__btn" aria-label={t('diceTitle')} onClick={() => dispatch({ type: 'DICE_MODAL', open: true })}>
            <span className="gamebar__die">
              <DieFace value={5} skin={seatSkin(0)} />
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
