import { ALLOWED_STAKES_CENTS, DIVISIONS, potCents, potCents4, type StakeCents } from '@ludo/shared';
import { staked4Available } from '../lib/deployments';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { TopBar } from '../components/ui';
import { IconFlame, IconTarget, IconTicket, IconTrophy, IconUsers } from '../components/icons';
import { t } from '../lib/i18n';


export function Lobby({
  onPlay,
  onCreateTable,
  onFreeroll,
  onPlay4,
}: {
  onPlay(stake: StakeCents): void;
  onCreateTable(stake: StakeCents): void;
  onFreeroll(): void;
  onPlay4(stake: StakeCents): void;
}) {
  const { stakeCents, streak, challenge, league, tickets, limits, stakingBlocked, balanceCents } = useAppState();
  const dispatch = useAppDispatch();

  /** Compliance + responsible-gaming gate, also enforced server-side. */
  function stakeBlockedMsg(): string | null {
    if (stakeCents === 0) return null;
    if (stakingBlocked) return t('geoBlocked');
    if (limits.selfExcludedUntil) return `${t('rgExcludedUntil')} ${limits.selfExcludedUntil}`;
    if (limits.stakedTodayCents + stakeCents > limits.dailyLimitCents) return t('rgLimitHit');
    if (balanceCents < stakeCents) return t('insufficient');
    return null;
  }

  const lobbyStakes = ALLOWED_STAKES_CENTS.filter((s) => s <= 100);

  function play() {
    const blocked = stakeBlockedMsg();
    if (blocked) {
      dispatch({ type: 'TOAST', message: blocked });
      return;
    }
    onPlay(stakeCents);
  }

  function createTable() {
    const blocked = stakeBlockedMsg();
    if (blocked) {
      dispatch({ type: 'TOAST', message: blocked });
      return;
    }
    onCreateTable(stakeCents);
  }

  // 4-player table at the selected stake — but only cUSD-staked once LudoEscrowN
  // is deployed; until then it stays free (no wallet prompt, no dead option).
  const stake4 = staked4Available ? stakeCents : 0;
  function play4() {
    if (stake4 > 0) {
      const blocked = stakeBlockedMsg();
      if (blocked) {
        dispatch({ type: 'TOAST', message: blocked });
        return;
      }
    }
    onPlay4(stake4);
  }

  const inLeague = league.rank > 0 || league.points > 0;

  return (
    <div className="screen screen--lobby">
      <TopBar />

      {stakingBlocked && <div className="reconnectbar">🌍 {t('geoBlocked')}</div>}

      {/* stake picker + CTA first: the primary action stays above the fold */}
      <div className="hero">
        <div className="hero__kicker">{t('chooseStake')}</div>
        <div className="gstakes">
          {lobbyStakes.map((s) => (
            <button
              key={s}
              className={`gstake${s === stakeCents ? ' gstake--sel' : ''}${s === 0 ? ' gstake--free' : ''}`}
              onClick={() => dispatch({ type: 'SELECT_STAKE', stake: s })}
            >
              <b>{s === 0 ? t('free') : s >= 100 ? `$${s / 100}` : `${s}¢`}</b>
              <small>{s === 0 ? t('training') : `${t('win')} ${fmtUsd(potCents(s))}`}</small>
            </button>
          ))}
        </div>
      </div>

      <button className="btn btn--hero" onClick={play}>
        {t('play')}
        <small>
          {stakeCents === 0
            ? `${t('free')} · ${t('training')}`
            : `${fmtUsd(stakeCents)} → ${t('win')} ${fmtUsd(potCents(stakeCents))}`}
        </small>
      </button>

      <div style={{ height: 14 }} />

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
        <div className="mini mini--action" onClick={play4}>
          <b>
            <IconUsers className="icon--gold" /> {t('fourPlayer')}
            <span className="mini__badge">{stake4 === 0 ? t('free') : fmtUsd(stake4)}</span>
          </b>
          {stake4 === 0 ? t('fourPlayerDesc') : `${t('win')} ${fmtUsd(potCents4(stake4))}`}
        </div>
        <div className="mini mini--action" onClick={createTable}>
          <b>
            <IconUsers className="icon--me" /> {t('privateTable')}
          </b>
          {t('privateTableDesc')}
        </div>
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
              <li key={i}>
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
    </div>
  );
}
