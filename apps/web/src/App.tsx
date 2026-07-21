import { useCallback, useEffect, useRef } from 'react';
import { applyMove } from '@ludo/game-engine';
import type { GameState } from '@ludo/game-engine';
import { TOS_VERSION, cosmeticById, cosmeticCents, SEASON_PREMIUM, RACE_STAKE_CENTS, type StakeCents } from '@ludo/shared';
import { syncLobby,
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
import { ChallengeOfferModal, CollectionSheet, ComebackModal, DiceModal, DocModal, FairnessModal, GiftCosmeticModal, HelpModal, LegalModal, NoWalletSheet, ProfileEditor, ProfileSheet, RealityCheckModal, SettingsModal, StakingOverlay, Toast } from './components/ui';
import { SeasonSheet } from './components/SeasonSheet';
import { RaceSheet } from './components/RaceSheet';
import { ProgressionSheet } from './components/ProgressionSheet';
import { sendLimits, sendFriendAction, sendFriendGift, buySkin, claimCollection, claimCosmetic, claimSeasonReward, buySeasonPremium, buyStreakFreeze, fetchProfile, pushIdentity, sendRaceClaim, sendRaceSeed, fetchRaceLeaderboard } from './lib/session';
import { getBurnerWallet, restoreBurnerWallet } from './lib/burner';
import { describeTxError } from './lib/txError';
import { saveCustomIdentity } from './lib/profile';
import { connectWallet, isMiniPay, lockStake, lockStake4, buyCosmetic, mintRacePass, racePassTokenId, walletBalanceCents, type Wallet, hasInjectedWallet } from './lib/minipay';
import { connectViaWalletConnect, walletConnectAvailable } from './lib/walletconnect';
import { activeChain } from './lib/chains';
import { WALK_STEP_MS, WALK_TWEEN_MS } from './lib/pacing';
import type { StakeStatus } from './lib/escrow';
import { playCapture, playDice, playWelcome, playWin, startMusic, stopMusic } from './lib/sound';
import { recordGameResult, skinById } from './lib/diceSkins';
import { t } from './lib/i18n';

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:8787';
/** Failsafe for the in-flight action lock: if the server never echoes a roll/move
 *  (packet loss before the reconnect path kicks in) the UI must not wedge locked.
 *  Comfortably longer than any real RTT; the reconnect/resume flow clears it first
 *  in practice. */
const PENDING_TIMEOUT_MS = 5_000;

/** Longest forward walk (in cells) between two position grids — how far the pawn
 *  that just moved travels. Only one token advances per move, so the max positive
 *  delta IS that walk; captures send a token to base (delta < 0) and are ignored.
 *  Mirrors LocalBotSession's per-move animMs so online hand-offs pace identically. */
function walkSteps(prev: number[][], next: number[][]): number {
  let steps = 1; // entering from base is a single hop; never pace shorter than 1
  for (let seat = 0; seat < next.length; seat++) {
    const prevRow = prev[seat];
    const nextRow = next[seat];
    if (!prevRow || !nextRow) continue;
    for (let k = 0; k < nextRow.length; k++) {
      const o = prevRow[k];
      const n = nextRow[k];
      if (o !== undefined && n !== undefined && o >= 0 && n > o) steps = Math.max(steps, n - o);
    }
  }
  return steps;
}
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
  // The opponent's equipped-die roll SOUND (premium dice each have their own),
  // so their roll sounds like THEIR die on my screen — not the default rattle.
  // Set at match start/resume from the relayed diceSkin; undefined = default.
  const oppDiceSoundRef = useRef<string | undefined>(undefined);
  // Gameplay pedagogy: a roll that ends the turn with NO move (no legal move, or
  // the three-sixes burn) looks like a silent bug — track the dice stream so the
  // UI can explain it. Reset on every match start/resume.
  const lastDiceRef = useRef<{ seat: number; value: number } | null>(null);
  const movedSinceDiceRef = useRef(true);
  const sixRunRef = useRef<{ seat: number; run: number }>({ seat: -1, run: 0 });
  // In-flight action lock (Fix 1): failsafe timer that releases the lock if the
  // server never echoes the roll/move.
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPendingTimer = useCallback(() => {
    if (pendingTimer.current) {
      clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
    }
  }, []);
  // Deferred turn hand-off (Fix 2): the last known board positions (to measure a
  // move's walk length), the wall-clock time that walk finishes, and the timer
  // holding back the HUD turn flip until then — so activeTurn lags game.turn for
  // the exact duration of the pawn animation, like the local bot already paces.
  const prevPositionsRef = useRef<number[][] | null>(null);
  const animUntilRef = useRef(0);
  const turnDeferTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Client-side prediction: the latest authoritative game state (mirrors the store)
  // so a tapped move can be applied through the shared pure engine and animated
  // IMMEDIATELY, instead of waiting a full RTT for the server echo. `optimisticMove`
  // marks that the next game.moved is the echo of our own predicted move (identical
  // state → no re-animation, and the walk timing must not be recomputed off it).
  const gameRef = useRef<GameState | null>(null);
  const optimisticMove = useRef(false);
  const clearTurnDefer = useCallback(() => {
    if (turnDeferTimer.current) {
      clearTimeout(turnDeferTimer.current);
      turnDeferTimer.current = null;
    }
  }, []);

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
      claimedSets: state.claimedSets,
      limits: state.limits,
      profile: state.profile,
      season: state.season,
    });
  }, [state.challenge, state.streak, state.league, state.tickets, state.ownedSkins, state.claimedSets, state.limits, state.profile, state.season]);

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
      let wallet = await connectWallet().catch(() => null);
      // No injected provider (plain mobile browser, outside MiniPay): if
      // WalletConnect is configured, open its modal so the user can pair Valora /
      // MetaMask mobile / any WC wallet. Never on the silent launch probe — a QR
      // modal must only ever open from an explicit connect tap.
      if (!wallet && !hasInjectedWallet() && !silent && walletConnectAvailable()) {
        wallet = await connectViaWalletConnect().catch(() => null);
      }
      if (!wallet) {
        // Still nothing: a toast is a dead end when there's no provider AND no
        // WalletConnect — open the actionable MiniPay sheet instead. A
        // present-but-refusing injected provider (rejected prompt), or a
        // dismissed WalletConnect modal, keeps the simple toast.
        if (!silent) {
          if (!hasInjectedWallet() && !walletConnectAvailable()) dispatch({ type: 'NOWALLET', open: true });
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
  // Then (everywhere) refresh lobby state over a one-shot hello: the league
  // card and daily counters self-heal at app OPEN (weekly rollover, resets)
  // instead of waiting for the next online game.
  const syncLobbyNow = useCallback(
    (): void =>
      syncLobby(SERVER_URL, walletRef.current?.address, {
        league: (league) => dispatch({ type: 'LEAGUE_UPDATE', league }),
        challenge: (challenge) => dispatch({ type: 'CHALLENGE_UPDATE', challenge }),
        streak: (streak) => dispatch({ type: 'STREAK_UPDATE', streak }),
        limits: (limits) => dispatch({ type: 'LIMITS_UPDATE', limits }),
        season: (season) => dispatch({ type: 'SEASON_STATE', season }),
        race: (race) => dispatch({ type: 'RACE_STATE', race }),
        friends: (friends, requests, outgoing) => dispatch({ type: 'FRIENDS', friends, requests, outgoing }),
      }),
    [dispatch],
  );

  useEffect(() => {
    if (isMiniPay()) {
      void connectWalletCta(true).finally(syncLobbyNow);
      return;
    }
    // B1 (non-MiniPay): restore the persisted burner at boot, BEFORE the lobby
    // sync (which reads walletRef for hello). Without this a reload left the app
    // wallet-less: the race card read as unfunded and — the killer — a staked
    // queue entry went in as DEMO (walletBacked=false), which the matchmaker
    // rightly never pairs with a wallet-backed opponent → an infinite spinner.
    // restoreBurnerWallet only REUSES an existing burner (never mints), so a
    // first-time visitor is unaffected.
    if (!walletRef.current) {
      const burner = restoreBurnerWallet();
      if (burner) {
        walletRef.current = burner;
        dispatch({ type: 'SET_WALLET_ADDRESS', address: burner.address });
        void refreshBalance(burner);
      }
    }
    syncLobbyNow();
  }, [connectWalletCta, syncLobbyNow, dispatch, refreshBalance]);

  // Re-sync EVERY time the player lands back on the lobby (post-game, end
  // screen exit, cancelled search): friend requests/acceptances that arrived
  // while this client had no live socket only exist server-side, and the old
  // open-of-app-only sync meant they stayed invisible until the next launch —
  // "he never received my request" in practice.
  const prevScreenSync = useRef<string>('lobby');
  useEffect(() => {
    if (state.screen === 'lobby' && prevScreenSync.current !== 'lobby') syncLobbyNow();
    prevScreenSync.current = state.screen;
  }, [state.screen, syncLobbyNow]);

  // Living presence + near-instant social: the lobby holds NO persistent socket
  // (offline-first, one-shot syncs), so a friend request / acceptance / presence
  // flip can't be pushed to it — it's picked up by this short re-sync poll (each
  // sync's hello.ok carries the fresh friend lists AND stamps OUR "last seen",
  // which is what makes us read as online to friends). 8 s keeps requests feeling
  // immediate without a held connection. Skipped off-lobby.
  useEffect(() => {
    if (state.screen !== 'lobby') return;
    const id = setInterval(syncLobbyNow, 8_000);
    return () => clearInterval(id);
  }, [state.screen, syncLobbyNow]);

  /** Lock the stake on-chain for a staked match; leave the match on failure. */
  const stakeForMatch = useCallback(
    async (gameId: string, stakeCents: number, fairnessCommit: string) => {
      const wallet = walletRef.current;
      if (!wallet) {
        // No wallet → simulated demo stake, never real funds. Safe by construction:
        // the server refuses to mix a wallet player with a demo one in a staked
        // match (matchmaking walletBacked parity) AND only locks/settles on-chain
        // when BOTH seats have wallets (needsLock). So a wallet-less client can only
        // ever be in a both-demo game with no escrow. Log it so it's never silent.
        console.warn('[stake] staked match with no connected wallet — simulated demo stake (no on-chain funds).');
        return;
      }
      dispatch({ type: 'STAKING', status: 'approving' });
      try {
        await lockStake(wallet, gameId, stakeCents, fairnessCommit, (status) => dispatch({ type: 'STAKING', status }));
        await refreshBalance(wallet);
      } catch (e) {
        dispatch({ type: 'STAKING', status: 'failed' });
        // Carry the CAUSE in the toast: the console line below is wiped by the
        // SW auto-reload on each deploy, so cause-less "stake not locked" reports
        // were undebuggable. viem's shortMessage names the exact failure.
        dispatch({ type: 'TOAST', message: `${t('stakeFailed')} — ${describeTxError(e)}` });
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
        oppDiceSoundRef.current = skinById(match.opponent.diceSkin ?? 'classic').sound;
        lastDiceRef.current = null;
        movedSinceDiceRef.current = true;
        sixRunRef.current = { seat: -1, run: 0 };
        // Fresh match: drop any stale in-flight lock / turn-defer / prediction carried over.
        clearPendingTimer();
        clearTurnDefer();
        prevPositionsRef.current = null;
        animUntilRef.current = 0;
        gameRef.current = null;
        optimisticMove.current = false;
        dispatch({ type: 'MATCH_FOUND', match });
        if (match.stakeCents > 0) void stakeForMatch(match.gameId, match.stakeCents, match.fairnessCommit);
      },
      onState: (game) => {
        // Keep the walk-length baseline current: the pre-move awaiting-move state
        // carries the same positions as before the move, so the next onMoved diff
        // measures exactly the pawn that advances.
        prevPositionsRef.current = game.positions;
        gameRef.current = game; // prediction baseline (dice + legal for the next move)
        dispatch({ type: 'GAME_STATE', game });
      },
      onDice: (value, index, seat) => {
        // The authoritative roll arrived → the roll lock is released by the DICE
        // reducer; cancel its failsafe so it can't fire a stray release later.
        clearPendingTimer();
        // own rolls already played the rattle on button press (no RTT lag);
        // the opponent's roll sounds like THEIR equipped die (premium sound relayed)
        if (seat !== matchSeatRef.current) playDice(oppDiceSoundRef.current);
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
        clearPendingTimer();
        gameRef.current = game; // authoritative sync
        if (optimisticMove.current) {
          // Echo of OUR OWN predicted move: the pawn already animated + sounded at
          // click time and the state is identical, so re-dispatching MOVED is a
          // no-op for the board (no position diff) and we KEEP the optimistic
          // animUntil so the turn hand-off matches the animation already running.
          optimisticMove.current = false;
          prevPositionsRef.current = game.positions;
          dispatch({ type: 'MOVED', game, capture });
          return;
        }
        // Opponent's move (or any non-predicted move): animate from our last known
        // board, and measure the walk so the turn hand-off (Fix 2) waits for it.
        const prev = prevPositionsRef.current;
        const steps = prev ? walkSteps(prev, game.positions) : 1;
        animUntilRef.current = Date.now() + steps * WALK_STEP_MS + WALK_TWEEN_MS;
        prevPositionsRef.current = game.positions;
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
        // Fix 2 — pace the hand-off: the server fires game.moved and game.turn in
        // one burst, so applying the turn now would flip the HUD (and pull the die)
        // while the pawn is still mid-walk. Hold the activeTurn/deadline update
        // until the walk finishes; game.turn (roll validity) already updated via
        // MOVED, so `handoff` covers the gap exactly as designed. A no-move roll
        // has animUntil in the past → applies immediately. The local bot already
        // announces its turn post-animation, so this is a no-op there.
        clearTurnDefer();
        const applyTurn = (): void => dispatch({ type: 'TURN', seat, deadlineTs });
        const remaining = animUntilRef.current - Date.now();
        if (remaining > 0) {
          turnDeferTimer.current = setTimeout(() => {
            turnDeferTimer.current = null;
            applyTurn();
          }, remaining);
        } else {
          applyTurn();
        }
      },
      onAutoPlayed: (seat, count, max) => {
        const key = seat === matchSeatRef.current ? 'autoPlayedYou' : 'autoPlayedOpp';
        dispatch({ type: 'TOAST', message: `${t(key)} · ${count}/${max}` });
      },
      onEmote: (seat, id) => dispatch({ type: 'EMOTE', seat, id }),
      onGift: (from, to, id) => dispatch({ type: 'GIFT', from, to, id }), // GiftFlight plays the chime
      onOver: (result) => {
        clearPendingTimer();
        clearTurnDefer();
        const won = result.winner === (matchSeatRef.current ?? 0);
        if (won) playWin();
        recordGameResult(won); // local stats feed the dice-skin unlocks
        dispatch({ type: 'GAME_OVER', result });
        if (walletRef.current) void refreshBalance(walletRef.current);
      },
      onInfo: (message, code) => {
        // Any server notice releases the input lock so the player can act again
        // instead of being stuck behind a dead pending action.
        clearPendingTimer();
        dispatch({ type: 'PENDING', action: null });
        // Fix 4 — swallow the toast for benign gameplay races: a duplicate or stale
        // roll/move that the server's authoritative state already superseded (the
        // common case when the client lock is bypassed by the failsafe or a
        // reconnect). The server still rejects it authoritatively (anti-cheat
        // contract intact) and the board is resynced by broadcasts — nagging the
        // player with "not your turn" for their own double-tap only reads as jank.
        if (code === 'NOT_YOUR_TURN' || code === 'ILLEGAL_MOVE') return;
        dispatch({ type: 'TOAST', message });
      },
      onChallenge: (challenge) => dispatch({ type: 'CHALLENGE_UPDATE', challenge }),
      onLeague: (league) => dispatch({ type: 'LEAGUE_UPDATE', league }),
      onStreak: (streak) => {
        dispatch({ type: 'STREAK_UPDATE', streak });
        if (streak.freezeUsed) {
          dispatch({ type: 'TOAST', message: `❄️ ${t('freezeUsed')}` });
        } else if (streak.rewardGranted > 0) {
          dispatch({
            type: 'TOAST',
            message: `🔥 ${streak.days} ${t('days')} — +${streak.rewardGranted} 🎟️`,
          });
        }
      },
      onComeback: (comeback) => dispatch({ type: 'COMEBACK', comeback }),
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
      onRace: (race) => dispatch({ type: 'RACE_STATE', race }),
      onSkins: (ownedIds) => dispatch({ type: 'OWNED_SKINS', ownedIds }),
      onClaimedSets: (setIds) => dispatch({ type: 'CLAIMED_SETS', setIds }),
      onSeasonState: (season) => dispatch({ type: 'SEASON_STATE', season }),
      onSeasonProgress: (p) => dispatch({ type: 'SEASON_PROGRESS', crowns: p.crowns, tier: p.tier, gained: p.gained }),
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
        oppDiceSoundRef.current = skinById(match.opponent.diceSkin ?? 'classic').sound;
        lastDiceRef.current = null;
        movedSinceDiceRef.current = true;
        sixRunRef.current = { seat: -1, run: 0 };
        // Resync baselines: drop any in-flight lock / deferred turn / prediction from
        // before the drop and re-anchor to the authoritative resumed board.
        clearPendingTimer();
        clearTurnDefer();
        prevPositionsRef.current = game.positions;
        animUntilRef.current = 0;
        gameRef.current = game;
        optimisticMove.current = false;
        dispatch({ type: 'RESUME', match, game });
      },
      onGone: () => {
        clearFreeFallback();
        clearPendingTimer();
        clearTurnDefer();
        dispatch({ type: 'TOAST', message: t('connectionLost') });
        dispatch({ type: 'GO_LOBBY' });
      },
      // The opponent clicked Rematch and is waiting → show Accept/Decline.
      onFriends: (friends, requests, outgoing) => dispatch({ type: 'FRIENDS', friends, requests, outgoing }),
      onChallengeOffer: (offer) => dispatch({ type: 'CHALLENGE_OFFER', offer }),
      // A friend gifted me a cosmetic while I'm connected: ownership is already
      // durable server-side — sync the owned list and celebrate in a toast.
      onGiftReceived: (gift) => {
        dispatch({ type: 'OWNED_SKINS', ownedIds: gift.ownedIds });
        dispatch({ type: 'TOAST', message: `🎁 ${gift.from.name} · ${t('giftReceived')}` });
      },
      onRematchOffer: (name) => dispatch({ type: 'REMATCH_OFFER', name }),
      // A rematch we were waiting on fell through → tell the player, return home.
      onRematchCancelled: (reason) => {
        dispatch({ type: 'REMATCH_CLEAR' });
        dispatch({ type: 'TOAST', message: reason === 'declined' ? t('rematchDeclined') : t('rematchLeft') });
        dispatch({ type: 'GO_LOBBY' });
      },
    };
  }, [dispatch, stakeForMatch, refreshBalance, clearFreeFallback, clearPendingTimer, clearTurnDefer]);

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
      // Sign with the client's BOUND account when it has one (the burner's local
      // key — signs in-page, no RPC): passing the bare address makes viem treat it
      // as a json-rpc account and send personal_sign to the transport, which for
      // the burner is plain http() to the node → rejected → 'signature-declined'.
      // Injected/WalletConnect clients have no bound account → address → the
      // wallet's own personal_sign prompt, as before.
      signMessage:
        wallet && !isMiniPay()
          ? (message: string) => wallet.walletClient.signMessage({ account: wallet.walletClient.account ?? wallet.address, message })
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
          dispatch({ type: 'START_MATCHMAKING', botMode: true }); // badge: "practice"
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
        // No human after the full wait → bot, SAID OUT LOUD: the lobby promises
        // "vs a real player", so a silent swap would make that promise a lie.
        freeFallback.current = setTimeout(() => {
          dispatch({ type: 'TOAST', message: t('botFallback') });
          toBot();
        }, FREE_MATCH_TIMEOUT_MS);
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
          dispatch({ type: 'START_MATCHMAKING', botMode: true }); // badge: "practice"
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
    // botMode drives the in-game badge: bot game = "practice", human = "Free 1v1".
    dispatch({ type: 'START_MATCHMAKING', botMode: true });
    sessionRef.current = new LocalBotSession(makeEvents(), 0);
  }, [makeEvents, clearFreeFallback, dispatch]);

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

  // ---- Friends & challenges (E-social 2) ----
  /** Challenge a friend at the stake the lobby sheet picked (0 = free): the
   *  server creates the table + pushes them a live offer; the normal private-
   *  table waiting screen (code + WhatsApp share) covers the offline case.
   *  openPrivate already gates staked play on a connected wallet. */
  const challengeFriend = useCallback(
    (pid: string, stake: StakeCents) => void openPrivate(stake, { kind: 'challenge', pid }),
    [openPrivate],
  );

  /** Accept a live friend challenge: clear the offer and join their table. */
  const acceptChallenge = useCallback(
    (code: string) => {
      dispatch({ type: 'CHALLENGE_OFFER', offer: null });
      void openPrivate(0, { kind: 'join', code });
    },
    [dispatch, openPrivate],
  );

  /** friend.add over a one-shot socket (request OR reciprocal accept); the
   *  server's friends.update reply refreshes both lobby lists. */
  const addFriend = useCallback(
    async (pid: string): Promise<boolean> => {
      const lists = await sendFriendAction(SERVER_URL, { t: 'friend.add', pid }, walletRef.current?.address);
      if (!lists) {
        dispatch({ type: 'TOAST', message: t('friendActionFailed') });
        return false;
      }
      dispatch({ type: 'FRIENDS', friends: lists.friends, requests: lists.requests, outgoing: lists.outgoing });
      dispatch({ type: 'TOAST', message: `➕ ${t('friendRequestSent')}` });
      return true;
    },
    [dispatch],
  );

  /** friend.remove serves the WHOLE removal lifecycle — withdraw a SENT
   *  invitation, DECLINE an incoming request, or UNFRIEND — because the server
   *  tears down both directional edges. Silent for the other side by design. */
  const removeFriendEdge = useCallback(
    async (pid: string): Promise<void> => {
      const lists = await sendFriendAction(SERVER_URL, { t: 'friend.remove', pid }, walletRef.current?.address);
      if (!lists) {
        dispatch({ type: 'TOAST', message: t('friendActionFailed') });
        return;
      }
      dispatch({ type: 'FRIENDS', friends: lists.friends, requests: lists.requests, outgoing: lists.outgoing });
    },
    [dispatch],
  );

  /** friend.gift over a one-shot socket (cosmetics phase 2): pay MY tickets,
   *  unlock the item on the FRIEND's account. Resolves true on success. */
  const giftCosmetic = useCallback(
    async (pid: string, id: string): Promise<boolean> => {
      const res = await sendFriendGift(SERVER_URL, pid, id, walletRef.current?.address);
      if (res && 'tickets' in res) {
        dispatch({ type: 'TICKETS', total: res.tickets });
        dispatch({ type: 'TOAST', message: `🎁 ${t('giftSent')}` });
        return true;
      }
      dispatch({ type: 'TOAST', message: res && 'error' in res ? res.error : t('friendActionFailed') });
      return false;
    },
    [dispatch],
  );

  /** collection.claim over a one-shot socket (phase 3): the server verifies the
   *  whole set is owned, grants the bonus ONCE, and returns the claimed list. */
  const claimSetBonus = useCallback(
    async (setId: string): Promise<boolean> => {
      const res = await claimCollection(SERVER_URL, setId, walletRef.current?.address);
      if (!res) {
        dispatch({ type: 'TOAST', message: t('friendActionFailed') });
        return false;
      }
      dispatch({ type: 'CLAIMED_SETS', setIds: res.claimedSets, tickets: res.tickets });
      dispatch({ type: 'TOAST', message: `📚 ${t('setClaimedToast')} +${res.granted} 🎟️` });
      return true;
    },
    [dispatch],
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

  // Auto-update: while the app stays open (SPA / kept-open MiniPay webview) it can
  // sit on the build it first loaded across new deployments. Poll the deployed
  // build id (/version.json, cache-busted past the service worker) and reload to
  // pick up a newer one — but only at a SAFE moment (lobby/end), never mid-game.
  const screenRef = useRef(state.screen);
  screenRef.current = state.screen;
  const updatePending = useRef(false);
  const RELOAD_GUARD = 'ludo.autoUpdatedTo';
  const applyUpdate = useCallback((version: string) => {
    try {
      // Reload at most once per target build per tab, so a reload that somehow
      // doesn't pick up the new assets can never become a refresh loop.
      if (sessionStorage.getItem(RELOAD_GUARD) === version) return;
      sessionStorage.setItem(RELOAD_GUARD, version);
    } catch {
      /* storage unavailable — the in-tab updatePending guard still bounds it */
    }
    window.location.reload();
  }, []);
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const safe = (): boolean => screenRef.current === 'lobby' || screenRef.current === 'end';
    const check = async (): Promise<void> => {
      try {
        const r = await fetch(`/version.json?_=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) return;
        const { version } = (await r.json()) as { version?: string };
        if (!version || version === __APP_VERSION__) return;
        if (safe()) applyUpdate(version);
        else updatePending.current = version ? true : false; // apply between games
      } catch {
        /* offline / version.json not deployed yet — try again next tick */
      }
    };
    const id = setInterval(() => void check(), 60_000);
    return () => clearInterval(id);
  }, [applyUpdate]);
  // Apply a deferred update the instant the player returns to a safe screen.
  useEffect(() => {
    if (updatePending.current && (state.screen === 'lobby' || state.screen === 'end')) {
      void fetch(`/version.json?_=${Date.now()}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { version?: string } | null) => {
          if (j?.version && j.version !== __APP_VERSION__) applyUpdate(j.version);
        })
        .catch(() => undefined);
    }
  }, [state.screen, applyUpdate]);

  // First-game name prompt: auto-generated pseudos (a 32-name pool) are a poor
  // identity once friends/ELO/rivals exist — after the FIRST game ever, when the
  // player lands back on the lobby, open the profile editor ONCE so they choose
  // their own name. localStorage-latched; a dismiss never re-prompts.
  const prevScreen = useRef(state.screen);
  useEffect(() => {
    const cameHome = prevScreen.current === 'end' && state.screen === 'lobby';
    prevScreen.current = state.screen;
    if (!cameHome) return;
    try {
      if (localStorage.getItem('ludo.namePrompted') === '1') return;
      localStorage.setItem('ludo.namePrompted', '1');
    } catch {
      return; // no storage → never auto-open (avoid prompting every game)
    }
    dispatch({ type: 'PROFILE_EDIT', open: true });
  }, [state.screen, dispatch]);

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

  // Fix 1 — optimistic input lock: mark the intent in-flight BEFORE sending, so the
  // die/pawns lock for the RTT and a slow link can't be re-tapped into a duplicate
  // intent (which the server rejects with an error toast). The authoritative echo
  // (DICE/MOVED) clears the lock; a failsafe timer guarantees it never wedges. The
  // local bot resolves synchronously, so the lock is set and cleared in one batched
  // render and never visibly blocks anything.
  const armPending = useCallback(
    (action: 'roll' | 'move') => {
      clearPendingTimer();
      dispatch({ type: 'PENDING', action });
      pendingTimer.current = setTimeout(() => {
        pendingTimer.current = null;
        dispatch({ type: 'PENDING', action: null });
      }, PENDING_TIMEOUT_MS);
    },
    [dispatch, clearPendingTimer],
  );
  const roll = useCallback(() => {
    if (!sessionRef.current) return;
    armPending('roll');
    sessionRef.current.roll();
  }, [armPending]);
  const move = useCallback(
    (token: number) => {
      const session = sessionRef.current;
      if (!session) return;
      const g = gameRef.current;
      const mySeat = matchSeatRef.current;
      // Optimistic prediction: when the tap is a legal move for us, apply it through
      // the SAME pure engine the server runs and animate it NOW — no RTT wait. The
      // server's game.moved echo is identical (deterministic engine + in-sync state)
      // so it reconciles without re-animating. The server stays authoritative: we
      // only ever SEND the intent; the echo/turn confirm it.
      if (g && g.turn === mySeat && g.phase === 'awaiting-move' && g.legal.includes(token)) {
        const { state, events } = applyMove(g, token);
        gameRef.current = state;
        optimisticMove.current = true;
        movedSinceDiceRef.current = true;
        if (events.capture) playCapture();
        const steps = walkSteps(g.positions, state.positions);
        animUntilRef.current = Date.now() + steps * WALK_STEP_MS + WALK_TWEEN_MS;
        prevPositionsRef.current = state.positions;
        dispatch({ type: 'MOVED', game: state, capture: events.capture });
        session.move(token);
        return;
      }
      // Fallback (state not locally known / not obviously legal): lock and let the
      // server echo drive the board, as before.
      armPending('move');
      session.move(token);
    },
    [armPending, dispatch],
  );
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
    async (gameId: string, stakeCents: number, fairnessCommit: string, onStatus?: (s: StakeStatus) => void): Promise<void> => {
      const wallet = walletRef.current;
      if (!wallet) throw new Error('no wallet connected');
      await lockStake4(wallet, gameId, stakeCents, fairnessCommit, onStatus);
      void refreshBalance(wallet);
    },
    [refreshBalance],
  );

  /** Equip whatever was just purchased, by its CATALOG kind — the old
   *  hardcoded SET_DICE_SKIN mis-equipped every non-die purchase (buying a
   *  pawn skin reset the equipped die to Classic). */
  const equipPurchased = useCallback(
    (id: string): void => {
      const kind = cosmeticById(id)?.kind;
      if (kind === 'dice') dispatch({ type: 'SET_DICE_SKIN', id });
      else if (kind === 'token') dispatch({ type: 'SET_TOKEN_SKIN', id });
      else if (kind === 'board') dispatch({ type: 'SET_BOARD_THEME', id });
      else if (kind === 'entrance') dispatch({ type: 'SET_ENTRANCE_FX', id });
      else if (kind === 'victory') dispatch({ type: 'SET_VICTORY_FX', id });
      else if (kind === 'frame') dispatch({ type: 'EQUIP_FRAME', id });
    },
    [dispatch],
  );

  const purchaseSkin = useCallback(
    async (skinId: string) => {
      const res = await buySkin(SERVER_URL, skinId, walletRef.current?.address);
      if (res) {
        dispatch({ type: 'OWNED_SKINS', ownedIds: res.ownedIds, tickets: res.tickets });
        equipPurchased(skinId); // equip what you just unlocked (by catalog kind)
        dispatch({ type: 'TOAST', message: t('skinUnlocked') });
      } else {
        dispatch({ type: 'TOAST', message: t('offline') });
      }
    },
    [dispatch, equipPurchased],
  );

  // Claim a season-pass tier reward: the server validates + grants, then returns
  // the fresh state (with the tier marked claimed and any tickets folded in).
  const claimSeason = useCallback(
    async (tier: number, lane: 'free' | 'premium') => {
      const season = await claimSeasonReward(SERVER_URL, tier, lane, walletRef.current?.address);
      if (season) {
        dispatch({ type: 'SEASON_STATE', season });
        dispatch({ type: 'TOAST', message: t('seasonClaimed') });
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
          equipPurchased(id);
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
    [dispatch, equipPurchased, refreshBalance],
  );

  // Buy the premium season pass with USDT (Phase 2): pay $1.50 on-chain via the
  // CosmeticsStore (same rail as cosmetics), then hand the tx to the server to
  // flip premium on + retro-unlock reached tiers. Gated on cosmeticsCusdAvailable.
  const purchasePremium = useCallback(
    async () => {
      try {
        const wallet = walletRef.current ?? (await connectWallet());
        if (!wallet) {
          dispatch({ type: 'TOAST', message: t('offline') });
          return;
        }
        walletRef.current = wallet;
        dispatch({ type: 'STAKING', status: 'joining' });
        const { buyTxHash } = await buyCosmetic(wallet, SEASON_PREMIUM.itemId, SEASON_PREMIUM.cents);
        dispatch({ type: 'STAKING', status: 'idle' });
        const season = await buySeasonPremium(SERVER_URL, buyTxHash, wallet.address);
        if (season) {
          dispatch({ type: 'SEASON_STATE', season });
          dispatch({ type: 'TOAST', message: t('seasonPremiumUnlocked') });
          void refreshBalance(wallet);
        } else {
          dispatch({ type: 'TOAST', message: t('offline') });
        }
      } catch {
        dispatch({ type: 'STAKING', status: 'idle' });
        dispatch({ type: 'TOAST', message: t('offline') });
      }
    },
    [dispatch, equipPurchased, refreshBalance],
  );

  // Buy a streak-freeze with tickets (Phase 3 sink). One-shot from the lobby.
  const buyFreeze = useCallback(
    async () => {
      const streak = await buyStreakFreeze(SERVER_URL, walletRef.current?.address);
      if (streak) {
        dispatch({ type: 'STREAK_UPDATE', streak });
        dispatch({ type: 'TOAST', message: `❄️ ${t('freezeBought')}` });
      } else {
        dispatch({ type: 'TOAST', message: t('freezeCantBuy') });
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

  // ---- Race Week (event) ----
  /** localStorage key for a wallet's RacePass mint tx, so a resumed session can
   *  reprove the mint (server verifies the Minted event) without re-minting. */
  const RACE_TX_KEY = 'ludo.racePassTx';
  /** Join Race Week: mint the soulbound RacePass (anti-sybil entry, once per
   *  wallet), then hand the mint tx to the server, which verifies it on-chain and
   *  funds the one-time subsidised-stake quota. Idempotent: reuses an existing
   *  Pass + its stored mint tx instead of re-minting, and the server no-ops a
   *  second grant (alreadyFunded). */
  const joinRaceWeek = useCallback(async () => {
    // Wallet for the event. Inside MiniPay: the ambient wallet (gas in cUSD). Outside
    // MiniPay (B1, non-MiniPay launch): the app-minted BURNER — the player brings no
    // wallet and needs no CELO; its gas is paid in cUSD (feeCurrency), seeded below.
    let wallet: Wallet | null;
    if (isMiniPay()) {
      if (!(await connectWalletCta())) return;
      wallet = walletRef.current;
    } else {
      wallet = getBurnerWallet();
      walletRef.current = wallet;
      dispatch({ type: 'SET_WALLET_ADDRESS', address: wallet.address });
    }
    if (!wallet) return;
    // Same bound-account rule as makeAuth: the burner signs with its LOCAL key
    // (in-page, no popup); only an injected wallet goes through personal_sign.
    const signer = isMiniPay()
      ? undefined
      : (message: string) => wallet!.walletClient.signMessage({ account: wallet!.walletClient.account ?? wallet!.address, message });
    dispatch({ type: 'RACE_JOINING', joining: true });
    // If the server REFUSES the gas seed (device allowance, pool dry…), the mint
    // then dies on funds and the generic "need CELO" toast hides the real cause.
    // Keep the refusal so the catch can surface the server's own words instead.
    let seedError: string | null = null;
    try {
      const txKey = `${RACE_TX_KEY}:${wallet.address.toLowerCase()}`;
      let passTx: string | null = null;
      try {
        passTx = localStorage.getItem(txKey);
      } catch {
        /* storage unavailable */
      }
      const held = await racePassTokenId(wallet).catch((e) => { console.error('[race] passOf read failed:', e); return null; });
      console.log('[race] wallet=%s miniPay=%s heldPass=%s', wallet.address, isMiniPay(), held?.toString() ?? 'null');
      if (held === null || held === 0n) {
        // About to mint — but a fresh burner has NO gas. Ask the server for a tiny
        // cUSD gas seed FIRST (idempotent, pool-capped); it resolves once the cUSD
        // is mined, so the mint can then pay its fee in cUSD. MiniPay already has
        // gas, so it skips this. Seed errors are non-fatal: the mint's own catch
        // surfaces "need gas" if the seed truly didn't land.
        if (!isMiniPay()) {
          const seedRes = await sendRaceSeed(SERVER_URL, wallet.address, signer).catch((e) => { console.error('[race] seed threw:', e); return null; });
          console.log('[race] seed result:', JSON.stringify(seedRes));
          if (seedRes && 'error' in seedRes) seedError = seedRes.error;
          // Log the burner's on-chain cUSD balance right before minting — the
          // single most diagnostic number ("need gas" == this is below the mint's
          // gas reservation). Re-read a few times for load-balanced RPC lag.
          let balCents = await walletBalanceCents(wallet).catch(() => null);
          for (let i = 0; i < 5 && (balCents ?? 0) < 4; i++) {
            await new Promise((r) => setTimeout(r, 1500));
            balCents = await walletBalanceCents(wallet).catch(() => null);
          }
          console.log('[race] burner cUSD balance before mint: %s cents', balCents);
        }
        // No Pass yet → mint one (free, soulbound). Persist the tx for reproof.
        console.log('[race] minting RacePass…');
        passTx = await mintRacePass(wallet);
        console.log('[race] mint OK, tx=%s', passTx);
        try {
          localStorage.setItem(txKey, passTx);
        } catch {
          /* storage unavailable — claim still proceeds this session */
        }
      } else if (!passTx) {
        // Already hold a Pass but lost the mint tx (cleared storage). The grant is
        // one-time per wallet server-side, so if it was already funded the card
        // already shows it; otherwise there's nothing we can reprove here.
        dispatch({ type: 'TOAST', message: t('raceClaimFailed') });
        return;
      }
      // `signer` (computed above) proves the wallet via SIWE before the gated
      // race.claim — the burner signs locally (no popup); MiniPay auto-proves.
      const res = await sendRaceClaim(SERVER_URL, passTx!, wallet.address, signer);
      console.log('[race] claim result:', JSON.stringify(res));
      if (res && 'fundedCents' in res) {
        dispatch({ type: 'RACE_FUNDED' });
        dispatch({
          type: 'TOAST',
          message: res.alreadyFunded ? t('raceAlreadyFunded') : `🏁 ${t('raceFundedToast')} +${fmtUsd(res.fundedCents)}`,
        });
        syncLobbyNow(); // pull fresh race state (funded + poolLeft) + balances
        void refreshBalance(wallet);
      } else if (res && 'error' in res) {
        // Surface WHY (localised for the common cases, else the server's words).
        const raw = res.error.toLowerCase();
        const msg =
          res.error === 'signature-declined' || raw.includes('connect your wallet') || raw.includes('verification')
            ? t('raceSignNeeded')
            : raw.includes('already claimed') || raw.includes('device')
              ? t('raceDeviceClaimed')
              : raw.includes('pool') || raw.includes('exhaust')
                ? t('racePoolEmpty')
                : raw.includes('verify') || raw.includes('pass')
                  ? t('raceVerifyFailed')
                  : res.error;
        dispatch({ type: 'TOAST', message: msg });
      } else {
        dispatch({ type: 'TOAST', message: t('raceClaimFailed') }); // null = timeout / no socket
      }
    } catch (e) {
      // Mint (or connect) threw. Surface the RAW cause — the toast is lossy and the
      // classification below is heuristic, so the console line is what we debug from.
      const raw = String((e as Error)?.message ?? e);
      // Log BOTH the message and the full error object — viem attaches .shortMessage
      // / .details / .metaMessages that name the exact revert / RPC cause.
      console.error('[joinRaceWeek] failed:', raw, e);
      const m = raw.toLowerCase();
      // A GENUINE wrong-network error carries the WRONG_CHAIN sentinel (an injected
      // wallet that declined the switch) or viem's explicit mismatch phrase. Do NOT
      // match a bare "chain"/"network": every viem error prints "Chain: Celo (id: …)"
      // and "Request Arguments", so a greedy match mislabels EVERY failure (no gas,
      // revert, RPC) as "wrong network" and hides the real cause. {chain} is filled
      // from activeChain.name so the message names the real target.
      const wrongNet =
        m.includes('wrong_chain') || m.includes('does not match the target chain') || m.includes('unrecognized chain');
      const needGas =
        m.includes('insufficient') || m.includes('funds for gas') || m.includes('exceeds the balance') ||
        m.includes('exceeds allowance') || m.includes('gas required exceeds') || m.includes('max fee per gas less than');
      const msg = wrongNet
        ? t('raceWrongNetwork').replace('{chain}', activeChain.name)
        : needGas
          ? // A gas shortfall right after a REFUSED seed is the seed refusal
            // (device allowance, pool dry…) — the server's words name it.
            (seedError ?? t('raceNeedGas').replace('{chain}', activeChain.name))
          : t('raceClaimFailed');
      dispatch({ type: 'TOAST', message: msg });
    } finally {
      dispatch({ type: 'RACE_JOINING', joining: false });
    }
  }, [dispatch, connectWalletCta, refreshBalance, syncLobbyNow]);

  // Podium preview data for the lobby event card: fetch the board once when an
  // active event is on screen (kept in the store afterwards; openRaceBoard
  // refreshes it whenever the sheet is opened).
  const raceBoardFetched = useRef(false);
  useEffect(() => {
    if (state.screen !== 'lobby' || !state.race?.active || state.raceBoard || raceBoardFetched.current) return;
    raceBoardFetched.current = true;
    void fetchRaceLeaderboard(SERVER_URL, walletRef.current?.address).then((board) => {
      if (board) dispatch({ type: 'RACE_BOARD', board });
    });
  }, [state.screen, state.race, state.raceBoard, dispatch]);

  /** Open the Race Week leaderboard sheet and (re)fetch the standings. */
  const openRaceBoard = useCallback(async () => {
    dispatch({ type: 'RACE_MODAL', open: true });
    const board = await fetchRaceLeaderboard(SERVER_URL, walletRef.current?.address);
    dispatch({ type: 'RACE_BOARD', board });
  }, [dispatch]);

  /** Launch a subsidised event 1v1 at the Race Week micro-stake (gated like any
   *  staked entry: 18+/ToS consent + wallet + balance). Wins/plays score on the
   *  event leaderboard server-side. */
  const playRaceGame = useCallback(
    () => gateStaked(RACE_STAKE_CENTS as StakeCents, () => void startMatch(RACE_STAKE_CENTS as StakeCents)),
    [gateStaked, startMatch],
  );

  return (
    <>
      {state.screen === 'lobby' && (
        <Lobby onPlay={onPlay} onCreateTable={onCreateTable} onFreeroll={startFreeroll} onPlay4={onPlay4} onPractice4={onPractice4} onConnectWallet={connectWalletCta} onChallengeFriend={challengeFriend} onAcceptFriend={addFriend} onRemoveFriendEdge={(pid) => void removeFriendEdge(pid)} onViewProfile={onViewProfile} onJoinRace={joinRaceWeek} onOpenRaceBoard={openRaceBoard} onPlayRace={playRaceGame} />
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
      {state.screen === 'end' && <EndScreen onRematch={rematch} onDecline={declineRematch} onAddFriend={addFriend} />}
      {/* Live friend challenge (E-social 2): surfaced on the lobby only — an
          offer arriving mid-game stays in state and shows on return. */}
      {state.screen === 'lobby' && <ChallengeOfferModal onAccept={acceptChallenge} />}
      {/* Gift-a-cosmetic picker (phase 2), opened from a friend row's 🎁. */}
      <GiftCosmeticModal onSend={giftCosmetic} />
      <LegalModal
        onAccept={() => {
          consentRef.current = true; // synchronous, so the pending staked action's hello carries consent
          dispatch({ type: 'ACCEPT_LEGAL' });
          const run = pendingStakeAction.current;
          pendingStakeAction.current = null;
          run?.();
        }}
      />
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
      {/* Collection album (phase 3), opened from the shop — mounted AFTER the
          shop modal so it always paints on top when both are open. */}
      <CollectionSheet onClaim={claimSetBonus} />
      <SettingsModal onApply={applyLimits} />
      <RealityCheckModal
        minutesPlayed={Math.max(1, Math.round((Date.now() - sessionStart.current) / 60_000))}
        onBreak={() => void applyLimits({ selfExcludeDays: 1 })}
      />
      <NoWalletSheet />
      <HelpModal />
      <ComebackModal />
      <ProgressionSheet onViewProfile={onViewProfile} onBuyFreeze={buyFreeze} />
      <SeasonSheet onClaim={claimSeason} onBuyPremium={purchasePremium} />
      <RaceSheet onPlay={playRaceGame} />
      <DocModal />
      <Toast />
    </>
  );
}
