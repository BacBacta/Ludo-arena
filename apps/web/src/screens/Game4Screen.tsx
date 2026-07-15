/**
 * 4-player practice screen — fully local (you + three bots), isolated from the
 * staked 2-player PvP path. Drives the ludo4 engine with paced bot turns and
 * renders the Ludo-Club-style 4-player board.
 */
import { useEffect, useRef, useState } from 'react';
import { Board4 } from '../components/Board4';
import { Die } from '../components/DiePremium';
import { SeatAvatar, SeatDie } from '../components/Seat4';
import { skinById } from '../lib/diceSkins';
import { EmoteBar, EmoteFloat, GiftBar, GiftFloat, type GiftTarget } from '../components/Emote';
import { IconMenu } from '../components/icons';
import { applyMove4, applyRoll4, legalMoves4, newGame4, pickAutoMove4, type Game4 } from '@ludo/game-engine';
import { EMOTES } from '@ludo/shared';
import { BOT_MOVE_MS, BOT_ROLL_MS, DIE_SETTLE_MS, FORCED_MOVE_MS, TURN_BEAT_MS, WALK_STEP_MS, WALK_TWEEN_MS } from '../lib/pacing';
import { playCapture, playDice, playWin } from '../lib/sound';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { t } from '../lib/i18n';

// Practice bots show the neutral globe: a flag only ever means "this player
// chose it in their profile" (and flagged bots would mark out the bot seats).
const PLAYERS = [
  { name: 'YOU', flag: '🌍' },
  { name: 'Ana', flag: '🌍' },
  { name: 'Young', flag: '🌍' },
  { name: 'Dragan', flag: '🌍' },
];

const die6 = (): number => 1 + Math.floor(Math.random() * 6);

export function Game4Screen({ onLeave }: { onLeave(): void }) {
  const { balanceCents, profile, avatarFrame, avatar, diceSkin } = useAppState();
  const dispatch = useAppDispatch();
  const mySeat = 0;
  const mySkin = skinById(diceSkin); // my equipped die reflects my cosmetic (my rolls)
  // Premium corner avatars carry a country flag: bots have fixed flags; my seat
  // uses my real identity flag, falling back to the generic globe.
  const seatFlag = (seat: number): string =>
    (seat === mySeat ? profile.flag : '') || PLAYERS[seat]?.flag || '🌍';
  const seatFrame = (seat: number): string | undefined => (seat === mySeat ? avatarFrame : undefined);
  // Only my seat can have a chosen 3D avatar; bots stay as flags.
  const seatAvatar = (seat: number): string | undefined => (seat === mySeat ? avatar : undefined);

  /** Send my emote (echoes over my own corner — practice has no network peer). */
  const sendEmote = (id: string): void => void dispatch({ type: 'EMOTE', seat: mySeat, id });
  /** Send a gift to a chosen bot (drops over their corner). */
  const sendGift = (to: number, id: string): void => void dispatch({ type: 'GIFT', from: mySeat, to, id });
  const giftTargets: GiftTarget[] = [1, 2, 3].map((seat) => ({
    seat,
    name: PLAYERS[seat]?.name ?? '',
    flag: seatFlag(seat),
  }));
  /** Bots feel alive: a small chance to react with a playful emote after a turn. */
  function maybeBotEmote(seat: number, capture: boolean): void {
    if (seat === mySeat) return;
    const chance = capture ? 0.7 : 0.12; // celebrate captures, otherwise rarely
    if (Math.random() > chance) return;
    const pool = capture ? ['🔥', '😎', '💪', '😂'] : EMOTES;
    const id = pool[Math.floor(Math.random() * pool.length)] ?? '👍';
    setTimeout(() => dispatch({ type: 'EMOTE', seat, id }), 350);
  }

  const [game, setGame] = useState<Game4>(newGame4);
  const gameRef = useRef(game);
  gameRef.current = game;
  const animRef = useRef(0); // ms the last move still needs to animate

  const [roll, setRoll] = useState<{ seat: number; value: number; key: number } | null>(null);
  // True while a no-legal-move roll is being shown before the turn passes, so the
  // roll is visible (not an instant skip) and re-rolls are blocked during the beat.
  const [passing, setPassing] = useState(false);
  const passTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const NO_MOVE_MS = DIE_SETTLE_MS; // show the settled roll before the turn passes

  function doRoll(g: Game4, seat: number): void {
    if (g.phase !== 'awaiting-roll' || g.turn !== seat) return; // guard stale/dup calls
    const value = die6();
    setRoll({ seat, value, key: Date.now() });
    playDice(seat === mySeat ? mySkin.sound : undefined); // my roll = my die's own sound
    const legal = legalMoves4(g, seat, value);
    if (legal.length === 0) {
      // No move: SHOW the roll on this seat for a beat, THEN pass the turn — so it
      // never looks like the player was skipped without rolling (common early game).
      setPassing(true);
      clearTimeout(passTimer.current);
      passTimer.current = setTimeout(() => {
        setPassing(false);
        const cur = gameRef.current;
        if (cur.phase === 'awaiting-roll' && cur.turn === seat) setGame(applyRoll4(cur, value));
      }, NO_MOVE_MS);
      return;
    }
    setGame(applyRoll4(g, value));
  }

  function doMove(g: Game4, seat: number, token: number): void {
    // guard against stale/duplicate calls (e.g. a human tap racing the forced-move timer)
    if (g.phase !== 'awaiting-move' || g.turn !== seat || !g.legal.includes(token)) return;
    const oldRel = g.positions[seat]?.[token] ?? -1;
    const res = applyMove4(g, token);
    const newRel = res.state.positions[seat]?.[token] ?? oldRel;
    const steps = oldRel >= 0 ? Math.max(1, newRel - oldRel) : 1;
    animRef.current = steps * WALK_STEP_MS + WALK_TWEEN_MS;
    if (res.events.capture) playCapture();
    maybeBotEmote(seat, res.events.capture);
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
    // doRoll/doMove are stable via gameRef; re-run only when the game state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game]);

  const myTurn = game.turn === mySeat;
  const canRoll = myTurn && game.phase === 'awaiting-roll' && !passing;
  const activeSeat = game.turn;

  // Only show the die value/animation for the seat whose roll it actually is —
  // otherwise a new player's die shows the PREVIOUS player's number until they roll.
  const shown = roll && roll.seat === activeSeat ? roll : null;
  const dieValue = shown?.value ?? 6;
  const rollKey = shown?.key ?? 0;

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
    clearTimeout(passTimer.current);
    setPassing(false);
    setRoll(null);
    dispatch({ type: 'CLEAR_EMOTES' });
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
          <EmoteBar onEmote={sendEmote} dir="down" />
          <GiftBar recipients={giftTargets} onGift={sendGift} dir="down" />
          <button className="chromebtn" aria-label="leave" onClick={onLeave}>
            ✕
          </button>
        </div>

        {/* top corner avatars: Ana (left) / Young (right); die appears beside the active one */}
        <div className="avrow">
          <div className="avrow__side">
            <span className="emoteanchor"><EmoteFloat seat={1} /><GiftFloat seat={1} /><SeatAvatar name="Ana" flag={seatFlag(1)} frame={seatFrame(1)} avatar={seatAvatar(1)} active={activeSeat === 1} /></span>
            {activeSeat === 1 && <SeatDie value={dieValue} rollKey={rollKey} />}
          </div>
          <div className="avrow__side">
            {activeSeat === 2 && <SeatDie value={dieValue} rollKey={rollKey} />}
            <span className="emoteanchor"><EmoteFloat seat={2} /><GiftFloat seat={2} /><SeatAvatar name="Young" flag={seatFlag(2)} frame={seatFrame(2)} avatar={seatAvatar(2)} active={activeSeat === 2} /></span>
          </div>
        </div>

        <Board4
          game={game}
          mySeat={mySeat}
          onTokenTap={(token) => myTurn && game.phase === 'awaiting-move' && doMove(gameRef.current, mySeat, token)}
          banners={PLAYERS.map((p, seat) => ({ seat, name: p.name, flag: seatFlag(seat), active: seat === activeSeat }))}
        />

        {/* bottom corner avatars: YOU (left) / Dragan (right) */}
        <div className="avrow">
          <div className="avrow__side">
            <span className="emoteanchor"><EmoteFloat seat={0} /><GiftFloat seat={0} /><SeatAvatar name="YOU" flag={seatFlag(0)} frame={seatFrame(0)} avatar={seatAvatar(0)} active={myTurn} /></span>
            {myTurn && (
              <button
                className="ludodie ludodie--tap"
                disabled={!canRoll}
                onClick={() => canRoll && doRoll(gameRef.current, mySeat)}
                aria-label="your die"
              >
                <Die value={dieValue} rollKey={rollKey} skin={mySkin} />
              </button>
            )}
          </div>
          <div className="avrow__side">
            {activeSeat === 3 && <SeatDie value={dieValue} rollKey={rollKey} />}
            <span className="emoteanchor"><EmoteFloat seat={3} /><GiftFloat seat={3} /><SeatAvatar name="Dragan" flag={seatFlag(3)} frame={seatFrame(3)} avatar={seatAvatar(3)} active={activeSeat === 3} /></span>
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
