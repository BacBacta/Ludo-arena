import { useState } from 'react';
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
}: {
  onPlay(stake: StakeCents): void;
  onCreateTable(stake: StakeCents): void;
  onFreeroll(): void;
  onPlay4(stake: StakeCents): void;
  /** Launch the offline 4-player practice game (you + 3 bots). */
  onPractice4(): void;
  /** Connect MiniPay/injected wallet; resolves true when connected. */
  onConnectWallet(): Promise<boolean>;
}) {
  const { stakeCents, streak, tickets, limits, stakingBlocked, balanceCents, walletBacked, profile, avatarFrame, avatar, recentOpponents, diceSkin, season } = useAppState();
  const dispatch = useAppDispatch();

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
      <TopBar onConnect={onConnectWallet} />

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
        <div className="hero__tagline">{t('tagline')}</div>
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
        <span className="btn--usdt__hint">{stakedTiers.map((s) => (s >= 100 ? `$${s / 100}` : `${s}¢`)).join(' · ')} {showStakes ? '▲' : '▾'}</span>
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

      {/* SEASON PASS — the progression hub (crowns → tiers → rewards). */}
      {season && (() => {
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

      <div className="fairnote">
        {t('fairnote')}{' '}
        <a onClick={() => dispatch({ type: 'FAIR_MODAL', open: true })}>{t('howItWorks')}</a>
        {' · '}
        <a onClick={() => dispatch({ type: 'SETTINGS', open: true })}>{t('rgLink')}</a>
      </div>
      {/* info & legal: the landing said nothing about tickets/freeroll/league,
          and Terms/Privacy/Support had no entry point outside the staking gate. */}
      <div className="fairnote fairnote--links">
        <a onClick={() => { playTap(); dispatch({ type: 'HELP_MODAL', open: true }); }}>{t('footHelp')}</a>
        {' · '}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{t('footSupport')}</a>
        {' · '}
        <a onClick={() => dispatch({ type: 'LEGAL_DOC', doc: 'tos' })}>{t('legalReadTos')}</a>
        {' · '}
        <a onClick={() => dispatch({ type: 'LEGAL_DOC', doc: 'privacy' })}>{t('legalReadPrivacy')}</a>
      </div>

      <Table4Modal onPractice={sheetPractice} onFree={sheetFree} onStaked={sheetStaked} />
    </div>
  );
}
