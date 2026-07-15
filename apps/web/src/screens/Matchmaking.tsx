import { useAppDispatch, useAppState } from '../state/store';
import { IconUsers } from '../components/icons';
import { t } from '../lib/i18n';

export function Matchmaking({ onCancel, onPlayBot }: { onCancel(): void; onPlayBot?(): void }) {
  const { match, privateCode, botMode } = useAppState();
  const dispatch = useAppDispatch();

  const link = privateCode ? `${window.location.origin}${window.location.pathname}#/g/${privateCode}` : '';
  const shareUrl = `https://wa.me/?text=${encodeURIComponent(`${t('shareMsg')} ${link}`)}`;

  function copyLink() {
    navigator.clipboard?.writeText(link).then(
      () => dispatch({ type: 'TOAST', message: t('linkCopied') }),
      () => undefined,
    );
  }

  return (
    <div className="screen">
      <div className="center">
        {privateCode && !match ? (
          <div className="tablecard">
            <div className="radar radar--sm" aria-hidden="true">
              <i />
              <i />
              <i />
              <div className="radar__core">
                <IconUsers />
              </div>
            </div>
            <div className="muted">{t('tableWaiting')}</div>
            <div className="tablecode">{privateCode}</div>
            <a className="btn" href={shareUrl} target="_blank" rel="noreferrer">
              {t('shareWhatsapp')}
            </a>
            <button className="btn btn--ghost" onClick={copyLink}>
              {t('copyLink')}
            </button>
          </div>
        ) : !match ? (
          <div className="radar" aria-hidden="true">
            <i />
            <i />
            <i />
            <div className="radar__core">
              <IconUsers />
            </div>
          </div>
        ) : null}
        {!privateCode && <div>{match ? t('found') : botMode ? t('preparingPractice') : t('searching')}</div>}
        {match && (
          <>
            <div className="vs">
              <div>
                <div className="avatar avatar--me" />
                <div style={{ marginTop: 6 }}>{t('you')}</div>
              </div>
              <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--accent)' }}>VS</div>
              <div>
                <div className="avatar avatar--opp">{match.opponent.flag}</div>
                <div style={{ marginTop: 6 }}>
                  {match.opponent.name}
                  <br />
                  <small className="muted">ELO {match.opponent.elo}</small>
                </div>
              </div>
            </div>
            {match.stakeCents > 0 && <small className="muted">{t('escrow')}</small>}
          </>
        )}
        {!match && (
          <>
            {/* Free 1v1: don't force a wait — an impatient player can drop the
                queue and play a bot right away (a real human still pairs first). */}
            {onPlayBot && !privateCode && !botMode && (
              <button className="btn mm-bot" onClick={onPlayBot}>
                {t('playBot')}
              </button>
            )}
            <button className="btn btn--ghost mm-cancel" onClick={onCancel}>
              {t('cancel')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
