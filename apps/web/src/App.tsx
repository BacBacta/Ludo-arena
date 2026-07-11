import { useCallback, useRef } from 'react';
import type { StakeCents } from '@ludo/shared';
import { LocalBotSession, RemoteSession, type GameSession, type SessionEvents } from './lib/session';
import { saveChallenge, useAppDispatch, useAppState } from './state/store';
import { Lobby } from './screens/Lobby';
import { Matchmaking } from './screens/Matchmaking';
import { GameScreen } from './screens/GameScreen';
import { EndScreen } from './screens/EndScreen';
import { FairnessModal, StakingOverlay, Toast } from './components/ui';
import { connectWallet, lockStake, walletBalanceCents, type Wallet } from './lib/minipay';
import { t } from './lib/i18n';

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:8787';

export default function App() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const sessionRef = useRef<GameSession | null>(null);
  const walletRef = useRef<Wallet | null>(null);

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
        dispatch({ type: 'MATCH_FOUND', match });
        if (match.stakeCents > 0) void stakeForMatch(match.gameId, match.stakeCents);
      },
      onState: (game) => dispatch({ type: 'GAME_STATE', game }),
      onDice: (value, index, seat) => dispatch({ type: 'DICE', value, index, seat }),
      onMoved: (game, capture) => dispatch({ type: 'MOVED', game, capture }),
      onTurn: (seat, deadlineTs) => dispatch({ type: 'TURN', seat, deadlineTs }),
      onOver: (result) => {
        dispatch({ type: 'GAME_OVER', result });
        if (walletRef.current) void refreshBalance(walletRef.current);
      },
      onInfo: (message) => dispatch({ type: 'TOAST', message }),
      onChallenge: (challenge) => {
        dispatch({ type: 'CHALLENGE_UPDATE', challenge });
        saveChallenge(challenge); // cache so the lobby shows it before the next connect
      },
      onSettled: (txHash) => dispatch({ type: 'SETTLED', txHash }),
      onRefunded: (txHash) => {
        dispatch({ type: 'REFUNDED', txHash });
        dispatch({ type: 'TOAST', message: t('refunded') });
        if (walletRef.current) void refreshBalance(walletRef.current);
      },
      onReconnecting: () => dispatch({ type: 'RECONNECTING' }),
      onResumed: (match, game) => dispatch({ type: 'RESUME', match, game }),
      onGone: () => {
        dispatch({ type: 'TOAST', message: t('connectionLost') });
        dispatch({ type: 'GO_LOBBY' });
      },
    };
  }, [dispatch, stakeForMatch, refreshBalance]);

  const startMatch = useCallback(
    async (stake: StakeCents) => {
      sessionRef.current?.dispose();
      dispatch({ type: 'START_MATCHMAKING', botMode: stake === 0 });

      // Staked game: connect the wallet up front so funds can be locked on match.
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
      if (stake === 0) {
        sessionRef.current = new LocalBotSession(ev, stake);
        return;
      }
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

  const roll = useCallback(() => sessionRef.current?.roll(), []);
  const move = useCallback((token: number) => sessionRef.current?.move(token), []);
  const rematch = useCallback(() => startMatch(state.stakeCents), [startMatch, state.stakeCents]);

  return (
    <>
      {state.screen === 'lobby' && <Lobby onPlay={startMatch} />}
      {state.screen === 'matchmaking' && <Matchmaking />}
      {state.screen === 'game' && <GameScreen onRoll={roll} onMove={move} />}
      {state.screen === 'end' && <EndScreen onRematch={rematch} />}
      <StakingOverlay />
      <FairnessModal />
      <Toast />
    </>
  );
}
