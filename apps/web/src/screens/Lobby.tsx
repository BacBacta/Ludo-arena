import { ALLOWED_STAKES_CENTS, DIVISIONS, potCents, type StakeCents } from '@ludo/shared';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { TopBar } from '../components/ui';
import { IconFlame, IconTarget, IconTicket, IconTrophy, IconUsers } from '../components/icons';
import { t } from '../lib/i18n';

/** Casino-chip colourways per stake. */
const CHIP_STYLE: Record<number, { c1: string; c2: string; text: string }> = {
  0: { c1: '#3fc487', c2: '#1d7c50', text: '#ffffff' },
  10: { c1: '#f2ead6', c2: '#c9bfa2', text: '#24312a' },
  25: { c1: '#ffd94d', c2: '#dd9d00', text: '#24312a' },
  50: { c1: '#f4a05c', c2: '#c96a22', text: '#ffffff' },
  100: { c1: '#3a4a42', c2: '#20302a', text: '#ffd94d' },
};

function ChipSVG({ stake }: { stake: number }) {
  const s = CHIP_STYLE[stake] ?? CHIP_STYLE[25]!;
  const gid = `chip${stake}`;
  return (
    <svg viewBox="0 0 72 72" className="chip">
      <defs>
        <radialGradient id={gid} cx="35%" cy="30%" r="90%">
          <stop offset="0%" stopColor={s.c1} />
          <stop offset="100%" stopColor={s.c2} />
        </radialGradient>
      </defs>
      <circle cx={36} cy={38.5} r={32} fill="rgba(0,0,0,.35)" />
      <circle cx={36} cy={36} r={32} fill={`url(#${gid})`} />
      <circle cx={36} cy={36} r={32} fill="none" stroke="rgba(255,255,255,.85)" strokeWidth={5} strokeDasharray="7.5 9.25" />
      <circle cx={36} cy={36} r={23} fill="rgba(255,255,255,.13)" />
      <circle cx={36} cy={36} r={23} fill="none" stroke="rgba(0,0,0,.2)" strokeWidth={1} />
      <text
        x={36}
        y={stake === 0 ? 41 : 41.5}
        textAnchor="middle"
        fontSize={stake === 0 ? 15 : 17}
        fontWeight={700}
        fontFamily="'Space Grotesk', system-ui, sans-serif"
        fill={s.text}
      >
        {stake === 0 ? t('free') : stake >= 100 ? `$${stake / 100}` : `${stake}¢`}
      </text>
    </svg>
  );
}

export function Lobby({
  onPlay,
  onCreateTable,
}: {
  onPlay(stake: StakeCents): void;
  onCreateTable(stake: StakeCents): void;
}) {
  const { stakeCents, streak, challenge, league, tickets, cashbackCents, limits, stakingBlocked, balanceCents } = useAppState();
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

  const inLeague = league.rank > 0 || league.points > 0;

  return (
    <div className="screen screen--lobby">
      <TopBar />

      {stakingBlocked && <div className="reconnectbar">🌍 {t('geoBlocked')}</div>}

      {/* stake picker + CTA first: the primary action stays above the fold */}
      <div className="hero">
        <div className="hero__kicker">{t('chooseStake')}</div>
        <div className="chips">
          {lobbyStakes.map((s) => (
            <button
              key={s}
              className={`chipbtn${s === stakeCents ? ' chipbtn--sel' : ''}`}
              onClick={() => dispatch({ type: 'SELECT_STAKE', stake: s })}
            >
              <ChipSVG stake={s} />
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

      {cashbackCents > 0 && (
        <div className="cashback">
          💛 {t('cashbackHeld')} <b>{fmtUsd(cashbackCents)}</b>
        </div>
      )}

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
        <div className="mini mini--soon">
          <b>
            <IconTrophy className="icon--gold" /> {t('freeroll')}
          </b>
          {t('freerollDesc')}
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
