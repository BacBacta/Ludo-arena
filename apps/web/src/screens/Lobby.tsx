import { ALLOWED_STAKES_CENTS, DIVISIONS, potCents, type StakeCents } from '@ludo/shared';
import { fmtCents, useAppDispatch, useAppState } from '../state/store';
import { TopBar } from '../components/ui';
import { t } from '../lib/i18n';

export function Lobby({
  onPlay,
  onCreateTable,
}: {
  onPlay(stake: StakeCents): void;
  onCreateTable(stake: StakeCents): void;
}) {
  const { stakeCents, streak, challenge, league, tickets, cashbackCents, limits, balanceCents } = useAppState();
  const dispatch = useAppDispatch();

  /** Responsible-gaming gate (E5.2), also enforced server-side. */
  function stakeBlockedMsg(): string | null {
    if (stakeCents === 0) return null;
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

  return (
    <div className="screen">
      <TopBar />

      <div className="streak">
        <div className="streak__fire">🔥</div>
        <div>
          <b>
            {t('dailyStreak')} {streak.days} {t('days')}
          </b>
          <small>{t('streakHint')}</small>
        </div>
        {tickets > 0 && (
          <div style={{ marginLeft: 'auto', fontWeight: 700 }}>
            🎟️ {tickets}
          </div>
        )}
      </div>

      <div className="card">
        <h3>{t('chooseStake')}</h3>
        <div className="stakes">
          {lobbyStakes.map((s) => (
            <div
              key={s}
              className={`stake${s === stakeCents ? ' stake--sel' : ''}${s === 0 ? ' stake--free' : ''}`}
              onClick={() => dispatch({ type: 'SELECT_STAKE', stake: s })}
            >
              <b>{s === 0 ? t('free') : `${fmtCents(s)}$`}</b>
              <small>{s === 0 ? t('training') : `${t('win')} ${fmtCents(potCents(s))}$`}</small>
            </div>
          ))}
        </div>
      </div>

      <button className="btn" onClick={play}>
        {t('play')}
      </button>

      {cashbackCents > 0 && (
        <div className="cashback">
          💛 {t('cashbackHeld')} <b>{fmtCents(cashbackCents)} $</b>
        </div>
      )}

      <div style={{ height: 14 }} />

      <div className="minis">
        <div className="mini">
          <b>{t('freeroll')}</b>
          {t('freerollDesc')}
        </div>
        <div className="mini mini--action" onClick={createTable}>
          <b>{t('privateTable')}</b>
          {t('privateTableDesc')}
        </div>
      </div>

      <div className="card">
        <h3>
          🏆 {DIVISIONS[league.division] ?? '—'} {t('league')}
          <span style={{ float: 'right', color: 'var(--accent)' }}>
            {league.rank > 0 ? `#${league.rank}` : '—'} · {league.points} {t('lp')}
          </span>
        </h3>
        {league.top.length > 0 && (
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
        )}
        <small className="muted">{t('leagueHint')}</small>
      </div>

      <div style={{ height: 14 }} />

      <div className="card" style={{ marginBottom: 0 }}>
        <h3>{t('dailyChallenge')}</h3>
        <div style={{ fontSize: 13 }} className="muted">
          {challenge.completed ? (
            <b style={{ color: 'var(--accent)' }}>{t('challengeDone')}</b>
          ) : (
            <>
              {t('challengeDesc')} <b style={{ color: 'var(--accent)' }}>{t('challengeReward')}</b>
            </>
          )}
          <span style={{ float: 'right' }}>
            {challenge.progress}/{challenge.target}
          </span>
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
