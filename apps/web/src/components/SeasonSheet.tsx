/** Season pass track — the crowns progression sheet (Phase 1 MVP: free track).
 *  Shows crowns → tiers, what each tier grants on the free/premium lanes, and lets
 *  the player claim a reached free reward. The premium lane is visible but locked
 *  until the pass ships (Phase 2). */
import { useFocusTrap } from './useFocusTrap';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { crownsForTier, SEASON_PREMIUM, type Reward, type TierDef } from '@ludo/shared';
import { cosmeticsCusdAvailable } from '../lib/deployments';
import { t } from '../lib/i18n';

function rewardLabel(r: Reward): string {
  switch (r.kind) {
    case 'tickets':
      return `${r.amount ?? 0} 🎟️`;
    case 'cosmetic':
      return `🎨 ${t('seasonRewardSkin')}`;
    case 'streakFreeze':
      return `❄️ ${t('seasonRewardFreeze')}`;
    case 'crownBoost':
      return `👑 +${r.amount ?? 0}%`;
    case 'title':
      return `🏅 ${t('seasonRewardTitle')}`;
    default:
      return '';
  }
}

function daysLeft(endsAt: string): number {
  const ms = new Date(endsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

export function SeasonSheet({ onClaim, onBuyPremium }: { onClaim(tier: number, lane: 'free' | 'premium'): void; onBuyPremium(): void }) {
  const { seasonOpen, season } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'SEASON_MODAL', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(seasonOpen, close);
  if (!seasonOpen || !season) return null;

  const reached = season.tier;
  const maxed = reached >= season.tierCount;
  const prevCost = crownsForTier(reached);
  const nextCost = crownsForTier(Math.min(reached + 1, season.tierCount));
  const span = Math.max(1, nextCost - prevCost);
  const pct = maxed ? 100 : Math.min(100, Math.round(((season.crowns - prevCost) / span) * 100));

  const claimedFree = new Set(season.claimedFree);
  const claimedPrem = new Set(season.claimedPrem);

  return (
    <div className="modal" onClick={close}>
      <div className="modal__card seasonsheet" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>👑 {t('seasonTitle')}</h3>
        <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          {t('seasonIntro')} · {t('seasonEndsIn').replace('{d}', String(daysLeft(season.endsAt)))}
        </p>

        {/* Crowns → next tier */}
        <div className="seasonbar">
          <div className="seasonbar__head">
            <b>{t('seasonTier')} {reached}/{season.tierCount}</b>
            <span>👑 {season.crowns}{maxed ? '' : ` / ${nextCost}`}</span>
          </div>
          <div className="seasonbar__track"><span className="seasonbar__fill" style={{ width: `${pct}%` }} /></div>
        </div>

        {/* Premium pass: a $1.50 USDT unlock of the premium lane + retroactive
            grants. Hidden once owned; shown only when the USDT rail is live. */}
        {!season.premium && cosmeticsCusdAvailable && (
          <button className="seasonpremium" onClick={onBuyPremium}>
            <div className="seasonpremium__txt">
              <b>👑 {t('seasonPremiumTitle')}</b>
              <small>{t('seasonPremiumBlurb')}</small>
            </div>
            <span className="seasonpremium__cta">{fmtUsd(SEASON_PREMIUM.cents)}</span>
          </button>
        )}
        {season.premium && (
          <div className="seasonpremium seasonpremium--owned">
            <b>👑 {t('seasonPremiumOwned')}</b>
          </div>
        )}

        <div className="seasontiers">
          {season.tiers.map((def: TierDef) => {
            const unlocked = reached >= def.tier;
            const freeClaimable = unlocked && !claimedFree.has(def.tier);
            const premClaimed = claimedPrem.has(def.tier);
            // Premium lane is claimable only once the pass is owned (Phase 2); until
            // then it's a visible "🔒 Premium" teaser of what the pass unlocks.
            const premClaimable = season.premium && unlocked && !premClaimed;
            return (
              <div key={def.tier} className={`seasontier${unlocked ? ' seasontier--on' : ''}`}>
                <span className="seasontier__n">{def.tier}</span>
                <div className="seasontier__lanes">
                  {/* Free lane */}
                  <button
                    className={`seasonreward${freeClaimable ? ' seasonreward--claim' : ''}${claimedFree.has(def.tier) ? ' seasonreward--done' : ''}`}
                    disabled={!freeClaimable}
                    onClick={freeClaimable ? () => onClaim(def.tier, 'free') : undefined}
                  >
                    <span>{rewardLabel(def.free)}</span>
                    <small>{claimedFree.has(def.tier) ? `✓ ${t('seasonClaimedShort')}` : freeClaimable ? t('seasonClaim') : t('seasonFree')}</small>
                  </button>
                  {/* Premium lane */}
                  <button
                    className={`seasonreward seasonreward--prem${premClaimable ? ' seasonreward--claim' : ''}${premClaimed ? ' seasonreward--done' : ''}`}
                    disabled={!premClaimable}
                    onClick={premClaimable ? () => onClaim(def.tier, 'premium') : undefined}
                  >
                    <span>{rewardLabel(def.premium)}</span>
                    <small>{premClaimed ? `✓ ${t('seasonClaimedShort')}` : premClaimable ? t('seasonClaim') : `🔒 ${t('seasonPremium')}`}</small>
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <button className="btn btn--ghost" style={{ marginTop: 12 }} onClick={close}>{t('close')}</button>
      </div>
    </div>
  );
}
