import { useCallback, useRef } from 'react';
import type { StakeCents } from '@ludo/shared';
import { LocalBotSession, RemoteSession, type GameSession, type SessionEvents } from './lib/session';
import { useAppDispatch, useAppState } from './state/store';
import { Lobby } from './screens/Lobby';
import { Matchmaking } from './screens/Matchmaking';
import { GameScreen } from './screens/GameScreen';
import { EndScreen } from './screens/EndScreen';
import { FairnessModal, Toast } from './components/ui';
import { t } from './lib/i18n';

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:8787';

export default function App() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const sessionRef = useRef<GameSession | null>(null);

  const makeEvents = useCallback((): SessionEvents => {
    return {
      onMatchFound: (match) => dispatch({ type: 'MATCH_FOUND', match }),
      onState: (game) => dispatch({ type: 'GAME_STATE', game }),
      onDice: (value, index, seat) => dispatch({ type: 'DICE', value, index, seat }),
      onMoved: (game, capture) => dispatch({ type: 'MOVED', game, capture }),
      onTurn: (seat, deadlineTs) => dispatch({ type: 'TURN', seat, deadlineTs }),
      onOver: (result) => dispatch({ type: 'GAME_OVER', result }),
      onInfo: (message) => dispatch({ type: 'TOAST', message }),
    };
  }, [dispatch]);

  const startMatch = useCallback(
    (stake: StakeCents) => {
      sessionRef.current?.dispose();
      dispatch({ type: 'START_MATCHMAKING', botMode: stake === 0 });
      const ev = makeEvents();
      if (stake === 0) {
        sessionRef.current = new LocalBotSession(ev, stake);
        return;
      }
      // PvP: real-time server, falls back to the local bot if unreachable
      sessionRef.current = new RemoteSession(ev, stake, SERVER_URL, () => {
        dispatch({ type: 'TOAST', message: t('offline') });
        sessionRef.current = new LocalBotSession(ev, stake);
      });
    },
    [dispatch, makeEvents],
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
      <FairnessModal />
      <Toast />
    </>
  );
}
