/**
 * 4-player online Sit&Go screen — ticket entry, up to 4 humans + bot-fill,
 * server-authoritative (Room4 on the server). Renders the same Ludo-Club board
 * as the local practice screen but is driven entirely by Remote4 messages: the
 * client only sends roll/move/resign and paints what the server broadcasts.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Board4, seatAtQuad4, shownQuad4 } from '../components/Board4';
import { Die } from '../components/DiePremium';
import { SeatAvatar, SeatDie } from '../components/Seat4';
import { EmoteBar, EmoteFloat, GiftBar, GiftFloat, type GiftTarget } from '../components/Emote';
import { IconMenu } from '../components/icons';
import type { Player4Info } from '@ludo/shared';
import type { Game4 } from '@ludo/game-engine';
import { Remote4, type Match4Info, type Over4Info } from '../lib/remote4';
import type { WalletAuth } from '../lib/session';
import type { StakeStatus } from '../lib/escrow';
import { playCapture, playDice, playWin } from '../lib/sound';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { skinById } from '../lib/diceSkins';
import { t } from '../lib/i18n';

type Status = 'connecting' | 'waiting' | 'playing' | 'over';
interface Roll4 { seat: number; value: number; key: number }

/** Which side of its row a QUADRANT sits on: 0=bottom-left, 1=top-left,
 *  2=top-right, 3=bottom-right — matches Board4's quadrant layout. Board4 spins
 *  the board so the local player is always bottom-left, so these are keyed by the
 *  DISPLAYED quadrant (see shownQuad4), never by the raw seat. */
const CORNER: Record<number, 'left' | 'right'> = { 1: 'left', 2: 'right', 0: 'left', 3: 'right' };

export function Game4OnlineScreen({
  onLeave,
  serverUrl,
  walletAddress,
  stakeCents,
  auth,
  lockStake,
  onToast,
  onViewProfile,
}: {
  onLeave(): void;
  serverUrl: string;
  walletAddress?: string;
  stakeCents: number; // per-seat stake; 0 = free table
  auth?: WalletAuth;
  lockStake(gameId: string, stakeCents: number, onStatus?: (s: StakeStatus) => void): Promise<void>;
  onToast(message: string): void;
  /** Tap a human seat's avatar → their public profile sheet. */
  onViewProfile(pid: string): void;
}) {
  const dispatch = useAppDispatch();
  const mySkin = skinById(useAppState().diceSkin); // my equipped die (shown on my rolls)
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

  // Post-roll grace: keeps MY die button visible while its tumble finishes even
  // though the server may pass the turn the instant the roll lands (auto-move).
  const [myGrace, setMyGrace] = useState(false);
  useEffect(() => {
    if (!shown || shown.seat !== mySeat) return;
    setMyGrace(true);
    const id = setTimeout(() => setMyGrace(false), 800);
    return () => clearTimeout(id);
  }, [shown, mySeat]);

  const mySeatRef = useRef(mySeat);
  mySeatRef.current = mySeat;
  const playersRef = useRef<Player4Info[]>(players);
  playersRef.current = players;
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
        onGift: (from, to, id) => {
          dispatch({ type: 'GIFT', from, to, id }); // GiftFloat plays the chime
          if (to === mySeatRef.current && from !== to) onToast(`${playersRef.current[from]?.name ?? ''} ${t('giftFrom')} ${id}`);
        },
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
    playDice(mySkin.sound); // own roll: my die's own sound, immediately (no RTT lag)
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
        // My own quadrant shows my REAL name (the one the server broadcast to
        // everyone), so all screens display identical labels — a localized "You"
        // matched nothing on the other players' screens and read as a mismatch.
        name: seat === mySeat ? p.name || t('you') : p.name,
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
    const name = seat === mySeat ? players[seat]?.name || t('you') : players[seat]?.name ?? '';
    const flag = players[seat]?.flag;
    const frame = players[seat]?.frame;
    const avatar = players[seat]?.avatar; // server echoes each seat's chosen avatar (incl. mine)
    const myTurnHere = seat === mySeat && activeTurn === mySeat && status === 'playing';
    const dieHere = shown?.seat === seat;

    // Every corner's die stays MOUNTED and hides via CSS (huddie--idle pattern):
    // a freshly-mounted Die3D can't transition, so swapping the element in at
    // roll time played no tumble — the value just popped in. My own corner keeps
    // the tap button through a post-roll grace window too, because an auto-move
    // passes the turn the instant the roll lands and unmounting right then cut
    // my tumble short (the roll seemed to happen at another corner).
    const inner = seat === mySeat ? (
      <button
        className={`ludodie ludodie--tap${myTurnHere || myGrace ? '' : ' ludodie--idle'}`}
        disabled={!canRoll}
        onClick={doRoll}
        aria-label="your die"
        aria-hidden={!(myTurnHere || myGrace)}
      >
        <Die value={dieHere ? dieVal : 6} rollKey={dieHere ? dieKey : 0} skin={mySkin} />
      </button>
    ) : (
      <SeatDie value={dieHere ? dieVal : 1} rollKey={dieHere ? dieKey : 0} idle={!dieHere} />
    );

    const av = (
      <span className="emoteanchor">
        <EmoteFloat seat={seat} />
        <GiftFloat seat={seat} />
        {players[seat]?.pid && !players[seat]?.bot ? (
          <button className="avtap" aria-label={`${name} profile`} onClick={() => onViewProfile(players[seat]!.pid!)}>
            <SeatAvatar name={name} flag={flag} frame={frame} avatar={avatar} active={active} />
          </button>
        ) : (
          <SeatAvatar name={name} flag={flag} frame={frame} avatar={avatar} active={active} />
        )}
      </span>
    );
    return <div className="avrow__side">{CORNER[shownQuad4(seat, mySeat)] === 'left' ? <>{av}{inner}</> : <>{inner}{av}</>}</div>;
  }

  // Gift recipients: every seated opponent (humans + bots — all are "in the
  // game"). The 🎁 bar lets you pick who receives it.
  const giftTargets: GiftTarget[] = players
    .map((p, seat) => ({ seat, name: p.name, flag: p.flag }))
    .filter((r) => r.seat !== mySeat);

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
          <GiftBar recipients={giftTargets} onGift={(to, id) => remoteRef.current?.gift(to, id)} dir="down" />
          <button className="chromebtn" aria-label="leave" onClick={onLeave}>
            ✕
          </button>
        </div>

        {/* top corners: whoever the spun board draws in quadrant 1 (left) / 2 (right) */}
        <div className="avrow">
          {renderCorner(seatAtQuad4(1, mySeat))}
          {renderCorner(seatAtQuad4(2, mySeat))}
        </div>

        <Board4 game={game} mySeat={mySeat} onTokenTap={doMove} banners={banners} />

        {/* bottom corners: quadrant 0 (left) is ALWAYS me / 3 (right) */}
        <div className="avrow">
          {renderCorner(seatAtQuad4(0, mySeat))}
          {renderCorner(seatAtQuad4(3, mySeat))}
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
