import { fmtCents, useAppDispatch, useAppState } from '../state/store';
import { t } from '../lib/i18n';

export function EndScreen({ onRematch }: { onRematch(): void }) {
  const { result, match } = useAppState();
  const dispatch = useAppDispatch();
  if (!result || !match) return null;

  const won = result.winner === match.seat;
  const staked = match.stakeCents > 0;

  return (
    <div className="screen">
      <div className="center">
        <div className="end__emoji">{won ? '🏆' : '😔'}</div>
        <div className="end__title">{won ? t('victory') : t('defeat')}</div>
        <div className="end__amount">
          {staked
            ? won
              ? `+${fmtCents(result.payoutCents)} $`
              : `−${fmtCents(match.stakeCents)} $`
            : won
              ? '+50 XP'
              : '+20 XP'}
        </div>
        <div className="paynote">
          {!staked ? (
            t('trainingGame')
          ) : won ? (
            <>
              <b>{t('paidInstant')}</b> {t('onWallet')} · {t('rakeIncluded')} (
              {fmtCents(result.rakeCents)} $)
            </>
          ) : (
            t('lossSafety')
          )}
        </div>
        <small className="muted">
          ELO {won ? `+${result.eloDelta}` : result.eloDelta} · {t('league')}
        </small>
        <div style={{ width: '100%', maxWidth: 300 }}>
          <button className="btn" onClick={onRematch}>
            {t('rematch')}
          </button>
          <div style={{ height: 10 }} />
          <div className="row">
            <button className="btn btn--ghost" onClick={() => dispatch({ type: 'GO_LOBBY' })}>
              {t('home')}
            </button>
            <button
              className="btn btn--ghost"
              onClick={() => dispatch({ type: 'TOAST', message: t('linkCopied') })}
            >
              {t('challengeFriend')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
