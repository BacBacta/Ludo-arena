import { useEffect, useRef, useState } from 'react';
import { ALLOWED_STAKES_CENTS, FREEROLL, SEASON_PREMIUM, crownsForTier, potCents, type StakeCents } from '@ludo/shared';
import { cosmeticsCusdAvailable } from '../lib/deployments';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { SUPPORT_EMAIL, TopBar, Table4Modal } from '../components/ui';
import { IconShield, IconTicket, IconTrophy, IconUsers } from '../components/icons';
import { HeroPeg, PEG_COLORS } from '../components/Board';
import { Die3D } from '../components/Die3D';
import { skinById } from '../lib/diceSkins';
import { isMiniPay } from '../lib/minipay';
import { playDice, playTap } from '../lib/sound';
import { frameClass } from '../lib/avatarFrames';
import { avatarSrc } from '../lib/avatars';
import { PremiumFrame } from '../components/PremiumFrame';
import { t } from '../lib/i18n';

/** MiniPay top-up deeplink — the required alternative to an "insufficient" error. */
const ADD_CASH = 'https://link.minipay.xyz/add_cash?tokens=USDT,USDC';


export function Lobby({
  onPlay,
  onCreateTable,
  onFreeroll,
  onPlay4,
  onPractice4,
  onConnectWallet,
  onDisconnectWallet,
  onChallengeFriend,
  onAcceptFriend,
  onRemoveFriendEdge,
  onViewProfile,
  onJoinRace,
  onOpenRaceBoard,
  onPlayRace,
}: {
  onPlay(stake: StakeCents): void;
  onCreateTable(stake: StakeCents): void;
  onFreeroll(): void;
  onPlay4(stake: StakeCents): void;
  /** Launch the offline 4-player practice game (you + 3 bots). */
  onPractice4(): void;
  /** Connect MiniPay/injected wallet; resolves true when connected. */
  onConnectWallet(): Promise<boolean>;
  /** Drop the connected wallet so a different one can be paired (outside MiniPay). */
  onDisconnectWallet(): Promise<void>;
  /** Challenge a friend at a chosen stake (0 = free private table + offer). */
  onChallengeFriend(pid: string, stake: StakeCents): void;
  /** Reciprocal friend.add (accept an incoming request). */
  onAcceptFriend(pid: string): Promise<boolean>;
  /** friend.remove — withdraw a sent invitation, decline an incoming request,
   *  or unfriend (the server tears down both directions, silently). */
  onRemoveFriendEdge(pid: string): void;
  /** Open a player's public profile sheet (ELO, W/L, head-to-head vs me). */
  onViewProfile(pid: string): void;
  /** Race Week: mint the RacePass + claim the subsidised stake quota. */
  onJoinRace(): void;
  /** Race Week: open the event leaderboard sheet. */
  onOpenRaceBoard(): void;
  /** Race Week: launch a subsidised event 1v1 at the micro-stake. */
  onPlayRace(): void;
}) {
  const { stakeCents, streak, tickets, limits, stakingBlocked, balanceCents, walletBacked, profile, avatarFrame, avatar, recentOpponents, diceSkin, season, race, raceBoard, raceJoining, friends, friendRequests, sentRequests } = useAppState();
  const dispatch = useAppDispatch();

  // Race Week live countdown: re-render every 30 s while the event card shows a
  // deadline, so "ends in 2 h 05 min" actually counts down on an idle lobby.
  const [raceNow, setRaceNow] = useState(() => Date.now());
  useEffect(() => {
    if (!race?.active || !race.endsAt) return;
    const id = setInterval(() => setRaceNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [race?.active, race?.endsAt]);

  /** Recent opponents I can still invite: wallet-linked (have a pid) and not
   *  already a friend, an incoming request, or one I've already sent. This is
   *  the lobby's proactive "invite a friend" surface (previously the only way
   *  to add someone was the post-game screen). Deduped by pid, newest first. */
  const addableOpponents = recentOpponents.filter(
    (o): o is typeof o & { pid: string } =>
      !!o.pid &&
      !friends.some((f) => f.pid === o.pid) &&
      !friendRequests.some((r) => r.pid === o.pid) &&
      !sentRequests.some((r) => r.pid === o.pid),
  );

  // ---- Friends lifecycle UI state (P1) ----
  /** Friend the stake-picker sheet targets (⚔️ tap) — null = closed. */
  const [challengeTarget, setChallengeTarget] = useState<{ pid: string; name: string } | null>(null);
  /** pid whose ✕ is in its "tap again to confirm" window (mobile-friendly
   *  destructive confirm without a full modal); auto-disarms after 2.6 s. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const removeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armRemove = (pid: string): void => {
    playTap();
    if (removeTimer.current) clearTimeout(removeTimer.current);
    if (confirmRemove === pid) {
      setConfirmRemove(null);
      onRemoveFriendEdge(pid);
      return;
    }
    setConfirmRemove(pid);
    removeTimer.current = setTimeout(() => setConfirmRemove(null), 2600);
  };

  /** My on-device record vs a pid (recent opponents) → the "2-1 vs you" chip.
   *  Local by design: zero extra round-trips for the whole list. */
  const recordVs = (pid: string | undefined): string | null => {
    const o = pid ? recentOpponents.find((r) => r.pid === pid) : undefined;
    return o && o.wins + o.losses > 0 ? `${o.wins}-${o.losses}` : null;
  };
  /** "Seen 2 h ago" for an offline friend (compact, best-effort server hint). */
  const seenAgo = (ts?: number): string | null => {
    if (!ts) return null;
    const min = Math.max(1, Math.round((Date.now() - ts) / 60_000));
    const txt = min < 60 ? `${min} min` : min < 1440 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`;
    return t('seenAgo').replace('{t}', txt);
  };
  const onlineCount = friends.filter((f) => f.online).length;

  /** Compliance + responsible-gaming gate for a SPECIFIC stake (also enforced
   *  server-side). Must take the stake as an argument — the 4-player sheet has
   *  its own stake, decoupled from the 1v1 hero picker, so reading the global
   *  stakeCents here would gate the wrong amount (and skip the gate entirely
   *  when the hero picker sits at its default Free/0). */
  function stakeBlockedMsg(stake: number): string | null {
    if (stake === 0) return null;
    if (stakingBlocked) return t('geoBlocked');
    if (limits.selfExcludedUntil) return `${t('rgExcludedUntil')} ${limits.selfExcludedUntil}`;
    if (limits.stakedTodayCents + stake > limits.dailyLimitCents) return t('rgLimitHit');
    return null; // low balance is handled separately (MiniPay Add-Cash deeplink)
  }

  /** Staked play needs a REAL wallet (no demo money): true = handled (blocked
   *  or connecting), so the caller must not start the game. */
  function guardStaked(stake: number): boolean {
    if (stake === 0) return false;
    if (!walletBacked) {
      void onConnectWallet(); // attempt (instant inside MiniPay); toasts if none
      return true;
    }
    // Compliance blocks (geo / self-exclusion / daily cap) take priority.
    const blocked = stakeBlockedMsg(stake);
    if (blocked) {
      dispatch({ type: 'TOAST', message: blocked });
      return true;
    }
    // Low balance: MiniPay requires a top-up deeplink, not an error message.
    if (balanceCents < stake) {
      if (isMiniPay()) window.location.href = ADD_CASH;
      else dispatch({ type: 'TOAST', message: t('insufficient') });
      return true;
    }
    return false;
  }

  // All rationalised tiers fit the picker now (0 / 25¢ / $1 / $5).
  const lobbyStakes = ALLOWED_STAKES_CENTS;

  function createTable() {
    if (guardStaked(stakeCents)) return;
    onCreateTable(stakeCents);
  }

  // 4-player: a mode chooser (practice / free online / real money) with its OWN
  // stake — decoupled from the 1v1 picker so a staked table can never start by
  // surprise. Each option closes the sheet and launches; staked also guards.
  const closeSheet = (): void => void dispatch({ type: 'TABLE4_MODAL', open: false });
  const sheetPractice = (): void => { closeSheet(); onPractice4(); };
  const sheetFree = (): void => { closeSheet(); onPlay4(0); };
  const sheetStaked = (s: number): void => {
    if (guardStaked(s)) return; // not backed / blocked → keep the sheet open to retry
    closeSheet();
    onPlay4(s as StakeCents); // s is drawn from ALLOWED_STAKES_CENTS
  };

  // Stakes are secondary in the hero (Option A): a "Play for USDT" toggle reveals
  // the tiers, so the dominant CTA can be a plain free online 1v1.
  const [showStakes, setShowStakes] = useState(false);
  // Real-money tiers only (Free is the primary CTA, not a tile anymore).
  const stakedTiers = lobbyStakes.filter((s) => s > 0);
  // PERSONAL history only — a brand-new visitor must not be shown a "Today 0/0/0"
  // card just because the GLOBAL league happens to have other players in it. The
  // league leaderboard renders on its own below (as social proof), decoupled.
  const hasHistory =
    profile.games > 0 || streak.days > 0 || tickets > 0 || recentOpponents.length > 0;

  /** Launch a staked 1v1 directly from a stake tile (guarded for wallet/limits). */
  const playStaked = (s: number): void => {
    if (guardStaked(s)) return;
    onPlay(s as StakeCents);
  };

  // Hero die: the REAL in-game 3D die, playable right on the lobby — tap it and
  // it tumbles with the real roll sound. The product demos itself.
  const [heroDie, setHeroDie] = useState<{ value: number; key: number }>({ value: 6, key: 0 });
  const rollHeroDie = (): void => {
    playDice();
    setHeroDie((d) => ({ value: 1 + Math.floor(Math.random() * 6), key: d.key + 1 }));
  };

  return (
    <div className="screen screen--lobby">
      <TopBar onConnect={onConnectWallet} onDisconnect={onDisconnectWallet} />

      {stakingBlocked && <div className="reconnectbar">🌍 {t('geoBlocked')}</div>}

      {/* HERO (Option A): one promise, one dominant CTA that starts a REAL online
          1v1 for free. Stakes are a secondary, opt-in choice below. The scene
          shows the game itself — four seat-colour pegs around the real 3D die,
          which is tappable and rolls with the real engine + sound. */}
      <div className="hero hero--table">
        <div className="herotable">
          <span className="herotable__glow" aria-hidden="true" />
          <div className="herotable__pegs" aria-hidden="true">
            <HeroPeg colors={PEG_COLORS.red} idKey="hp-red" />
            <HeroPeg colors={PEG_COLORS.blue} idKey="hp-blue" />
          </div>
          <button type="button" className="herotable__die" onClick={rollHeroDie} aria-label={t('tapDie')}>
            <Die3D value={heroDie.value} rollKey={heroDie.key} skin={skinById(diceSkin)} />
          </button>
          <div className="herotable__pegs" aria-hidden="true">
            <HeroPeg colors={PEG_COLORS.green} idKey="hp-green" />
            <HeroPeg colors={PEG_COLORS.yellow} idKey="hp-yellow" />
          </div>
        </div>
        <h1 className="hero__tagline">{t('tagline')}</h1>
      </div>

      <button className="btn btn--hero" onClick={() => { playTap(); onPlay(0); }}>
        {t('play')}
        <small>{t('playFreeSub')}</small>
      </button>

      {/* Secondary money path: reveal the USDT stake tiles on demand. */}
      <button
        className={`btn btn--usdt${showStakes ? ' btn--usdt-open' : ''}`}
        onClick={() => { playTap(); setShowStakes((v) => !v); }}
        aria-expanded={showStakes}
      >
        <span className="btn--usdt__lead">
          <span className="btn--usdt__coin" aria-hidden="true">$</span>
          {t('playForUsdt')}
        </span>
        <span className="btn--usdt__hint">{t('winUpTo')} {fmtUsd(potCents(500 as StakeCents))} {showStakes ? '▲' : '▾'}</span>
      </button>
      {showStakes && (
        <div className="gstakes gstakes--reveal">
          {stakedTiers.map((s) => {
            const locked = !walletBacked;
            return (
              <button
                key={s}
                className={`gstake${locked ? ' gstake--locked' : ''}`}
                onClick={() => { playTap('select'); playStaked(s); }}
              >
                <b>{s >= 100 ? `$${s / 100}` : `${s}¢`}</b>
                <small>
                  {locked ? (<><IconShield className="gstake__lock" /> {t('needsWallet')}</>) : `${t('win')} ${fmtUsd(potCents(s))}`}
                </small>
              </button>
            );
          })}
        </div>
      )}
      {walletBacked && limits.stakedTodayCents > 0 && (
        <small className="stagehint" style={{ display: 'block', marginTop: 6 }}>
          {t('realityStaked')} {fmtUsd(limits.stakedTodayCents)} / {fmtUsd(limits.dailyLimitCents)}
        </small>
      )}

      {/* The promise in three steps — right under the CTAs so a first-time visitor
          understands the product (free-first, fair, seasonal rewards) before the
          rest of the page. */}
      <div className="howstrip">
        <span><i>1</i>{t('howStep1')}</span>
        <span><i>2</i>{t('howStep2')}</span>
        <span><i>3</i>{t('howStep3')}</span>
      </div>

      {/* RACE WEEK — the live event surface (only while the server reports it
          armed). A time-limited leaderboard with a subsidised micro-stake: the
          player mints a soulbound RacePass (anti-sybil entry) and the pool funds
          their stake quota, then event 1v1s score on the board. Premium event
          styling: dark racing card, LIVE badge, ticking countdown, pool gauge and
          a podium preview — an event must read as the most special thing on the
          page, not another grey row. */}
      {race?.active && (() => {
        // No endsAt configured = open-ended armed event: never read as "ended",
        // no countdown chip. With an endsAt, a live (30 s tick) countdown; the
        // join CTA disables once it's elapsed.
        const remaining = race.endsAt ? new Date(race.endsAt).getTime() - raceNow : Infinity;
        const ended = remaining <= 0;
        const endsLabel =
          remaining === Infinity
            ? null
            : ended
              ? t('raceEnded')
              : remaining < 3_600_000
                ? t('raceEndsIn').replace('{t}', `${Math.max(1, Math.floor(remaining / 60_000))} min`)
                : remaining < 86_400_000
                  ? t('raceEndsIn').replace('{t}', `${Math.floor(remaining / 3_600_000)} h ${Math.floor((remaining % 3_600_000) / 60_000)} min`)
                  : t('raceEndsIn').replace('{t}', `${Math.floor(remaining / 86_400_000)} d ${Math.floor((remaining % 86_400_000) / 3_600_000)} h`);
        const top3 = (raceBoard?.top ?? []).slice(0, 3);
        const medals = ['🥇', '🥈', '🥉'];
        return (
          <>
            <div className="seclabel">🏁 {t('raceTitle')}</div>
            <div className="card racecard">
              <div className="racecard__top">
                <span className="racecard__flag" aria-hidden="true">🏁</span>
                <div className="racecard__id">
                  <b>
                    {t('raceCardTitle')}
                    {!ended && <em className="racecard__live">● {t('raceLiveBadge')}</em>}
                  </b>
                  <small>{race.funded ? `✅ ${t('raceFundedLabel')} · ${fmtUsd(race.quotaCents)} ${t('raceQuota')}` : t('raceCardSub')}</small>
                </div>
                {endsLabel && <span className={`racecard__timer${remaining < 86_400_000 ? ' racecard__timer--soon' : ''}`}>⏱ {endsLabel}</span>}
              </div>

              {/* Podium preview: the top 3 as one glanceable strip — the social
                  pull ("I could be up there") without opening the sheet. */}
              {top3.length > 0 && (
                <button className="racecard__podium" onClick={() => { playTap(); onOpenRaceBoard(); }}>
                  {top3.map((r, i) => (
                    <span key={r.rank} className={`racecard__podchip${i === 0 ? ' racecard__podchip--first' : ''}`}>
                      {medals[i]} <b>{r.name}</b> {r.points}
                    </span>
                  ))}
                </button>
              )}

              {/* The FIXED leaderboard prize — a stable reward for the top players.
                  NOT the gas/stake faucet (a separate internal budget that drains as
                  players are subsidised); showing that here read as "the prize is
                  shrinking". This stays constant for the whole event. */}
              {race.prizePoolCents ? (
                <div className="racebar racebar--prize">
                  <span>🏆 {t('racePrizeLabel')}</span>
                  <b>{fmtUsd(race.prizePoolCents)}</b>
                </div>
              ) : null}

              <div className="racecard__actions">
                {race.funded ? (
                  <button className="btn btn--race btn--race-play" onClick={() => { playTap('select'); onPlayRace(); }}>
                    🎲 {t('racePlayCta')} <small>{fmtUsd(1)} · {t('racePlaySub')}</small>
                  </button>
                ) : (
                  <button
                    className="btn btn--race"
                    disabled={raceJoining || ended}
                    onClick={() => { playTap('select'); onJoinRace(); }}
                  >
                    {raceJoining ? `⏳ ${t('raceJoining')}` : <>🎟️ {t('raceMintCta')} <small>{t('raceMintSub')}</small></>}
                  </button>
                )}
                <button className="racecard__board" onClick={() => { playTap(); onOpenRaceBoard(); }} aria-label={t('raceBoardCta')}>
                  🏆<small>{t('raceBoardCta')}</small>
                </button>
              </div>
              <small className="racecard__rule">{t('raceScoring')}</small>
            </div>
          </>
        );
      })()}

      {/* PENDING FRIEND REQUESTS — promoted near the top: a request is the most
          actionable social moment on the page, and it persists server-side until
          answered, so surfacing it prominently is what stops it being "lost".
          Full lifecycle: accept (gold) OR decline (✕ → friend.remove clears the
          edge server-side); tapping the person opens their public profile so
          you're not accepting blind. */}
      {friendRequests.length > 0 && (
        <div className="card friendreqcard">
          <div className="friendhead">
            <b>🔔 {t('friendRequestsTitle')}</b>
            <span className="friendhead__count">{friendRequests.length}</span>
          </div>
          {friendRequests.map((r, i) => (
            <div key={r.pid} className="friendrow friendrow--anim" style={{ '--i': i } as React.CSSProperties}>
              <button className="friendrow__hit" onClick={() => { playTap(); onViewProfile(r.pid); }} aria-label={`${r.name} profile`}>
                <span className={`friendrow__flag ${frameClass(r.frame)}`}>
                  {avatarSrc(r.avatar) ? <img className="profilecard__img" src={avatarSrc(r.avatar)!} alt="" /> : r.flag}
                  <PremiumFrame frame={r.frame} />
                </span>
                <span className="friendrow__meta">
                  <b>{r.name}{recordVs(r.pid) && <em className="h2hchip">{recordVs(r.pid)} {t('vsYou')}</em>}</b>
                  <small>{t('friendRequestLabel')} · {r.elo} ELO</small>
                </span>
              </button>
              <button className="frbtn frbtn--gold" onClick={() => { playTap('select'); void onAcceptFriend(r.pid); }}>
                ✓ {t('friendAccept')}
              </button>
              <button className="frbtn frbtn--danger" aria-label={`${t('friendRemove')} ${r.name}`} onClick={() => { playTap(); onRemoveFriendEdge(r.pid); }}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* SENT INVITATIONS — the sender's view: every request I made that the
          other side hasn't answered yet, with a quiet withdraw. Without this
          list a sent request was fire-and-forget ("did it even go through?"). */}
      {sentRequests.length > 0 && (
        <div className="card friendscard">
          <div className="friendhead">
            <b>⏳ {t('sentRequestsTitle')}</b>
            <span className="friendhead__count">{sentRequests.length}</span>
          </div>
          {sentRequests.map((r, i) => (
            <div key={r.pid} className="friendrow friendrow--anim" style={{ '--i': i } as React.CSSProperties}>
              <button className="friendrow__hit" onClick={() => { playTap(); onViewProfile(r.pid); }} aria-label={`${r.name} profile`}>
                <span className={`friendrow__flag ${frameClass(r.frame)}`}>
                  {avatarSrc(r.avatar) ? <img className="profilecard__img" src={avatarSrc(r.avatar)!} alt="" /> : r.flag}
                  <PremiumFrame frame={r.frame} />
                </span>
                <span className="friendrow__meta">
                  <b>{r.name}</b>
                  <small>{t('sentPending')}</small>
                </span>
              </button>
              <button
                className="frbtn frbtn--ghost"
                aria-label={`${t('sentWithdraw')} ${r.name}`}
                onClick={() => { playTap(); onRemoveFriendEdge(r.pid); }}
              >
                ✕ {t('sentWithdraw')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* SEASON PASS — the progression hub (crowns → tiers → rewards). Hidden
          until the player has SOME history: a first-time visitor must not face
          "Tier 0/50 · 0/30" walls of zeros plus a $ purchase before their first
          game (same principle as the guarded profile stats below). */}
      {season && hasHistory && (() => {
        const reached = season.tier;
        const maxed = reached >= season.tierCount;
        const prevCost = crownsForTier(reached);
        const nextCost = crownsForTier(Math.min(reached + 1, season.tierCount));
        const pct = maxed ? 100 : Math.min(100, Math.round(((season.crowns - prevCost) / Math.max(1, nextCost - prevCost)) * 100));
        const claimable = season.tiers.filter((d) => season.tier >= d.tier && !season.claimedFree.includes(d.tier)).length;
        const openSheet = (): void => { playTap(); dispatch({ type: 'SEASON_MODAL', open: true }); };
        return (
          <>
            <div className="seclabel">👑 {t('seasonTitle')}</div>
            <button className="card seasoncard" onClick={openSheet}>
              <div className="seasoncard__top">
                <span className="seasoncard__crown" aria-hidden="true">👑</span>
                <div className="seasoncard__id">
                  <b>{t('seasonTier')} {reached}/{season.tierCount}</b>
                  <small>{season.premium ? `✓ ${t('seasonPremiumOwned')}` : t('seasonCardValue')}</small>
                </div>
                <span className="seasoncard__crowns">👑 {season.crowns}{maxed ? '' : ` / ${nextCost}`}</span>
              </div>
              <div className="seasonbar__track seasoncard__bar"><span className="seasonbar__fill" style={{ width: `${pct}%` }} /></div>
              <div className="seasoncard__foot">
                {claimable > 0
                  ? <span className="seasoncard__claim">🎁 {claimable} {t('seasonClaim')}</span>
                  : <span className="seasoncard__hint">{t('seasonCardCta')}</span>}
                {!season.premium && cosmeticsCusdAvailable && (
                  <span className="seasoncard__prem">👑 {t('seasonPremiumTitle')} · {fmtUsd(SEASON_PREMIUM.cents)}</span>
                )}
              </div>
            </button>
          </>
        );
      })()}

      <div className="seclabel">{t('gameModes')}</div>
      <div className="card modelist">
        <button className="mrow" onClick={() => { playTap(); dispatch({ type: 'TABLE4_MODAL', open: true }); }}>
          <span className="mrow__ic mrow__ic--gold"><IconUsers /></span>
          <span className="mrow__txt">
            <b>{t('fourPlayer')}</b>
            <small>{`${t('t4Practice')} · ${t('t4FreeOnline')} · ${t('t4Real')}`}</small>
          </span>
          <span className="mrow__chev" aria-hidden="true">›</span>
        </button>
        <button className="mrow" onClick={() => { playTap(); createTable(); }}>
          <span className="mrow__ic mrow__ic--me"><IconUsers /></span>
          <span className="mrow__txt">
            <b>{t('privateTable')}</b>
            <small>{t('privateTableDesc')}</small>
          </span>
          <span className="mrow__chev" aria-hidden="true">›</span>
        </button>
        <button
          className={`mrow${tickets < FREEROLL.entryTickets ? ' mrow--dim' : ''}`}
          onClick={() => {
            playTap();
            if (tickets < FREEROLL.entryTickets) dispatch({ type: 'TOAST', message: t('freerollNeedTicket') });
            else onFreeroll();
          }}
        >
          <span className="mrow__ic mrow__ic--gold"><IconTrophy /></span>
          <span className="mrow__txt">
            <b>{t('freeroll')}</b>
            <small>{t('freerollDesc')}</small>
          </span>
          <span className="mrow__badge"><IconTicket className="mrow__ticket" /> {tickets}</span>
        </button>
      </div>

      {/* COSMETICS SHOP — a real lobby entry. The ONLY way in used to be a tiny
          unlabeled die icon in the topbar, indistinguishable from a settings
          toggle ("the shop is invisible"). This card names it, previews the
          catalog, and wears the gold store language — it IS the monetisation
          surface. Opens the same cosmetics sheet as the topbar icon. */}
      <button className="card shopcard" onClick={() => { playTap(); dispatch({ type: 'DICE_MODAL', open: true }); }}>
        <span className="shopcard__ic" aria-hidden="true">🛍️</span>
        <span className="mrow__txt">
          <b>{t('shopCardTitle')}</b>
          <small>{t('shopCardSub')}</small>
        </span>
        <span className="shopcard__previews" aria-hidden="true">🎲✨</span>
        <span className="mrow__chev" aria-hidden="true">›</span>
      </button>

      {/* ADD FRIENDS — the proactive invite entry the lobby was missing: players
          I recently faced (wallet-linked → have a pid) that I'm not already
          friends with / haven't already invited. Tapping ➕ sends a friend
          request (onAcceptFriend = friend.add serves both invite and accept).
          Wallet-gated like the whole feature — hidden for guests so there's no
          dead button that always errors "connect a wallet". */}
      {walletBacked && addableOpponents.length > 0 && (
        <div className="card friendscard">
          <div className="friendhead">
            <b>➕ {t('addFriendsTitle')}</b>
            <span className="friendhead__count">{addableOpponents.length}</span>
          </div>
          {addableOpponents.map((o, i) => (
            <div key={o.pid} className="friendrow friendrow--anim" style={{ '--i': i } as React.CSSProperties}>
              <button className="friendrow__hit" onClick={() => { playTap(); onViewProfile(o.pid); }} aria-label={`${o.name} profile`}>
                <span className={`friendrow__flag ${frameClass(o.frame)}`}>
                  {o.flag}
                  <PremiumFrame frame={o.frame} />
                </span>
                <span className="friendrow__meta">
                  <b>{o.name}{recordVs(o.pid) && <em className="h2hchip">{recordVs(o.pid)} {t('vsYou')}</em>}</b>
                  <small>{t('addFriendHint')}</small>
                </span>
              </button>
              <button
                className="frbtn frbtn--gold"
                aria-label={`${t('addFriend')} ${o.name}`}
                onClick={() => { playTap('select'); void onAcceptFriend(o.pid); }}
              >
                ➕ {t('addFriend')}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* FRIENDS (E-social 2): the persistent circle. Living presence (online
          first, pulsing dot, "seen 2 h ago"), tap-through to the public profile
          (head-to-head), gift, stake-picked challenge, and a 2-tap unfriend. */}
      {friends.length > 0 && (
        <div className="card friendscard">
          <div className="friendhead">
            <b>{t('friendsTitle')}</b>
            <span className="friendhead__count">{friends.length}</span>
            {onlineCount > 0 && <small className="friendhead__online">● {onlineCount} {t('friendOnline')}</small>}
          </div>
          {friends.map((f, i) => (
            <div key={f.pid} className="friendrow friendrow--anim" style={{ '--i': i } as React.CSSProperties}>
              <button className="friendrow__hit" onClick={() => { playTap(); onViewProfile(f.pid); }} aria-label={`${f.name} profile`}>
                <span className={`friendrow__flag ${frameClass(f.frame)}`}>
                  {avatarSrc(f.avatar) ? <img className="profilecard__img" src={avatarSrc(f.avatar)!} alt="" /> : f.flag}
                  <PremiumFrame frame={f.frame} />
                  {f.online && <i className="friendrow__dot" title={t('friendOnline')} />}
                </span>
                <span className="friendrow__meta">
                  <b>{f.name}{recordVs(f.pid) && <em className="h2hchip">{recordVs(f.pid)} {t('vsYou')}</em>}</b>
                  <small>{f.online ? t('friendOnline') : seenAgo(f.lastSeenTs) ?? `${f.elo} ELO`}</small>
                </span>
              </button>
              {/* Gift a cosmetic (phase 2): opens the catalog picker for this friend. */}
              <button
                className="frbtn frbtn--icon"
                aria-label={`${t('giftTitle')} ${f.name}`}
                onClick={() => { playTap(); dispatch({ type: 'GIFT_MODAL', friend: f }); }}
              >
                🎁
              </button>
              <button className="frbtn frbtn--gold" onClick={() => { playTap(); setChallengeTarget({ pid: f.pid, name: f.name }); }}>
                ⚔️ {t('friendChallenge')}
              </button>
              <button
                className={`frbtn frbtn--danger${confirmRemove === f.pid ? ' frbtn--armed' : ''}`}
                aria-label={`${t('friendRemove')} ${f.name}`}
                onClick={() => armRemove(f.pid)}
              >
                {confirmRemove === f.pid ? t('friendRemoveConfirm') : '✕'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* EMPTY-STATE TEASER — discoverability: with no circle at all, the whole
          feature used to be invisible (every section hidden when empty), so a
          new player never learnt it existed. One quiet card explains it. */}
      {walletBacked && friends.length === 0 && friendRequests.length === 0 && sentRequests.length === 0 && addableOpponents.length === 0 && (
        <div className="card friendteaser">
          <span className="friendteaser__ic">🤝</span>
          <span className="friendrow__meta">
            <b>{t('emptyFriendsTitle')}</b>
            <small>{t('emptyFriendsBody')}</small>
          </span>
        </div>
      )}

      {/* CHALLENGE STAKE SHEET (P1): ⚔️ on a friend opens this picker instead of
          silently creating a FREE table — staked friend duels are the product's
          core loop and the server has always accepted a stake here. Staked picks
          run the same wallet/compliance/balance guard as every staked entry. */}
      {challengeTarget && (
        <div className="modal" onClick={() => setChallengeTarget(null)}>
          <div className="modal__card challengesheet" onClick={(e) => e.stopPropagation()}>
            <h3>⚔️ {t('friendChallenge')} {challengeTarget.name}</h3>
            <div className="challengesheet__opts">
              {lobbyStakes.map((s) => (
                <button
                  key={s}
                  className={`frbtn ${s === 0 ? 'frbtn--ghost' : 'frbtn--gold'}`}
                  onClick={() => {
                    if (s > 0 && guardStaked(s)) return; // wallet/RG/balance gate — sheet stays open
                    const pid = challengeTarget.pid;
                    setChallengeTarget(null);
                    playTap('select');
                    onChallengeFriend(pid, s as StakeCents);
                  }}
                >
                  {s === 0 ? t('challengeFree') : `${fmtUsd(s)} → ${fmtUsd(potCents(s as StakeCents))}`}
                </button>
              ))}
            </div>
            <button className="closehint" onClick={() => { playTap(); setChallengeTarget(null); }}>
              {t('cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Identity + progression. Stats (ELO/W-L/division) are shown ONLY for a
          wallet-backed account: a guest carries default-looking numbers (Silver,
          1200, 0-0) that read as fake data — reported twice. Guests instead get
          a slim row that keeps the profile editor reachable, with no numbers. */}
      {walletBacked && profile.name ? (
        <button
          className="card profilecard"
          onClick={() => { playTap(); dispatch({ type: 'PROFILE_EDIT', open: true }); }}
          aria-label={t('editProfile')}
        >
          <div className="profilecard__id">
            <span className={`profilecard__flag ${frameClass(avatarFrame)}`}>
              {avatarSrc(avatar) ? <img className="profilecard__img" src={avatarSrc(avatar)!} alt="" /> : profile.flag}
              <PremiumFrame frame={avatarFrame} />
            </span>
            <div className="profilecard__meta">
              <b>{profile.name}</b>
            </div>
          </div>
          <div className="profilecard__stats">
            <span><b>{profile.elo}</b> ELO</span>
            <span className="profilecard__w">{profile.wins} {t('winsShort')}</span>
            <span className="profilecard__l">{Math.max(0, profile.games - profile.wins)} {t('lossesShort')}</span>
          </div>
          <span className="profilecard__edit" aria-hidden="true">✏️</span>
        </button>
      ) : (
        <button
          className="card guestrow"
          onClick={() => { playTap(); dispatch({ type: 'PROFILE_EDIT', open: true }); }}
          aria-label={t('editProfile')}
        >
          <span className="guestrow__flag">{avatarSrc(avatar) ? <img className="profilecard__img" src={avatarSrc(avatar)!} alt="" /> : '🌍'}</span>
          <b>{profile.name || t('guestLabel')}</b>
          <small>{t('setupProfile')}</small>
          <span className="profilecard__edit" aria-hidden="true">✏️</span>
        </button>
      )}

      {/* A brand-new player (no personal history) gets ONE clear incentive to start.
          The daily loop + rivals live in the Progression sheet (top-bar), so the
          landing stays focused on Play + Season. The weekly league was retired. */}
      {!hasHistory && (
        <div className="card firstwin">
          <span className="chip-ic chip-ic--opp"><IconTrophy /></span>
          <span>{t('firstWin')}</span>
        </div>
      )}

      {/* modal-opening "links" are buttons (keyboard-focusable, exposed to AT);
          only the mailto is a real anchor. */}
      <div className="fairnote">
        {t('fairnote')}{' '}
        <button type="button" className="linklike" onClick={() => dispatch({ type: 'FAIR_MODAL', open: true })}>{t('howItWorks')}</button>
        {' · '}
        <button type="button" className="linklike" onClick={() => dispatch({ type: 'SETTINGS', open: true })}>{t('rgLink')}</button>
      </div>
      {/* info & legal: the landing said nothing about tickets/freeroll/league,
          and Terms/Privacy/Support had no entry point outside the staking gate. */}
      <div className="fairnote fairnote--links">
        <button type="button" className="linklike" onClick={() => { playTap(); dispatch({ type: 'HELP_MODAL', open: true }); }}>{t('footHelp')}</button>
        {' · '}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{t('footSupport')}</a>
        {' · '}
        <button type="button" className="linklike" onClick={() => dispatch({ type: 'LEGAL_DOC', doc: 'tos' })}>{t('legalReadTos')}</button>
        {' · '}
        <button type="button" className="linklike" onClick={() => dispatch({ type: 'LEGAL_DOC', doc: 'privacy' })}>{t('legalReadPrivacy')}</button>
        {/* Build id — support can instantly tell whether a report comes from a
            stale cached bundle (webview/service-worker) or the current deploy. */}
        {' · '}
        <span className="buildtag">v{__APP_VERSION__}</span>
      </div>

      <Table4Modal onPractice={sheetPractice} onFree={sheetFree} onStaked={sheetStaked} />
    </div>
  );
}
