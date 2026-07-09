/** Small cross-cutting UI components: TopBar, Toast, FairnessModal. */
import { useEffect } from 'react';
import { fmtCents, useAppDispatch, useAppState } from '../state/store';
import { t } from '../lib/i18n';

export function TopBar() {
  const { balanceCents } = useAppState();
  return (
    <div className="topbar">
      <div className="topbar__logo">
        LUDO <span>ARENA</span>
      </div>
      <div className="topbar__balance">
        <span className="topbar__dot" />
        {fmtCents(balanceCents)} cUSD
      </div>
    </div>
  );
}

export function Toast() {
  const { toast } = useAppState();
  const dispatch = useAppDispatch();
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => dispatch({ type: 'CLEAR_TOAST' }), 2400);
    return () => clearTimeout(id);
  }, [toast, dispatch]);
  if (!toast) return null;
  return <div className="toast">{toast}</div>;
}

export function FairnessModal() {
  const { fairModalOpen, match, result } = useAppState();
  const dispatch = useAppDispatch();
  if (!fairModalOpen) return null;
  return (
    <div className="modal" onClick={() => dispatch({ type: 'FAIR_MODAL', open: false })}>
      <div className="modal__card">
        <h3>{t('fairTitle')}</h3>
        {t('fairBody1')}
        <div className="hash">
          {t('commitLabel')} {match?.fairnessCommit ?? '—'}
        </div>
        {t('fairBody2')}
        {result?.fairnessReveal && (
          <div className="hash">
            {t('seedLabel')} {result.fairnessReveal.serverSeed}
          </div>
        )}
        {t('fairBody3')}
        <div style={{ marginTop: 10, textAlign: 'center' }} className="muted">
          {t('closeHint')}
        </div>
      </div>
    </div>
  );
}
