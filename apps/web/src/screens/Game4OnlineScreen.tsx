/**
 * 4-player online Sit&Go screen — ticket entry, up to 4 humans + bot-fill,
 * server-authoritative (Room4 on the server). Renders the same Ludo-Club board
 * as the local practice screen but is driven entirely by Remote4 messages: the
 * client only sends roll/move/resign and paints what the server broadcasts.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Board4 } from '../components/Board4';
import { Die3D } from '../components/Die3D';
import { SeatAvatar, SeatDie, WHITE_DIE } from '../components/Seat4';
import { EmoteBar, EmoteFloat } from '../components/Emote';
import { IconMenu } from '../components/icons';
import type { Player4Info } from '@ludo/shared';
import type { Game4 } from '@ludo/game-engine';
import { Remote4, type Match4Info, type Over4Info } from '../lib/remote4';
import type { WalletAuth } from '../lib/session';
import type { StakeStatus } from '../lib/escrow';
import { playCapture, playDice, playWin } from '../lib/sound';
import { fmtUsd, useAppDispatch } from '../state/store';
import { t } from '../lib/i18n';

type Status = 'connecting' | 'waiting' | 'playing' | 'over';
interface Roll4 { seat: number; value: number; key: number }

/** Fixed board corner for each seat (seat colours are painted in place, not
 *  rotated to the local player): 1=top-left, 2=top-right, 0=bottom-left,
 *  3=bottom-right — matches Board4's quadrant layout. */
const CORNER: Record<number, 'left' | 'right'> = { 1: 'left', 2: 'right', 0: 'left', 3: 'right' };

export function Game4OnlineScreen({
  onLeave,
  serverUrl,
  walletAddress,
  stakeCents,
  auth,
  lockStake,
  onToast,
}: {
  onLeave(): void;
  serverUrl: string;
  walletAddress?: string;
  stakeCents: number; // per-seat stake; 0 = free table
  auth?: WalletAuth;
  lockStake(gameId: string, stakeCents: number, onStatus?: (s: StakeStatus) => void): Promise<void>;
  onToast(message: string): void;
}) {
  const dispatch = useAppDispatch();
  const remoteRef = useRef<Remote4 | null>(null);

  const [status, setStatus] = useState<Status>('connecting');
  const [players, setPlayers] = useState<Player4Info[]>([]);
  const [mySeat, setMySeat] = useState(0);
  const [game, setGame] = useState<Game4 | null>(null);
  const [activeTurn, setActiveTurn] = useState(0);
  const [shown, setShown] = useState<Roll4 | null>(null);
  const [over, setOver] = useState<Over4Info | null>(null);
  const [rolling, setRolling] = useState(false);
  const [potCents, setPotCents] = useState(0); // cUSD pot (0 = free table)
  const [staking, setStaking] = useState<StakeStatus | null>(null); // locking my stake on-chain
  const [settledTx, setSettledTx] = useState<string | null>(null); // payout confirmed on-chain

  const mySeatRef = useRef(mySeat);
  mySeatRef.current = mySeat;
  const winFired = useRef(false);
  const overRef = useRef<Over4Info | null>(null);

  // Open the session once on mount; a fresh Remote4 is created per "play again".
  useEffect(() => {
    connect();
    return () => remoteRef.current?.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connect(): void {
    remoteRef.current?.dispose();
    winFired.current = false;
    overRef.current = null;
    dispatch({ type: 'CLEAR_EMOTES' }); // rematch reuses this screen; drop last game's emotes
    setStatus('connecting');
    setPlayers([]);
    setGame(null);
    setShown(null);
    setOver(null);
    setRolling(false);
    setStaking(null);
    setSettledTx(null);
    remoteRef.current = new Remote4(
      {
        onQueued: () => setStatus((s) => (s === 'connecting' ? 'waiting' : s)),
        onMatch: (m: Match4Info) => {
          setPlayers(m.players);
          setMySeat(m.seat);
          setPotCents(m.potCents);
          // Staked table: lock my seat's stake on-chain now. The server waits for
          // all 4 deposits (Active) before dealing, then game.state4 arrives.
          if (m.stakeCents > 0) {
            setStaking('approving');
            lockStake(m.gameId, m.stakeCents, setStaking)
              .then(() => setStaking(null))
              .catch(() => {
                onToast(t('stakeFailed'));
                onLeave();
              });
          }
        },
        onState: (state) => {
          setGame(state);
          setActiveTurn(state.turn);
          setStatus('playing');
        },
        onDice: (value, index, seat) => {
          setShown({ seat, value, key: index });
          setRolling(false);
          if (seat !== mySeatRef.current) playDice();
        },
        onMoved: (_seat, _token, capture, state) => {
          if (capture) playCapture();
          setGame(state);
          setRolling(false);
        },
        onTurn: (seat) => {
          setActiveTurn(seat);
          setRolling(false);
        },
        onEmote: (seat, id) => dispatch({ type: 'EMOTE', seat, id }),
        onOver: (info) => {
          overRef.current = info;
          setOver(info);
          setStatus('over');
          setActiveTurn(-1);
          if (info.winner === mySeatRef.current && !winFired.current) {
            winFired.current = true;
            playWin();
          }
        },
        onSettled: (txHash) => setSettledTx(txHash),
        onRefunded: () => {
          // Staked table didn't fill → stakes refunded on-chain. Back to lobby.
          onToast(t('refunded'));
          onLeave();
        },
        onError: (message) => {
          onToast(message);
          onLeave();
        },
        onGone: () => {
          // A drop before the game ends is terminal in v1 (no resume). Once the
          // result is in, a late socket close must not yank the player off it.
          if (!overRef.current) {
            onToast(t('connectionLost'));
            onLeave();
          }
        },
      },
      serverUrl,
      walletAddress,
      stakeCents,
      auth,
    );
  }

  const canRoll = status === 'playing' && !!game && game.turn === mySeat && game.phase === 'awaiting-roll' && !rolling;

  function doRoll(): void {
    if (!canRoll) return;
    setRolling(true);
    playDice(); // own roll: play immediately (no server round-trip lag)
    remoteRef.current?.roll();
  }
  function doMove(token: number): void {
    if (!game || game.turn !== mySeat || game.phase !== 'awaiting-move' || !game.legal.includes(token)) return;
    remoteRef.current?.move(token);
  }

  const banners = useMemo(
    () =>
      players.map((p, seat) => ({
        seat,
        name: seat === mySeat ? t('you') : p.name,
        flag: p.flag,
        active: seat === activeTurn,
      })),
    [players, mySeat, activeTurn],
  );

  // -------- waiting / connecting / staking: a centred card, no board yet --------
  if (!game) {
    const title = staking ? (staking === 'approving' ? t('stakingApprove') : t('stakingJoin')) : t('findingPlayers');
    const sub = staking ? t('stakingHint') : stakeCents > 0 ? `${t('win')} ${fmtUsd(potCents)}` : t('fourPlayerDesc');
    return (
      <div className="screen screen--game">
        <div className="g4over" role="dialog" aria-modal="true" aria-label={title}>
          <div className="g4over__card">
            <div className="g4over__emoji" aria-hidden="true">{staking ? '🔒' : '🎲'}</div>
            <div className="g4over__title">{title}</div>
            <div className="g4over__sub">{sub}</div>
            <button className="btn btn--ghost" onClick={onLeave}>{t('cancel')}</button>
          </div>
        </div>
      </div>
    );
  }

  const dieVal = shown?.value ?? 6;
  const dieKey = shown?.key ?? 0;
  const iWon = over?.winner === mySeat;
  const winnerName = over ? (over.winner === mySeat ? t('you') : players[over.winner]?.name ?? '') : '';

  /**
   * One board corner: the grey avatar plus, on the inner side, either this
   * player's rolled die or — for MY seat, for the whole of my turn — the tap
   * button (kept mounted through awaiting-move so the die doesn't remount and
   * lose its roll animation, exactly like the practice screen). A plain render
   * function (not a nested component) so React keeps the Die3D identity stable.
   */
  function renderCorner(seat: number): JSX.Element {
    const active = activeTurn === seat;
    const name = seat === mySeat ? t('you') : players[seat]?.name ?? '';
    const flag = players[seat]?.flag;
    const myTurnHere = seat === mySeat && activeTurn === mySeat && status === 'playing';
    const dieHere = shown?.seat === seat;

    const inner = myTurnHere ? (
      <button className="ludodie ludodie--tap" disabled={!canRoll} onClick={doRoll} aria-label="your die">
        <Die3D value={dieHere ? dieVal : 6} rollKey={dieHere ? dieKey : 0} skin={WHITE_DIE} />
      </button>
    ) : dieHere ? (
      <SeatDie value={dieVal} rollKey={dieKey} />
    ) : null;

    const av = (
      <span className="emoteanchor">
        <EmoteFloat seat={seat} />
        <SeatAvatar name={name} flag={flag} active={active} />
      </span>
    );
    return <div className="avrow__side">{CORNER[seat] === 'left' ? <>{av}{inner}</> : <>{inner}{av}</>}</div>;
  }

  return (
    <div className="screen screen--game">
      <div className="gamewrap">
        <div className="gametop">
          <button className="chromebtn" aria-label="menu" onClick={() => dispatch({ type: 'SETTINGS', open: true })}>
            <IconMenu />
          </button>
          {/* cUSD pot chip — hidden on a free table (keeps the top bar balanced) */}
          <div className="coinchip" style={{ visibility: potCents > 0 ? 'visible' : 'hidden' }}>
            <span className="coinchip__c" /> {fmtUsd(potCents)}
          </div>
          <EmoteBar onEmote={(id) => remoteRef.current?.emote(id)} dir="down" />
          <button className="chromebtn" aria-label="leave" onClick={onLeave}>
            ✕
          </button>
        </div>

        {/* top corners: seat 1 (left) / seat 2 (right) */}
        <div className="avrow">
          {renderCorner(1)}
          {renderCorner(2)}
        </div>

        <Board4 game={game} mySeat={mySeat} onTokenTap={doMove} banners={banners} />

        {/* bottom corners: seat 0 (left) / seat 3 (right) */}
        <div className="avrow">
          {renderCorner(0)}
          {renderCorner(3)}
        </div>
      </div>

      {over && (
        <div className="g4over" role="dialog" aria-modal="true" aria-label={iWon ? t('victory') : t('defeat')}>
          <div className="g4over__card">
            <div className="g4over__emoji" aria-hidden="true">{iWon ? '🏆' : '🎲'}</div>
            <div className="g4over__title">{iWon ? t('victory') : `${winnerName} — ${t('defeat')}`}</div>
            <div className="g4over__sub">{iWon && over.payoutCents > 0 ? `+${fmtUsd(over.payoutCents)} USDT` : t('fourPlayer')}</div>
            {iWon && over.payoutCents > 0 && (
              <div className="muted" style={{ fontSize: 12 }}>{settledTx ? t('settled') : t('stakingHint')}</div>
            )}
            <button className="btn" onClick={connect}>{t('rematch')}</button>
            <button className="btn btn--ghost" onClick={onLeave}>{t('home')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
