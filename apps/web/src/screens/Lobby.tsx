import { ALLOWED_STAKES_CENTS, DIVISIONS, potCents, type StakeCents } from '@ludo/shared';
import { RIVAL_GAMES, fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { TopBar, Table4Modal } from '../components/ui';
import { IconFlame, IconTarget, IconTicket, IconTrophy, IconUsers } from '../components/icons';
import { isMiniPay } from '../lib/minipay';
import { playTap } from '../lib/sound';
import { frameClass } from '../lib/avatarFrames';
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
  onViewProfile,
}: {
  onPlay(stake: StakeCents): void;
  onCreateTable(stake: StakeCents): void;
  onFreeroll(): void;
  onPlay4(stake: StakeCents): void;
  /** Launch the offline 4-player practice game (you + 3 bots). */
  onPractice4(): void;
  /** Connect MiniPay/injected wallet; resolves true when connected. */
  onConnectWallet(): Promise<boolean>;
  /** Tap a league row → open that player's public profile sheet. */
  onViewProfile(pid: string): void;
}) {
  const { stakeCents, streak, challenge, league, tickets, limits, stakingBlocked, balanceCents, walletBacked, profile, avatarFrame, recentOpponents } = useAppState();
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

  function play() {
    if (guardStaked(stakeCents)) return;
    onPlay(stakeCents);
  }

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

  const inLeague = league.rank > 0 || league.points > 0;

  return (
    <div className="screen screen--lobby">
      <TopBar onConnect={onConnectWallet} />

      {stakingBlocked && <div className="reconnectbar">🌍 {t('geoBlocked')}</div>}

      {/* HERO — one idea per band: promise → stake → the single dominant CTA.
          A first-time user reads: what it is, what it costs, where to tap. */}
      <div className="hero">
        <div className="hero__tagline">{t('tagline')}</div>
        <div className="gstakes">
          {lobbyStakes.map((s) => {
            // Staked tiers are visibly locked until a real wallet backs the
            // balance (no demo money); tapping one attempts the connection.
            const locked = s > 0 && !walletBacked;
            return (
              <button
                key={s}
                className={`gstake${s === stakeCents ? ' gstake--sel' : ''}${s === 0 ? ' gstake--free' : ''}${locked ? ' gstake--locked' : ''}`}
                onClick={() => {
                  playTap('select');
                  dispatch({ type: 'SELECT_STAKE', stake: s });
                  if (locked) void onConnectWallet();
                }}
              >
                <b>{s === 0 ? t('free') : s >= 100 ? `$${s / 100}` : `${s}¢`}</b>
                <small>{s === 0 ? t('training') : locked ? `🔒 ${t('needsWallet')}` : `${t('win')} ${fmtUsd(potCents(s))}`}</small>
              </button>
            );
          })}
        </div>
        {/* responsible-gaming budget, visible where the money decision is made */}
        {stakeCents > 0 && walletBacked && (
          <small className="muted" style={{ display: 'block', marginTop: 6 }}>
            {t('realityStaked')} {fmtUsd(limits.stakedTodayCents)} / {fmtUsd(limits.dailyLimitCents)}
          </small>
        )}
      </div>

      <button className="btn btn--hero" onClick={play}>
        {t('play')}
        <small>
          {stakeCents === 0
            ? `${t('training')} · ${t('fourPlayer')}`
            : `1v1 · ${fmtUsd(stakeCents)} → ${t('win')} ${fmtUsd(potCents(stakeCents))}`}
        </small>
      </button>

      <div style={{ height: 18 }} />

      {/* Stable identity card: same name + country flag every session (wallet-keyed),
          with ELO + W/L. The player's public identity — never a raw 0x address. */}
      {profile.name && (
        <button
          className="card profilecard"
          onClick={() => { playTap(); dispatch({ type: 'PROFILE_EDIT', open: true }); }}
          aria-label={t('editProfile')}
        >
          <div className="profilecard__id">
            <span className={`profilecard__flag ${frameClass(avatarFrame)}`}>{profile.flag}</span>
            <div className="profilecard__meta">
              <b>{profile.name}</b>
              <span className="profilecard__div">{DIVISIONS[league.division] ?? ''}</span>
            </div>
          </div>
          <div className="profilecard__stats">
            <span><b>{profile.elo}</b> ELO</span>
            <span className="profilecard__w">{profile.wins} {t('winsShort')}</span>
            <span className="profilecard__l">{Math.max(0, profile.games - profile.wins)} {t('lossesShort')}</span>
          </div>
          <span className="profilecard__edit" aria-hidden="true">✏️</span>
        </button>
      )}

      {/* Rivals & recent opponents (C4): who you've faced in 1v1 + YOUR local
          record vs each. A rival (played ≥ RIVAL_GAMES) is badged. Tap → profile. */}
      {recentOpponents.length > 0 && (
        <div className="card rivalscard">
          <h3>
            <span className="chip-ic chip-ic--opp"><IconUsers /></span>
            {t('rivalsTitle')}
          </h3>
          <div className="rivalrow">
            {recentOpponents.map((o, i) => {
              const rival = o.wins + o.losses >= RIVAL_GAMES;
              return (
                <button
                  key={o.pid ?? i}
                  className={`rival${rival ? ' rival--rival' : ''}`}
                  disabled={!o.pid}
                  onClick={() => o.pid && onViewProfile(o.pid)}
                >
                  <span className={`rival__av ${frameClass(o.frame)}`} aria-hidden="true">{o.flag}</span>
                  <b className="rival__name">{o.name}</b>
                  <small className="rival__wl">
                    <span className="profilecard__w">{o.wins}</span>–<span className="profilecard__l">{o.losses}</span>
                  </small>
                  {rival && <span className="rival__badge" aria-label={t('rivalBadge')}>⚔️</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* GAME MODES — one scannable list, one row per mode (was a cramped
          3-column grid whose copy wrapped badly on small screens). */}
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
          className={`mrow${tickets < 1 ? ' mrow--dim' : ''}`}
          onClick={() => {
            playTap();
            if (tickets < 1) dispatch({ type: 'TOAST', message: t('freerollNeedTicket') });
            else onFreeroll();
          }}
        >
          <span className="mrow__ic mrow__ic--gold"><IconTrophy /></span>
          <span className="mrow__txt">
            <b>{t('freeroll')}</b>
            <small>{t('freerollDesc')}</small>
          </span>
          <span className="mrow__badge">🎟️ {tickets}</span>
        </button>
      </div>

      {/* TODAY — streak, daily challenge and tickets merged into ONE compact
          card (they were three separate full-width cards of equal weight). */}
      <div className="seclabel">{t('today')}</div>
      <div className="card daily">
        <div className="dstat">
          <span className="dstat__ic dstat__ic--fire"><IconFlame /></span>
          <b>{streak.days}</b>
          <small>{t('streakLabel')}</small>
        </div>
        <div className="dstat">
          <span className="dstat__ic dstat__ic--target"><IconTarget /></span>
          <b>{challenge.progress}/{challenge.target}</b>
          <small>{t('challengeLabel')}</small>
        </div>
        <div className="dstat">
          <span className="dstat__ic dstat__ic--ticket"><IconTicket /></span>
          <b>{tickets}</b>
          <small>{t('ticketsLabel')}</small>
        </div>
      </div>
      <small className="daily__hint muted">
        {challenge.completed ? t('challengeDone') : `${t('challengeDesc')} ${t('challengeReward')}`}
      </small>

      {/* League: full card only when there is something to show; otherwise a
          single-line teaser (the empty ghost rows read as broken to new users). */}
      {league.top.length > 0 || inLeague ? (
        <div className="card">
          <h3>
            <span className="chip-ic"><IconTrophy /></span>
            {DIVISIONS[league.division] ?? '—'} {t('league')}
            {inLeague && (
              <span className="h3val">
                {league.rank > 0 ? `#${league.rank}` : '—'} · {league.points} {t('lp')}
              </span>
            )}
          </h3>
          {league.top.length > 0 && (
            <ol className="board">
              {league.top.map((e, i) => (
                <li key={i} className={e.pid ? 'board__row--tap' : undefined} onClick={() => e.pid && onViewProfile(e.pid)}>
                  <span>
                    {i + 1}. {e.flag} {e.name}
                  </span>
                  <b>{e.points}</b>
                </li>
              ))}
            </ol>
          )}
          <small className="muted">{inLeague ? t('leagueHint') : t('leagueEmpty')}</small>
        </div>
      ) : (
        <div className="card leaguateaser">
          <span className="chip-ic"><IconTrophy /></span>
          <span className="leaguateaser__txt">{t('leagueEmpty')}</span>
        </div>
      )}

      {/* How it works: three tiny numbered steps in ONE row (was a tall card
          with a paragraph of ticket lore — moved to the freeroll row + modal). */}
      <div className="howstrip">
        <span><i>1</i>{t('howStep1')}</span>
        <span><i>2</i>{t('howStep2')}</span>
        <span><i>3</i>{t('howStep3')}</span>
      </div>

      <div className="fairnote">
        {t('fairnote')}{' '}
        <a onClick={() => dispatch({ type: 'FAIR_MODAL', open: true })}>{t('howItWorks')}</a>
        {' · '}
        <a onClick={() => dispatch({ type: 'SETTINGS', open: true })}>{t('rgLink')}</a>
      </div>

      <Table4Modal onPractice={sheetPractice} onFree={sheetFree} onStaked={sheetStaked} />
    </div>
  );
}
