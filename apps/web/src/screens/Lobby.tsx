import { ALLOWED_STAKES_CENTS, DIVISIONS, potCents, type StakeCents } from '@ludo/shared';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { TopBar, Table4Modal } from '../components/ui';
import { IconFlame, IconTarget, IconTicket, IconTrophy, IconUsers } from '../components/icons';
import { isMiniPay } from '../lib/minipay';
import { playTap } from '../lib/sound';
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
  const { stakeCents, streak, challenge, league, tickets, limits, stakingBlocked, balanceCents, walletBacked, profile } = useAppState();
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

      {/* stake picker + CTA first: the primary action stays above the fold */}
      <div className="hero">
        <div className="hero__kicker">{t('chooseStake')}</div>
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

      <button className="btn btn--hero" onClick={() => { playTap(); play(); }}>
        {t('play')}
        <small>
          {stakeCents === 0
            ? `${t('training')} · ${t('fourPlayer')}`
            : `1v1 · ${fmtUsd(stakeCents)} → ${t('win')} ${fmtUsd(potCents(stakeCents))}`}
        </small>
      </button>

      <div style={{ height: 14 }} />

      {/* Stable identity card: same name + country flag every session (wallet-keyed),
          with ELO + W/L. The player's public identity — never a raw 0x address. */}
      {profile.name && (
        <div className="card profilecard">
          <div className="profilecard__id">
            <span className="profilecard__flag">{profile.flag}</span>
            <b>{profile.name}</b>
            <span className="profilecard__div">{DIVISIONS[league.division] ?? ''}</span>
          </div>
          <div className="profilecard__stats">
            <span><b>{profile.elo}</b> ELO</span>
            <span className="profilecard__w">{profile.wins} {t('winsShort')}</span>
            <span className="profilecard__l">{Math.max(0, profile.games - profile.wins)} {t('lossesShort')}</span>
          </div>
        </div>
      )}

      {/* day-zero aware: at 0 days the card sells the action, not the zero */}
      <div className="streak">
        <div className="streak__fire">
          <IconFlame />
        </div>
        <div>
          <b>{streak.days > 0 ? `${t('dailyStreak')} ${streak.days} ${t('days')}` : t('streakStart')}</b>
          <small>{t('streakHint')}</small>
        </div>
        {tickets > 0 && (
          <div className="ticketcount">
            <IconTicket /> {tickets}
          </div>
        )}
      </div>

      <div className="minis">
        <div
          className={`mini mini--action${tickets < 1 ? ' mini--dim' : ''}`}
          onClick={() => {
            if (tickets < 1) dispatch({ type: 'TOAST', message: t('freerollNeedTicket') });
            else onFreeroll();
          }}
        >
          <b>
            <IconTrophy className="icon--gold" /> {t('freeroll')}
            <span className="mini__badge">🎟️ {tickets}</span>
          </b>
          {t('freerollDesc')}
        </div>
        <div className="mini mini--action" onClick={() => { playTap(); dispatch({ type: 'TABLE4_MODAL', open: true }); }}>
          <b>
            <IconUsers className="icon--gold" /> {t('fourPlayer')}
            <span className="mini__badge">▸</span>
          </b>
          {/* names the three modes so the choice is explicit, not inherited */}
          {`${t('t4Practice')} · ${t('t4FreeOnline')} · ${t('t4Real')}`}
        </div>
        <div className="mini mini--action" onClick={createTable}>
          <b>
            <IconUsers className="icon--me" /> {t('privateTable')}
          </b>
          {t('privateTableDesc')}
        </div>
      </div>

      {/* One-glance rules of the money game: what you pay, what you can win,
          what the house takes, and what tickets are. Kills the #1 confusion. */}
      <div className="card howcard">
        <h3>💡 {t('howTitle')}</h3>
        <ol className="howlist">
          <li>{t('howStep1')}</li>
          <li>{t('howStep2')}</li>
          <li>{t('howStep3')}</li>
        </ol>
        <small className="muted">{t('howTickets')}</small>
      </div>

      <div className="card">
        <h3>
          <span className="chip-ic">
            <IconTrophy />
          </span>
          {DIVISIONS[league.division] ?? '—'} {t('league')}
          {inLeague && (
            <span className="h3val">
              {league.rank > 0 ? `#${league.rank}` : '—'} · {league.points} {t('lp')}
            </span>
          )}
        </h3>
        {league.top.length > 0 ? (
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
        ) : (
          <ol className="board board--ghost">
            {[1, 2, 3].map((n) => (
              <li key={n}>
                <span>{n}. ·····</span>
                <b>—</b>
              </li>
            ))}
          </ol>
        )}
        <small className="muted">{inLeague ? t('leagueHint') : t('leagueEmpty')}</small>
      </div>

      <div style={{ height: 14 }} />

      <div className="card" style={{ marginBottom: 0 }}>
        <h3>
          <span className="chip-ic chip-ic--opp">
            <IconTarget />
          </span>
          {t('dailyChallenge')}
          <span className="h3val" style={{ color: 'var(--muted)' }}>
            {challenge.progress}/{challenge.target}
          </span>
        </h3>
        <div style={{ fontSize: 13 }} className="muted">
          {challenge.completed ? (
            <b style={{ color: 'var(--accent)' }}>{t('challengeDone')}</b>
          ) : (
            <>
              {t('challengeDesc')} <b style={{ color: 'var(--accent)' }}>{t('challengeReward')}</b>
            </>
          )}
        </div>
        <div className="progress">
          {Array.from({ length: challenge.target }, (_, i) => (
            <span key={i} className={i < Math.min(challenge.progress, challenge.target) ? 'on' : ''} />
          ))}
        </div>
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
