/** Petits composants UI transverses : TopBar, Toast, FairnessModal. */
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
        Avant la partie, le serveur publie l’empreinte de sa graine secrète :
        <div className="hash">commit : {match?.fairnessCommit ?? '—'}</div>
        Chaque dé = f(graine serveur, entropie des 2 joueurs, n° du lancer). En fin de partie la
        graine est révélée : tu peux recalculer chaque lancer.
        {result?.fairnessReveal && (
          <div className="hash">seed révélé : {result.fairnessReveal.serverSeed}</div>
        )}
        Les mises sont bloquées dans un smart contract escrow sur Celo — l’app ne détient jamais
        ton argent.
        <div style={{ marginTop: 10, textAlign: 'center' }} className="muted">
          (toucher pour fermer)
        </div>
      </div>
    </div>
  );
}
