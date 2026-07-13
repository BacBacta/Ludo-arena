import { useCallback, useEffect, useRef } from 'react';
import { TOS_VERSION, type StakeCents } from '@ludo/shared';
import {
  LocalBotSession,
  RemoteSession,
  type GameSession,
  type JoinIntent,
  type SessionEvents,
  type WalletAuth,
} from './lib/session';
import { fmtUsd, saveRetention, useAppDispatch, useAppState } from './state/store';
import { Lobby } from './screens/Lobby';
import { Matchmaking } from './screens/Matchmaking';
import { GameScreen } from './screens/GameScreen';
import { Game4Screen } from './screens/Game4Screen';
import { Game4OnlineScreen } from './screens/Game4OnlineScreen';
import { EndScreen } from './screens/EndScreen';
import { DiceModal, FairnessModal, LegalModal, RealityCheckModal, SettingsModal, StakingOverlay, Toast, WelcomeModal } from './components/ui';
import { sendLimits, buySkin } from './lib/session';
import { connectWallet, lockStake, walletBalanceCents, type Wallet } from './lib/minipay';
import { playCapture, playDice, playWin } from './lib/sound';
import { recordGameResult } from './lib/diceSkins';
import { t } from './lib/i18n';

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:8787';
/** Responsible-gaming reality check cadence — remind an actively-staking player. */
const REALITY_CHECK_MS = 20 * 60_000;

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
      ownedSkins: state.ownedSkins,
      limits: state.limits,
    });
  }, [state.challenge, state.streak, state.league, state.tickets, state.ownedSkins, state.limits]);

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
      onTickets: (granted, total, reason) => {
        dispatch({ type: 'TICKETS', total });
        if (granted > 0) {
          const label = reason === 'anti-tilt' ? t('antiTiltTicket') : t('freerollWonToast');
          dispatch({ type: 'TOAST', message: `${label} +${granted} 🎟️` });
        }
      },
      onLimits: (limits) => dispatch({ type: 'LIMITS_UPDATE', limits }),
      onSkins: (ownedIds) => dispatch({ type: 'OWNED_SKINS', ownedIds }),
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

  // Consent (18+/ToS) + wallet signer for staked play: consent goes in hello and
  // the signer answers the server's wallet-ownership nonce (SIWE). Both are read
  // through refs at call time — the pending staked action runs synchronously right
  // after the legal modal is accepted (before React re-renders), so makeAuth must
  // see the fresh acceptance from a ref, not from a render-captured state value.
  const consentRef = useRef(state.legalAccepted);
  if (state.legalAccepted) consentRef.current = true;
  const makeAuth = useCallback((): WalletAuth => {
    const wallet = walletRef.current;
    return {
      consent: consentRef.current ? { tosVersion: TOS_VERSION, age18: true } : undefined,
      signMessage: wallet
        ? (message: string) => wallet.walletClient.signMessage({ account: wallet.address, message })
        : undefined,
    };
  }, []);

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
        { kind: 'queue' },
        makeAuth(),
      );
    },
    [dispatch, makeEvents, refreshBalance, makeAuth],
  );

  // Private tables (E4.4): open a remote session with a create/join intent.
  const openPrivate = useCallback(
    async (stake: StakeCents, intent: JoinIntent) => {
      sessionRef.current?.dispose();
      dispatch({ type: 'START_MATCHMAKING', botMode: false });
      // Joining by code/link: the table's stake is unknown until the server
      // replies, so connect the wallet up-front — a staked table refuses
      // demo joiners (money-mode parity) and the stake must lock on match.
      if ((stake > 0 || intent.kind === 'join') && !walletRef.current) {
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
        makeAuth(),
      );
    },
    [dispatch, makeEvents, refreshBalance, makeAuth],
  );

  const createTable = useCallback(
    (stake: StakeCents) => void openPrivate(stake, { kind: 'create' }),
    [openPrivate],
  );

  // 4-player online Sit&Go: ticket-gated table for up to 4 humans + bot-fill.
  // Self-contained screen (owns its own Remote4 socket); just tear down any
  // 2-player session and switch screens.
  const startOnline4 = useCallback(() => {
    sessionRef.current?.dispose();
    sessionRef.current = null;
    dispatch({ type: 'START_ONLINE4' });
  }, [dispatch]);

  // Freeroll: ticket-gated free 1v1 on the server (no bot fallback — the entry
  // ticket only makes sense against a real opponent).
  const startFreeroll = useCallback(() => {
    sessionRef.current?.dispose();
    dispatch({ type: 'START_MATCHMAKING', botMode: false });
    const ev = makeEvents();
    sessionRef.current = new RemoteSession(
      ev,
      0,
      SERVER_URL,
      () => {
        dispatch({ type: 'TOAST', message: t('offline') });
        dispatch({ type: 'GO_LOBBY' });
      },
      walletRef.current?.address,
      { kind: 'freeroll' },
      makeAuth(),
    );
  }, [dispatch, makeEvents, makeAuth]);

  // Responsible-gaming reality check: while a player who has staked today keeps
  // playing, periodically remind them of time played + amount staked (read via a
  // ref so the interval isn't reset on every limits update).
  const sessionStart = useRef(Date.now());
  const limitsRef = useRef(state.limits);
  limitsRef.current = state.limits;
  useEffect(() => {
    const id = setInterval(() => {
      const l = limitsRef.current;
      if (l.stakedTodayCents > 0 && !l.selfExcludedUntil) dispatch({ type: 'REALITY_CHECK', open: true });
    }, REALITY_CHECK_MS);
    return () => clearInterval(id);
  }, [dispatch]);

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
  // True direct rematch: reuse the still-open session so the server can re-pair
  // the same opponent (it re-queues if they didn't ask / the cap is hit). Falls
  // back to a fresh session (local bot, or a dropped socket).
  const rematch = useCallback(() => {
    if (sessionRef.current?.rematch()) {
      dispatch({ type: 'START_MATCHMAKING', botMode: false });
    } else {
      void startMatch(state.stakeCents);
    }
  }, [dispatch, startMatch, state.stakeCents]);

  // Age (18+) + Terms/Privacy consent gate: required once before any staked action.
  const pendingStakeAction = useRef<(() => void) | null>(null);
  const gateStaked = useCallback(
    (stake: StakeCents, run: () => void) => {
      if (stake > 0 && !state.legalAccepted) {
        pendingStakeAction.current = run;
        dispatch({ type: 'LEGAL_MODAL', open: true });
        return;
      }
      run();
    },
    [state.legalAccepted, dispatch],
  );
  const onPlay = useCallback((stake: StakeCents) => gateStaked(stake, () => void startMatch(stake)), [gateStaked, startMatch]);
  const onCreateTable = useCallback((stake: StakeCents) => gateStaked(stake, () => createTable(stake)), [gateStaked, createTable]);

  const purchaseSkin = useCallback(
    async (skinId: string) => {
      const res = await buySkin(SERVER_URL, skinId, walletRef.current?.address);
      if (res) {
        dispatch({ type: 'OWNED_SKINS', ownedIds: res.ownedIds, tickets: res.tickets });
        dispatch({ type: 'SET_DICE_SKIN', id: skinId }); // equip what you just unlocked
        dispatch({ type: 'TOAST', message: t('skinUnlocked') });
      } else {
        dispatch({ type: 'TOAST', message: t('offline') });
      }
    },
    [dispatch],
  );

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
      {state.screen === 'lobby' && (
        <Lobby onPlay={onPlay} onCreateTable={onCreateTable} onFreeroll={startFreeroll} onPlay4={startOnline4} />
      )}
      {state.screen === 'matchmaking' && (
        <Matchmaking
          onCancel={() => {
            sessionRef.current?.dispose();
            sessionRef.current = null;
            dispatch({ type: 'GO_LOBBY' });
          }}
        />
      )}
      {state.screen === 'game' && state.practice4 && (
        <Game4Screen onLeave={() => dispatch({ type: 'GO_LOBBY' })} />
      )}
      {state.screen === 'game' && state.online4 && (
        <Game4OnlineScreen
          onLeave={() => dispatch({ type: 'GO_LOBBY' })}
          serverUrl={SERVER_URL}
          walletAddress={walletRef.current?.address}
          tickets={state.tickets}
          onSyncTickets={(total) => dispatch({ type: 'TICKETS', total })}
          onToast={(message) => dispatch({ type: 'TOAST', message })}
        />
      )}
      {state.screen === 'game' && !state.practice4 && !state.online4 && (
        <GameScreen onRoll={roll} onMove={move} onLeave={() => sessionRef.current?.resign()} />
      )}
      {state.screen === 'end' && <EndScreen onRematch={rematch} />}
      <LegalModal
        onAccept={() => {
          consentRef.current = true; // synchronous, so the pending staked action's hello carries consent
          dispatch({ type: 'ACCEPT_LEGAL' });
          const run = pendingStakeAction.current;
          pendingStakeAction.current = null;
          run?.();
        }}
      />
      <WelcomeModal onStartFree={() => startMatch(0)} />
      <StakingOverlay
        onCancel={() => {
          dispatch({ type: 'STAKING', status: 'failed' });
          dispatch({ type: 'TOAST', message: t('stakeFailed') });
          sessionRef.current?.dispose();
          sessionRef.current = null;
          dispatch({ type: 'GO_LOBBY' });
        }}
      />
      <FairnessModal />
      <DiceModal onBuy={purchaseSkin} />
      <SettingsModal onApply={applyLimits} />
      <RealityCheckModal
        minutesPlayed={Math.max(1, Math.round((Date.now() - sessionStart.current) / 60_000))}
        onBreak={() => void applyLimits({ selfExcludeDays: 1 })}
      />
      <Toast />
    </>
  );
}
