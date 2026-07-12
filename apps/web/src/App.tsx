import { useCallback, useEffect, useRef } from 'react';
import type { StakeCents } from '@ludo/shared';
import {
  LocalBotSession,
  RemoteSession,
  type GameSession,
  type JoinIntent,
  type SessionEvents,
} from './lib/session';
import { fmtUsd, saveRetention, useAppDispatch, useAppState } from './state/store';
import { Lobby } from './screens/Lobby';
import { Matchmaking } from './screens/Matchmaking';
import { GameScreen } from './screens/GameScreen';
import { Game4Screen } from './screens/Game4Screen';
import { EndScreen } from './screens/EndScreen';
import { DiceModal, FairnessModal, SettingsModal, StakingOverlay, Toast, WelcomeModal } from './components/ui';
import { sendLimits } from './lib/session';
import { connectWallet, lockStake, walletBalanceCents, type Wallet } from './lib/minipay';
import { playCapture, playDice, playWin } from './lib/sound';
import { recordGameResult } from './lib/diceSkins';
import { t } from './lib/i18n';

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:8787';

export default function App() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const sessionRef = useRef<GameSession | null>(null);
  const walletRef = useRef<Wallet | null>(null);
  const matchSeatRef = useRef<number>(0);

  // Persist the latest retention state so the lobby shows it before reconnecting.
  useEffect(() => {
    saveRetention({
      challenge: state.challenge,
      streak: state.streak,
      league: state.league,
      tickets: state.tickets,
      cashbackCents: state.cashbackCents,
      limits: state.limits,
    });
  }, [state.challenge, state.streak, state.league, state.tickets, state.cashbackCents, state.limits]);

  const refreshBalance = useCallback(
    async (wallet: Wallet) => {
      const cents = await walletBalanceCents(wallet).catch(() => null);
      if (cents !== null) dispatch({ type: 'SET_BALANCE', cents });
    },
    [dispatch],
  );

  /** Lock the stake on-chain for a staked match; leave the match on failure. */
  const stakeForMatch = useCallback(
    async (gameId: string, stakeCents: number) => {
      const wallet = walletRef.current;
      if (!wallet) return; // no wallet: simulated dev path
      dispatch({ type: 'STAKING', status: 'approving' });
      try {
        await lockStake(wallet, gameId, stakeCents, (status) => dispatch({ type: 'STAKING', status }));
        await refreshBalance(wallet);
      } catch (e) {
        dispatch({ type: 'STAKING', status: 'failed' });
        dispatch({ type: 'TOAST', message: t('stakeFailed') });
        sessionRef.current?.dispose();
        sessionRef.current = null;
        dispatch({ type: 'GO_LOBBY' });
        console.error('[stake] lock failed', e);
      }
    },
    [dispatch, refreshBalance],
  );

  const makeEvents = useCallback((): SessionEvents => {
    return {
      onMatchFound: (match) => {
        matchSeatRef.current = match.seat;
        dispatch({ type: 'MATCH_FOUND', match });
        if (match.stakeCents > 0) void stakeForMatch(match.gameId, match.stakeCents);
      },
      onState: (game) => dispatch({ type: 'GAME_STATE', game }),
      onDice: (value, index, seat) => {
        // own rolls already played the rattle on button press (no RTT lag)
        if (seat !== matchSeatRef.current) playDice();
        dispatch({ type: 'DICE', value, index, seat });
      },
      onMoved: (game, capture) => {
        if (capture) playCapture();
        dispatch({ type: 'MOVED', game, capture });
      },
      onTurn: (seat, deadlineTs) => dispatch({ type: 'TURN', seat, deadlineTs }),
      onOver: (result) => {
        const won = result.winner === (matchSeatRef.current ?? 0);
        if (won) playWin();
        recordGameResult(won); // local stats feed the dice-skin unlocks
        dispatch({ type: 'GAME_OVER', result });
        if (walletRef.current) void refreshBalance(walletRef.current);
      },
      onInfo: (message) => dispatch({ type: 'TOAST', message }),
      onChallenge: (challenge) => dispatch({ type: 'CHALLENGE_UPDATE', challenge }),
      onLeague: (league) => dispatch({ type: 'LEAGUE_UPDATE', league }),
      onStreak: (streak) => {
        dispatch({ type: 'STREAK_UPDATE', streak });
        if (streak.rewardGranted > 0) {
          dispatch({
            type: 'TOAST',
            message: `🔥 ${streak.days} ${t('days')} — +${streak.rewardGranted} 🎟️`,
          });
        }
      },
      onSettled: (txHash) => dispatch({ type: 'SETTLED', txHash }),
      onTableCreated: (code) => dispatch({ type: 'TABLE_CREATED', code }),
      onCashback: (cents, totalCents) => {
        dispatch({ type: 'CASHBACK', totalCents });
        if (cents > 0) dispatch({ type: 'TOAST', message: `💛 ${t('cashbackToast')} +${fmtUsd(cents)}` });
      },
      onLimits: (limits) => dispatch({ type: 'LIMITS_UPDATE', limits }),
      onGeo: (stakingBlocked) => dispatch({ type: 'GEO', stakingBlocked }),
      onRefunded: (txHash) => {
        dispatch({ type: 'REFUNDED', txHash });
        dispatch({ type: 'TOAST', message: t('refunded') });
        if (walletRef.current) void refreshBalance(walletRef.current);
      },
      onReconnecting: () => dispatch({ type: 'RECONNECTING' }),
      onResumed: (match, game) => {
        matchSeatRef.current = match.seat;
        dispatch({ type: 'RESUME', match, game });
      },
      onGone: () => {
        dispatch({ type: 'TOAST', message: t('connectionLost') });
        dispatch({ type: 'GO_LOBBY' });
      },
    };
  }, [dispatch, stakeForMatch, refreshBalance]);

  const startMatch = useCallback(
    async (stake: StakeCents) => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
      // Free/practice → local 4-player game (you + 3 bots); staked → 2-player PvP.
      if (stake === 0) {
        dispatch({ type: 'START_PRACTICE4' });
        return;
      }
      dispatch({ type: 'START_MATCHMAKING', botMode: false });

      // Staked game: connect the wallet up front so funds can be locked on match.
      if (!walletRef.current) {
        const wallet = await connectWallet().catch(() => null);
        if (wallet) {
          walletRef.current = wallet;
          void refreshBalance(wallet);
        } else {
          dispatch({ type: 'TOAST', message: t('noWallet') });
        }
      }

      const ev = makeEvents();
      // PvP: real-time server, falls back to the local bot if unreachable
      sessionRef.current = new RemoteSession(
        ev,
        stake,
        SERVER_URL,
        () => {
          dispatch({ type: 'TOAST', message: t('offline') });
          sessionRef.current = new LocalBotSession(ev, stake);
        },
        walletRef.current?.address,
      );
    },
    [dispatch, makeEvents, refreshBalance],
  );

  // Private tables (E4.4): open a remote session with a create/join intent.
  const openPrivate = useCallback(
    async (stake: StakeCents, intent: JoinIntent) => {
      sessionRef.current?.dispose();
      dispatch({ type: 'START_MATCHMAKING', botMode: false });
      if (stake > 0 && !walletRef.current) {
        const wallet = await connectWallet().catch(() => null);
        if (wallet) {
          walletRef.current = wallet;
          void refreshBalance(wallet);
        } else {
          dispatch({ type: 'TOAST', message: t('noWallet') });
        }
      }
      const ev = makeEvents();
      sessionRef.current = new RemoteSession(
        ev,
        stake,
        SERVER_URL,
        () => {
          dispatch({ type: 'TOAST', message: t('offline') });
          dispatch({ type: 'GO_LOBBY' });
        },
        walletRef.current?.address,
        intent,
      );
    },
    [dispatch, makeEvents, refreshBalance],
  );

  const createTable = useCallback(
    (stake: StakeCents) => void openPrivate(stake, { kind: 'create' }),
    [openPrivate],
  );

  // Join a table from a #/g/CODE link on first load.
  useEffect(() => {
    const m = /[#/]g\/([A-Z2-9]{6})/i.exec(window.location.hash || window.location.pathname);
    if (m) {
      history.replaceState(null, '', window.location.pathname); // clear the link
      void openPrivate(0, { kind: 'join', code: m[1]!.toUpperCase() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const roll = useCallback(() => sessionRef.current?.roll(), []);
  const move = useCallback((token: number) => sessionRef.current?.move(token), []);
  const rematch = useCallback(() => startMatch(state.stakeCents), [startMatch, state.stakeCents]);

  const applyLimits = useCallback(
    async (payload: { dailyLimitCents?: number; selfExcludeDays?: number }) => {
      const limits = await sendLimits(SERVER_URL, payload, walletRef.current?.address);
      if (limits) {
        dispatch({ type: 'LIMITS_UPDATE', limits });
        dispatch({ type: 'TOAST', message: t('rgSaved') });
      } else {
        dispatch({ type: 'TOAST', message: t('offline') });
      }
    },
    [dispatch],
  );

  return (
    <>
      {state.screen === 'lobby' && <Lobby onPlay={startMatch} onCreateTable={createTable} />}
      {state.screen === 'matchmaking' && <Matchmaking />}
      {state.screen === 'game' && state.practice4 && (
        <Game4Screen onLeave={() => dispatch({ type: 'GO_LOBBY' })} />
      )}
      {state.screen === 'game' && !state.practice4 && <GameScreen onRoll={roll} onMove={move} />}
      {state.screen === 'end' && <EndScreen onRematch={rematch} />}
      <WelcomeModal onStartFree={() => startMatch(0)} />
      <StakingOverlay />
      <FairnessModal />
      <DiceModal />
      <SettingsModal onApply={applyLimits} />
      <Toast />
    </>
  );
}
