import { ALLOWED_STAKES_CENTS, potCents, type StakeCents } from '@ludo/shared';
import { fmtCents, useAppDispatch, useAppState } from '../state/store';
import { TopBar } from '../components/ui';
import { t } from '../lib/i18n';

export function Lobby({ onPlay }: { onPlay(stake: StakeCents): void }) {
  const { stakeCents, streakDays, challengeProgress, balanceCents } = useAppState();
  const dispatch = useAppDispatch();

  const lobbyStakes = ALLOWED_STAKES_CENTS.filter((s) => s <= 100);

  function play() {
    if (stakeCents > 0 && balanceCents < stakeCents) {
      dispatch({ type: 'TOAST', message: t('insufficient') });
      return;
    }
    onPlay(stakeCents);
  }

  return (
    <div className="screen">
      <TopBar />

      <div className="streak">
        <div className="streak__fire">🔥</div>
        <div>
          <b>
            {t('dailyStreak')} {streakDays} {t('days')}
          </b>
          <small>{t('streakHint')}</small>
        </div>
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

      <div style={{ height: 14 }} />

      <div className="minis">
        <div className="mini">
          <b>{t('freeroll')}</b>Dotation 10 $ · gratuit · 18h00
        </div>
        <div className="mini">
          <b>{t('privateTable')}</b>Invite un ami par lien WhatsApp
        </div>
      </div>

      <div className="card" style={{ marginBottom: 0 }}>
        <h3>{t('dailyChallenge')}</h3>
        <div style={{ fontSize: 13 }} className="muted">
          Capture 3 pions → <b style={{ color: 'var(--accent)' }}>+1 ticket freeroll</b>
          <span style={{ float: 'right' }}>{challengeProgress}/3</span>
        </div>
      </div>

      <div className="fairnote">
        Dés vérifiables (provably fair) · gains payés instantanément ·{' '}
        <a onClick={() => dispatch({ type: 'FAIR_MODAL', open: true })}>comment ça marche ?</a>
      </div>
    </div>
  );
}
