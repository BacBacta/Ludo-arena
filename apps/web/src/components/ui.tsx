/** Small cross-cutting UI components: TopBar, Toast, FairnessModal. */
import { useEffect, useState } from 'react';
import { fmtCents, fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { verifyFairness, type FairnessReport } from '../lib/fairnessVerify';
import { IconSoundOff, IconSoundOn } from './icons';
import { t } from '../lib/i18n';

export function TopBar() {
  const { balanceCents, walletBacked, soundOn } = useAppState();
  const dispatch = useAppDispatch();
  return (
    <div className="topbar">
      <div className="topbar__logo">
        <i className="logomark" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <rect x={3} y={3} width={18} height={18} rx={5.5} fill="#0c130f" />
            <circle cx={8.4} cy={8.4} r={1.8} fill="#f5b301" />
            <circle cx={12} cy={12} r={1.8} fill="#f5b301" />
            <circle cx={15.6} cy={15.6} r={1.8} fill="#f5b301" />
          </svg>
        </i>
        LUDO <span>ARENA</span>
      </div>
      <div className="topbar__right">
        <button
          className="soundtoggle"
          title={soundOn ? t('soundOn') : t('soundOff')}
          onClick={() => dispatch({ type: 'TOGGLE_SOUND' })}
        >
          {soundOn ? <IconSoundOn /> : <IconSoundOff className="icon--muted" />}
        </button>
        <div className="topbar__balance">
          {/* gray dot + Demo label until a real wallet backs the balance */}
          <span className="topbar__dot" style={walletBacked ? undefined : { background: 'var(--muted)' }} />
          {!walletBacked && <span className="muted">{t('demo')} ·&nbsp;</span>}
          {fmtCents(balanceCents)} cUSD
        </div>
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

const LIMIT_OPTIONS = [25, 50, 100, 200];
const EXCLUDE_OPTIONS = [1, 7, 30];

export function SettingsModal({ onApply }: { onApply(payload: { dailyLimitCents?: number; selfExcludeDays?: number }): void }) {
  const { settingsOpen, limits } = useAppState();
  const dispatch = useAppDispatch();
  if (!settingsOpen) return null;
  const close = (): void => void dispatch({ type: 'SETTINGS', open: false });
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card" onClick={(e) => e.stopPropagation()}>
        <h3>{t('rgTitle')}</h3>
        <p className="muted" style={{ fontSize: 12 }}>
          {t('rgIntro')}
        </p>

        <div style={{ margin: '10px 0 4px', fontWeight: 700 }}>{t('rgDailyLimit')}</div>
        <div className="stakes">
          {LIMIT_OPTIONS.map((c) => (
            <div
              key={c}
              className={`stake${c === limits.dailyLimitCents ? ' stake--sel' : ''}`}
              onClick={() => onApply({ dailyLimitCents: c })}
            >
              <b>{fmtUsd(c)}</b>
            </div>
          ))}
        </div>
        <small className="muted">
          {t('rgStakedToday')} {fmtUsd(limits.stakedTodayCents)} / {fmtUsd(limits.dailyLimitCents)}
        </small>

        <div style={{ margin: '14px 0 4px', fontWeight: 700 }}>{t('rgSelfExclude')}</div>
        {limits.selfExcludedUntil ? (
          <div className="verify__bad">
            {t('rgExcludedUntil')} {limits.selfExcludedUntil}
          </div>
        ) : (
          <div className="row">
            {EXCLUDE_OPTIONS.map((d) => (
              <button key={d} className="btn btn--ghost" onClick={() => onApply({ selfExcludeDays: d })}>
                {d}
                {t('rgDays')}
              </button>
            ))}
          </div>
        )}
        <div style={{ marginTop: 12, textAlign: 'center' }} className="muted">
          {t('closeHint')}
        </div>
      </div>
    </div>
  );
}

export function WelcomeModal({ onStartFree }: { onStartFree(): void }) {
  const { onboardOpen } = useAppState();
  const dispatch = useAppDispatch();
  if (!onboardOpen) return null;
  return (
    <div className="modal" onClick={() => dispatch({ type: 'ONBOARD_DONE' })}>
      <div className="modal__card" style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
        <h3>{t('welcomeTitle')}</h3>
        <p style={{ fontSize: 14, margin: '8px 0 14px' }}>{t('welcomeBody')}</p>
        <button
          className="btn"
          onClick={() => {
            dispatch({ type: 'ONBOARD_DONE' });
            onStartFree();
          }}
        >
          {t('welcomeCta')}
        </button>
        <div style={{ marginTop: 10 }} className="muted">
          {t('closeHint')}
        </div>
      </div>
    </div>
  );
}

export function StakingOverlay() {
  const { staking, match } = useAppState();
  if (staking !== 'approving' && staking !== 'joining') return null;
  return (
    <div className="modal">
      <div className="modal__card" style={{ textAlign: 'center' }}>
        <div className="spinner" style={{ margin: '4px auto 12px' }} />
        <h3>{staking === 'approving' ? t('stakingApprove') : t('stakingJoin')}</h3>
        {match && (
          <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
            {fmtUsd(match.stakeCents)} · {t('stakingHint')}
          </div>
        )}
      </div>
    </div>
  );
}

export function FairnessModal() {
  const { fairModalOpen, match, result, diceHistory } = useAppState();
  const dispatch = useAppDispatch();
  const [report, setReport] = useState<FairnessReport | null>(null);

  const reveal = result?.fairnessReveal;
  const commit = match?.fairnessCommit;
  useEffect(() => {
    setReport(null);
    if (!fairModalOpen || !reveal || !commit) return;
    let live = true;
    void verifyFairness(commit, reveal, diceHistory).then((r) => {
      if (live) setReport(r);
    });
    return () => {
      live = false;
    };
  }, [fairModalOpen, reveal, commit, diceHistory]);

  if (!fairModalOpen) return null;
  return (
    <div className="modal" onClick={() => dispatch({ type: 'FAIR_MODAL', open: false })}>
      <div className="modal__card" onClick={(e) => e.stopPropagation()}>
        <h3>{t('fairTitle')}</h3>
        {t('fairBody1')}
        <div className="hash">
          {t('commitLabel')} {commit ?? '—'}
        </div>
        {t('fairBody2')}
        {reveal && (
          <div className="hash">
            {t('seedLabel')} {reveal.serverSeed}
          </div>
        )}

        {reveal && (
          <div className="verify">
            {!report ? (
              <div className="muted">{t('verifying')}</div>
            ) : (
              <>
                <div className={report.allOk ? 'verify__ok' : 'verify__bad'}>
                  {report.allOk ? t('verifyPass') : t('verifyFail')}
                </div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {t('commitLabel')} {report.commitOk ? '✓' : '✗'}
                </div>
                {report.rolls.length > 0 && (
                  <table className="verify__rolls">
                    <tbody>
                      {report.rolls.map((r) => (
                        <tr key={r.index}>
                          <td>#{r.index}</td>
                          <td>🎲 {r.played}</td>
                          <td>= {r.computed}</td>
                          <td>{r.ok ? '✓' : '✗'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
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
