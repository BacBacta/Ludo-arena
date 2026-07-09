import { useAppState } from '../state/store';
import { t } from '../lib/i18n';

export function Matchmaking() {
  const { match } = useAppState();
  return (
    <div className="screen">
      <div className="center">
        <div className="spinner" />
        <div>{match ? t('found') : t('searching')}</div>
        {match && (
          <>
            <div className="vs">
              <div>
                <div className="avatar avatar--me">🟢</div>
                <div style={{ marginTop: 6 }}>
                  {t('you')}
                  <br />
                  <small className="muted">ELO 1240</small>
                </div>
              </div>
              <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--accent)' }}>VS</div>
              <div>
                <div className="avatar avatar--opp">🟠</div>
                <div style={{ marginTop: 6 }}>
                  {match.opponent.name} {match.opponent.flag}
                  <br />
                  <small className="muted">ELO {match.opponent.elo}</small>
                </div>
              </div>
            </div>
            {match.stakeCents > 0 && <small className="muted">{t('escrow')}</small>}
          </>
        )}
      </div>
    </div>
  );
}
