/**
 * Progression sheet — the secondary "your activity" view, opened from the top bar.
 * Holds the daily loop (streak · challenge · tickets + streak-freeze) and Rivals,
 * so the landing can stay focused on the two essentials (Play + Season Pass).
 */
import { useFocusTrap } from './useFocusTrap';
import { useAppDispatch, useAppState, RIVAL_GAMES } from '../state/store';
import { STREAK_FREEZE } from '@ludo/shared';
import { IconFlame, IconTarget, IconTicket } from './icons';
import { frameClass } from '../lib/avatarFrames';
import { playTap } from '../lib/sound';
import { t } from '../lib/i18n';

export function ProgressionSheet({ onViewProfile, onBuyFreeze }: { onViewProfile(pid: string): void; onBuyFreeze(): void }) {
  const { progressionOpen, streak, challenge, tickets, walletBacked, recentOpponents } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'PROGRESSION_MODAL', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(progressionOpen, close);
  if (!progressionOpen) return null;
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card progressionsheet" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{t('progressionTitle')}</h3>

        {/* Daily loop */}
        <div className="seclabel">{t('today')}</div>
        <div className="card daily">
          <div className="dstat">
            <span className="dstat__ic dstat__ic--fire"><IconFlame /></span>
            <b>{streak.days}</b>
            <small>{t('streakLabel')}</small>
          </div>
          <div className="dstat">
            <span className="dstat__ic dstat__ic--target"><IconTarget /></span>
            <b>{challenge.progress}/{challenge.target}</b>
            <small>{t('challengeLabel')}</small>
          </div>
          <div className="dstat">
            <span className="dstat__ic dstat__ic--ticket"><IconTicket /></span>
            <b>{tickets}</b>
            <small>{t('ticketsLabel')}</small>
          </div>
        </div>
        <div className="daily__foot">
          <small className="daily__hint">
            {challenge.completed ? t('challengeDone') : `${t('challengeDesc')} ${t('challengeReward')}`}
          </small>
          {walletBacked && (
            <button
              className="freezechip"
              title={t('freezeDesc')}
              onClick={() => {
                playTap();
                if ((streak.freezes ?? 0) >= STREAK_FREEZE.max) dispatch({ type: 'TOAST', message: t('freezeCapped') });
                else if (tickets < STREAK_FREEZE.ticketCost) dispatch({ type: 'TOAST', message: t('freezeCantBuy') });
                else onBuyFreeze();
              }}
            >
              ❄️ {t('freezeTitle')} {streak.freezes ?? 0}/{STREAK_FREEZE.max}
              <span className="freezechip__buy">+{STREAK_FREEZE.ticketCost}🎟️</span>
            </button>
          )}
        </div>

        {/* Rivals */}
        {recentOpponents.length > 0 && (
          <>
            <div className="seclabel">{t('rivalsTitle')}</div>
            <div className="card rivalscard">
              <div className="rivalrow">
                {recentOpponents.map((o, i) => {
                  const rival = o.wins + o.losses >= RIVAL_GAMES;
                  return (
                    <button
                      key={o.pid ?? i}
                      className={`rival${rival ? ' rival--rival' : ''}`}
                      disabled={!o.pid}
                      onClick={() => o.pid && onViewProfile(o.pid)}
                    >
                      <span className={`rival__av ${frameClass(o.frame)}`} aria-hidden="true">{o.flag}</span>
                      <b className="rival__name">{o.name}</b>
                      <small className="rival__wl">
                        <span className="profilecard__w">{o.wins}</span>–<span className="profilecard__l">{o.losses}</span>
                      </small>
                      {rival && <span className="rival__badge" aria-label={t('rivalBadge')}>⚔️</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {recentOpponents.length === 0 && streak.days === 0 && (
          <p className="muted" style={{ fontSize: 12.5, textAlign: 'center', marginTop: 4 }}>{t('progressionEmpty')}</p>
        )}

        <button className="btn btn--ghost" style={{ marginTop: 12 }} onClick={close}>{t('close')}</button>
      </div>
    </div>
  );
}
