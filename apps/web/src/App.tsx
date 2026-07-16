import { useCallback, useEffect, useRef } from 'react';
import { TOS_VERSION, cosmeticCents, type StakeCents } from '@ludo/shared';
import {
  LocalBotSession,
  RemoteSession,
  type GameSession,
  type JoinIntent,
  type SessionEvents,
  type WalletAuth,
} from './lib/session';
import { saveRetention, useAppDispatch, useAppState } from './state/store';
import { Lobby } from './screens/Lobby';
import { Matchmaking } from './screens/Matchmaking';
import { GameScreen } from './screens/GameScreen';
import { Game4Screen } from './screens/Game4Screen';
import { Game4OnlineScreen } from './screens/Game4OnlineScreen';
import { EndScreen } from './screens/EndScreen';
import { DiceModal, FairnessModal, LegalModal, NoWalletSheet, ProfileEditor, ProfileSheet, RealityCheckModal, SettingsModal, StakingOverlay, Toast, WelcomeModal } from './components/ui';
import { sendLimits, buySkin, claimCosmetic, fetchProfile, pushIdentity } from './lib/session';
import { saveCustomIdentity } from './lib/profile';
import { connectWallet, isMiniPay, lockStake, lockStake4, buyCosmetic, walletBalanceCents, type Wallet, hasInjectedWallet } from './lib/minipay';
import type { StakeStatus } from './lib/escrow';
import { playCapture, playDice, playWelcome, playWin, startMusic, stopMusic } from './lib/sound';
import { recordGameResult } from './lib/diceSkins';
import { t } from './lib/i18n';

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:8787';
/** Responsible-gaming reality check cadence — remind an actively-staking player. */
const REALITY_CHECK_MS = 20 * 60_000;
/** Free 1v1: LAST-RESORT wait before auto-falling back to a bot. Kept long so the
 *  player actually STAYS in the queue and can meet others who arrive — an 8s
 *  fallback pulled everyone out before they could pair (→ "always the bot"). An
 *  impatient player has an explicit "play a bot" button instead. */
const FREE_MATCH_TIMEOUT_MS = 60_000;

export default function App() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const sessionRef = useRef<GameSession | null>(null);
  const walletRef = useRef<Wallet | null>(null);
  // Free-1v1 matchmaking fallback timer: cleared on match/cancel/new-flow.
  const freeFallback = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearFreeFallback = useCallback(() => {
    if (freeFallback.current) { clearTimeout(freeFallback.current); freeFallback.current = null; }
  }, []);
  // Whether the CURRENT search is a free 1v1 (→ offer a manual "play a bot" escape
  // on the searching screen). A ref: set before the matchmaking render.
  const freeSearchRef = useRef(false);
  const matchSeatRef = useRef<number>(0);
  // Gameplay pedagogy: a roll that ends the turn with NO move (no legal move, or
  // the three-sixes burn) looks like a silent bug — track the dice stream so the
  // UI can explain it. Reset on every match start/resume.
  const lastDiceRef = useRef<{ seat: number; value: number } | null>(null);
  const movedSinceDiceRef = useRef(true);
  const sixRunRef = useRef<{ seat: number; run: number }>({ seat: -1, run: 0 });

  // Persist the latest retention state so the lobby shows it before reconnecting.
  // Audio logo "on app open": browsers gate audio behind the first user
  // gesture, so the sonic logo fires on the session's FIRST pointerdown —
  // the closest the web platform allows to an opening sound.
  useEffect(() => {
    const fire = (): void => playWelcome();
    window.addEventListener('pointerdown', fire, { once: true });
    return () => window.removeEventListener('pointerdown', fire);
  }, []);

  // Festive landing music: a low background loop on the lobby only; stops in a
  // game and when sound is muted. (Autoplay is gated until the first gesture —
  // startMusic retries on the next pointerdown.)
  useEffect(() => {
    if (state.screen === 'lobby' && state.soundOn) startMusic();
    else stopMusic();
  }, [state.screen, state.soundOn]);

  useEffect(() => {
    saveRetention({
      challenge: state.challenge,
      streak: state.streak,
      league: state.league,
      tickets: state.tickets,
      ownedSkins: state.ownedSkins,
      limits: state.limits,
      profile: state.profile,
    });
  }, [state.challenge, state.streak, state.league, state.tickets, state.ownedSkins, state.limits, state.profile]);

  const refreshBalance = useCallback(
    async (wallet: Wallet) => {
      const cents = await walletBalanceCents(wallet).catch(() => null);
      if (cents !== null) dispatch({ type: 'SET_BALANCE', cents });
    },
    [dispatch],
  );

  /** Connect the wallet (MiniPay/injected) and refresh the on-chain balance.
   *  Staked play REQUIRES this — there is no simulated demo money. Returns true
   *  when connected; toasts (unless silent) when no wallet is available. */
  const connectWalletCta = useCallback(
    async (silent = false): Promise<boolean> => {
      // Already connected: re-read the balance so a transient first-fetch failure
      // self-heals on retry (else walletBacked could stay false forever and the
      // staked gate — which reads walletBacked — could never be passed).
      if (walletRef.current) {
        void refreshBalance(walletRef.current);
        return true;
      }
      const wallet = await connectWallet().catch(() => null);
      if (!wallet) {
        // No provider at all (Chrome mobile…): a toast is a dead end — open the
        // actionable MiniPay sheet instead. A present-but-refusing provider
        // (user rejected the prompt) keeps the simple toast.
        if (!silent) {
          if (!hasInjectedWallet()) dispatch({ type: 'NOWALLET', open: true });
          else dispatch({ type: 'TOAST', message: t('noWallet') });
        }
        return false;
      }
      walletRef.current = wallet;
      dispatch({ type: 'SET_WALLET_ADDRESS', address: wallet.address }); // dev cosmetic unlock
      void refreshBalance(wallet);
      return true;
    },
    [dispatch, refreshBalance],
  );

  // Inside MiniPay the wallet is ambient — connect silently on launch so the
  // header shows the real balance and the staked tiers are playable at once.
  useEffect(() => {
    if (isMiniPay()) void connectWalletCta(true);
  }, [connectWalletCta]);

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
        clearFreeFallback(); // a real opponent paired — cancel the bot fallback
        matchSeatRef.current = match.seat;
        lastDiceRef.current = null;
        movedSinceDiceRef.current = true;
        sixRunRef.current = { seat: -1, run: 0 };
        dispatch({ type: 'MATCH_FOUND', match });
        if (match.stakeCents > 0) void stakeForMatch(match.gameId, match.stakeCents);
      },
      onState: (game) => dispatch({ type: 'GAME_STATE', game }),
      onDice: (value, index, seat) => {
        // own rolls already played the rattle on button press (no RTT lag)
        if (seat !== matchSeatRef.current) playDice();
        // consecutive-6 run per roller (three 6s burn the turn — Ludo Club rule)
        const r = sixRunRef.current;
        if (value === 6) r.run = r.seat === seat ? r.run + 1 : 1;
        else r.run = 0;
        r.seat = seat;
        lastDiceRef.current = { seat, value };
        movedSinceDiceRef.current = false;
        dispatch({ type: 'DICE', value, index, seat });
      },
      onMoved: (game, capture) => {
        movedSinceDiceRef.current = true;
        if (capture) playCapture();
        dispatch({ type: 'MOVED', game, capture });
      },
      onTurn: (seat, deadlineTs) => {
        // The previous roll ended the turn with no move → say WHY (else it reads
        // as a bug): three 6s in a row burn the turn; otherwise no legal move.
        const last = lastDiceRef.current;
        if (last && !movedSinceDiceRef.current && last.seat !== seat) {
          if (last.value === 6 && sixRunRef.current.seat === last.seat && sixRunRef.current.run >= 3) {
            dispatch({ type: 'TOAST', message: t('threeSixes') });
          } else if (last.seat === matchSeatRef.current) {
            dispatch({ type: 'TOAST', message: `🎲 ${t('noMove')}` });
          }
          lastDiceRef.current = null;
        }
        dispatch({ type: 'TURN', seat, deadlineTs });
      },
      onAutoPlayed: (seat, count, max) => {
        const key = seat === matchSeatRef.current ? 'autoPlayedYou' : 'autoPlayedOpp';
        dispatch({ type: 'TOAST', message: `${t(key)} · ${count}/${max}` });
      },
      onEmote: (seat, id) => dispatch({ type: 'EMOTE', seat, id }),
      onGift: (from, to, id) => dispatch({ type: 'GIFT', from, to, id }), // GiftFlight plays the chime
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
      onProfile: (p) => dispatch({ type: 'PROFILE', profile: p }),
      onGeo: (stakingBlocked) => dispatch({ type: 'GEO', stakingBlocked }),
      onRefunded: (txHash) => {
        dispatch({ type: 'REFUNDED', txHash });
        dispatch({ type: 'TOAST', message: t('refunded') });
        if (walletRef.current) void refreshBalance(walletRef.current);
      },
      onReconnecting: () => dispatch({ type: 'RECONNECTING' }),
      onResumed: (match, game) => {
        matchSeatRef.current = match.seat;
        lastDiceRef.current = null;
        movedSinceDiceRef.current = true;
        sixRunRef.current = { seat: -1, run: 0 };
        dispatch({ type: 'RESUME', match, game });
      },
      onGone: () => {
        clearFreeFallback();
        dispatch({ type: 'TOAST', message: t('connectionLost') });
        dispatch({ type: 'GO_LOBBY' });
      },
      // The opponent clicked Rematch and is waiting → show Accept/Decline.
      onRematchOffer: (name) => dispatch({ type: 'REMATCH_OFFER', name }),
      // A rematch we were waiting on fell through → tell the player, return home.
      onRematchCancelled: (reason) => {
        dispatch({ type: 'REMATCH_CLEAR' });
        dispatch({ type: 'TOAST', message: reason === 'declined' ? t('rematchDeclined') : t('rematchLeft') });
        dispatch({ type: 'GO_LOBBY' });
      },
    };
  }, [dispatch, stakeForMatch, refreshBalance, clearFreeFallback]);

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
      // MiniPay does not support personal_sign — never offer a signer there (the
      // server trusts the auto-connected address without SIWE). Browsers still sign.
      signMessage:
        wallet && !isMiniPay()
          ? (message: string) => wallet.walletClient.signMessage({ account: wallet.address, message })
          : undefined,
    };
  }, []);

  const startMatch = useCallback(
    async (stake: StakeCents) => {
      clearFreeFallback();
      freeSearchRef.current = stake === 0; // free 1v1 → the searching screen offers a bot escape
      sessionRef.current?.dispose();
      sessionRef.current = null;

      // Free PLAY = a real ONLINE 1v1 (matchmaking, no wallet). Stay in the queue
      // (up to FREE_MATCH_TIMEOUT_MS) so players who arrive apart still pair; a
      // manual "play a bot" button handles impatience, and the server being
      // unreachable still falls back to a bot immediately.
      if (stake === 0) {
        dispatch({ type: 'START_MATCHMAKING', botMode: false });
        const ev = makeEvents();
        const toBot = (): void => {
          clearFreeFallback();
          sessionRef.current?.dispose();
          sessionRef.current = new LocalBotSession(ev, 0);
        };
        sessionRef.current = new RemoteSession(
          ev,
          0,
          SERVER_URL,
          () => { dispatch({ type: 'TOAST', message: t('offline') }); toBot(); }, // server down → bot
          walletRef.current?.address,
          { kind: 'queue' },
          makeAuth(),
        );
        freeFallback.current = setTimeout(toBot, FREE_MATCH_TIMEOUT_MS); // no human → bot
        return;
      }

      // Staked game: the wallet is REQUIRED (no simulated demo money) so the
      // stake can be locked on match. No wallet → stay in the lobby.
      if (!(await connectWalletCta())) return;
      dispatch({ type: 'START_MATCHMAKING', botMode: false });

      const ev = makeEvents();
      // Staked PvP: if the server is unreachable, fall back to a FREE local bot
      // game — never a simulated staked one (money must always be real).
      sessionRef.current = new RemoteSession(
        ev,
        stake,
        SERVER_URL,
        () => {
          dispatch({ type: 'TOAST', message: t('offline') });
          sessionRef.current = new LocalBotSession(ev, 0);
        },
        walletRef.current?.address,
        { kind: 'queue' },
        makeAuth(),
      );
    },
    [dispatch, makeEvents, connectWalletCta, makeAuth, clearFreeFallback],
  );

  // Manual escape from a free-1v1 search: leave the queue and play a bot now.
  const playBotNow = useCallback(() => {
    clearFreeFallback();
    freeSearchRef.current = false;
    sessionRef.current?.dispose();
    sessionRef.current = new LocalBotSession(makeEvents(), 0);
  }, [makeEvents, clearFreeFallback]);

  // Private tables (E4.4): open a remote session with a create/join intent.
  const openPrivate = useCallback(
    async (stake: StakeCents, intent: JoinIntent) => {
      sessionRef.current?.dispose();
      // Creating a staked table REQUIRES the wallet (no demo money). Joining by
      // code: the table's stake is unknown until the server replies, so only
      // ATTEMPT the connection — the server refuses staked joiners without one.
      if (stake > 0 && !(await connectWalletCta())) return;
      if (intent.kind === 'join') await connectWalletCta(true);
      freeSearchRef.current = false;
      dispatch({ type: 'START_MATCHMAKING', botMode: false });
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
    [dispatch, makeEvents, connectWalletCta, makeAuth],
  );

  const createTable = useCallback(
    (stake: StakeCents) => void openPrivate(stake, { kind: 'create' }),
    [openPrivate],
  );

  // 4-player online Sit&Go: ticket-gated table for up to 4 humans + bot-fill.
  // Self-contained screen (owns its own Remote4 socket); just tear down any
  // 2-player session and switch screens.
  const startOnline4 = useCallback(
    async (stake: StakeCents) => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
      // Staked 4-player table: the wallet is REQUIRED so the stake can lock on
      // match (no simulated demo money). No wallet → stay in the lobby.
      if (stake > 0 && !(await connectWalletCta())) return;
      dispatch({ type: 'START_ONLINE4', stakeCents: stake });
    },
    [dispatch, connectWalletCta],
  );

  // Freeroll: ticket-gated free 1v1 on the server (no bot fallback — the entry
  // ticket only makes sense against a real opponent).
  const startFreeroll = useCallback(() => {
    sessionRef.current?.dispose();
    freeSearchRef.current = false;
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

  /** Tap-on-avatar: open the profile sheet and fetch over a one-shot socket
   *  (works everywhere — lobby, in-game, end screen — no live session needed). */
  const profileFetching = useRef(false);
  const onViewProfile = useCallback(
    (pid: string) => {
      // In-flight guard: each fetch is a fresh socket, so ignore rapid re-taps
      // until the current lookup settles (bounds the per-tap connection cost).
      if (profileFetching.current) return;
      profileFetching.current = true;
      dispatch({ type: 'PROFILE_VIEW', pid });
      void fetchProfile(SERVER_URL, pid)
        .then((profile) => dispatch({ type: 'PROFILE_INFO', pid, profile }))
        .finally(() => {
          profileFetching.current = false;
        });
    },
    [dispatch],
  );

  /** Save an edited profile: cache locally + optimistic UI, then push to the
   *  server (which sanitizes the name) and adopt whatever it echoes back. */
  const onSaveProfile = useCallback(
    (name: string, flag: string, avatar: string) => {
      saveCustomIdentity(name, flag);
      dispatch({ type: 'PROFILE', profile: { name, flag } });
      dispatch({ type: 'EQUIP_AVATAR', id: avatar }); // 3D avatar or 'none' (→ flag)
      void pushIdentity(SERVER_URL, name, flag, walletRef.current?.address, avatar).then((eff) => {
        if (eff) {
          dispatch({ type: 'PROFILE', profile: { name: eff.name, flag: eff.flag } });
          saveCustomIdentity(eff.name, eff.flag);
        }
      });
      dispatch({ type: 'TOAST', message: t('profileSaved') });
    },
    [dispatch],
  );

  const roll = useCallback(() => sessionRef.current?.roll(), []);
  const move = useCallback((token: number) => sessionRef.current?.move(token), []);
  // True direct rematch: reuse the still-open session so the server can re-pair
  // the same opponent (it re-queues if they didn't ask / the cap is hit). Falls
  // back to a fresh session (local bot, or a dropped socket).
  const rematch = useCallback(() => {
    dispatch({ type: 'REMATCH_CLEAR' }); // accepting clears any incoming offer
    if (sessionRef.current?.rematch()) {
      freeSearchRef.current = false;
      dispatch({ type: 'START_MATCHMAKING', botMode: false });
    } else {
      void startMatch(state.stakeCents);
    }
  }, [dispatch, startMatch, state.stakeCents]);

  // Decline the opponent's offer, or just leave the end screen: tell a waiting
  // opponent (via the live session) instead of leaving them on "searching…".
  const declineRematch = useCallback(() => {
    sessionRef.current?.declineRematch();
    dispatch({ type: 'REMATCH_CLEAR' });
    dispatch({ type: 'GO_LOBBY' });
  }, [dispatch]);

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
  const onPlay4 = useCallback((stake: StakeCents) => gateStaked(stake, () => void startOnline4(stake)), [gateStaked, startOnline4]);
  // Offline 4-player practice (you + 3 bots) — the sheet's "Practice" option.
  const onPractice4 = useCallback(() => {
    sessionRef.current?.dispose();
    sessionRef.current = null;
    dispatch({ type: 'START_PRACTICE4' });
  }, [dispatch]);

  // Lock a seat's stake in LudoEscrowN for a staked 4-player table (E3.2 for 4p).
  const lockStakeForOnline4 = useCallback(
    async (gameId: string, stakeCents: number, onStatus?: (s: StakeStatus) => void): Promise<void> => {
      const wallet = walletRef.current;
      if (!wallet) throw new Error('no wallet connected');
      await lockStake4(wallet, gameId, stakeCents, onStatus);
      void refreshBalance(wallet);
    },
    [refreshBalance],
  );

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

  // Buy a cosmetic with cUSD (rec 6): pay on-chain via the CosmeticsStore, then
  // hand the tx to the server to unlock ownership. Dormant until the store is
  // deployed (the cUSD button only shows when cosmeticsCusdAvailable).
  const purchaseCosmeticCusd = useCallback(
    async (id: string) => {
      const priceCents = cosmeticCents(id);
      if (priceCents <= 0) return;
      try {
        const wallet = walletRef.current ?? (await connectWallet());
        if (!wallet) {
          dispatch({ type: 'TOAST', message: t('offline') });
          return;
        }
        walletRef.current = wallet;
        dispatch({ type: 'STAKING', status: 'joining' });
        const { buyTxHash } = await buyCosmetic(wallet, id, priceCents);
        dispatch({ type: 'STAKING', status: 'idle' });
        const res = await claimCosmetic(SERVER_URL, buyTxHash, id, wallet.address);
        if (res) {
          dispatch({ type: 'OWNED_SKINS', ownedIds: res.ownedIds, tickets: res.tickets });
          dispatch({ type: 'SET_DICE_SKIN', id });
          dispatch({ type: 'TOAST', message: t('skinUnlocked') });
          void refreshBalance(wallet);
        } else {
          dispatch({ type: 'TOAST', message: t('offline') });
        }
      } catch {
        dispatch({ type: 'STAKING', status: 'idle' });
        dispatch({ type: 'TOAST', message: t('offline') });
      }
    },
    [dispatch, refreshBalance],
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
        <Lobby onPlay={onPlay} onCreateTable={onCreateTable} onFreeroll={startFreeroll} onPlay4={onPlay4} onPractice4={onPractice4} onConnectWallet={connectWalletCta} onViewProfile={onViewProfile} />
      )}
      {state.screen === 'matchmaking' && (
        <Matchmaking
          onCancel={() => {
            clearFreeFallback();
            sessionRef.current?.dispose();
            sessionRef.current = null;
            dispatch({ type: 'GO_LOBBY' });
          }}
          onPlayBot={freeSearchRef.current ? playBotNow : undefined}
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
          stakeCents={state.online4Stake}
          auth={makeAuth()}
          lockStake={lockStakeForOnline4}
          onToast={(message) => dispatch({ type: 'TOAST', message })}
          onViewProfile={onViewProfile}
        />
      )}
      {state.screen === 'game' && !state.practice4 && !state.online4 && (
        <GameScreen onRoll={roll} onMove={move} onLeave={() => sessionRef.current?.resign()} onEmote={(id) => sessionRef.current?.emote(id)} onGift={(to, id) => sessionRef.current?.gift(to, id)} onViewProfile={onViewProfile} />
      )}
      {state.screen === 'end' && <EndScreen onRematch={rematch} onDecline={declineRematch} />}
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
      <ProfileSheet />
      <ProfileEditor onSave={onSaveProfile} />
      <DiceModal onBuy={purchaseSkin} onBuyCusd={purchaseCosmeticCusd} />
      <SettingsModal onApply={applyLimits} />
      <RealityCheckModal
        minutesPlayed={Math.max(1, Math.round((Date.now() - sessionStart.current) / 60_000))}
        onBreak={() => void applyLimits({ selfExcludeDays: 1 })}
      />
      <NoWalletSheet />
      <Toast />
    </>
  );
}
