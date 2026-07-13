import { useEffect, useMemo, useState } from 'react';
import { DIVISIONS } from '@ludo/shared';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { activeChain } from '../lib/chains';
import { playPayout, playLose } from '../lib/sound';
import { t } from '../lib/i18n';

/** Eased 0→target counter for the payout reveal. */
function useCountUp(target: number, duration = 900): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / duration);
      setV(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return v;
}

/** Lightweight CSS confetti (win only) — no canvas, ~26 falling pieces. */
function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 26 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.5,
        dur: 1.5 + Math.random() * 0.9,
        color: ['#f5b301', '#2e9e6b', '#e8833a', '#eaf2ee'][i % 4]!,
        rot: Math.floor(Math.random() * 360),
        w: 6 + Math.random() * 6,
      })),
    [],
  );
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          key={i}
          style={{
            left: `${p.left}%`,
            background: p.color,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
            width: p.w,
            height: p.w * 0.45,
            transform: `rotate(${p.rot}deg)`,
          }}
        />
      ))}
    </div>
  );
}

/** Ranking ceremony: the ELO change counts up with a coloured arrow, and the
 *  resulting rating slides in — the moment that makes a ladder feel like one. */
function EloReveal({ delta, rating }: { delta: number; rating: number }) {
  const up = delta >= 0;
  const mag = useCountUp(Math.abs(delta), 1100);
  return (
    <div className={`eloreveal ${up ? 'eloreveal--up' : 'eloreveal--down'}`} role="status">
      <span className="eloreveal__delta">
        <span className="eloreveal__arrow" aria-hidden="true">{up ? '▲' : '▼'}</span>
        {up ? '+' : '−'}{mag}
      </span>
      <span className="eloreveal__rating">{rating} <small>ELO</small></span>
    </div>
  );
}

export function EndScreen({ onRematch }: { onRematch(): void }) {
  const { result, match, settleTxHash, refunded, league, walletBacked, profile } = useAppState();
  const dispatch = useAppDispatch();

  const won = !!result && !!match && result.winner === match.seat;
  const staked = !!match && match.stakeCents > 0;
  const targetCents = !result || !match ? 0 : staked ? (won ? result.payoutCents : match.stakeCents) : won ? 50 : 20;
  const counted = useCountUp(targetCents);

  // The money moment finally has audio: a coin cascade under the payout count-up
  // for a real win; a soft commiseration cue on a loss. Fires once per result.
  useEffect(() => {
    if (!result || !match) return;
    if (won && staked && result.payoutCents > 0) playPayout(11);
    else if (!won) playLose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.winner]);

  if (!result || !match) return null;

  const explorer = activeChain.blockExplorers?.default.url;
  const txLink = settleTxHash && explorer ? `${explorer}/tx/${settleTxHash}` : null;

  const shareText =
    won && staked
      ? `${t('shareWinMsg')} ${fmtUsd(result.payoutCents)} ⚡`
      : t('shareMsg');
  const shareUrl = `https://wa.me/?text=${encodeURIComponent(`${shareText} ${window.location.origin}`)}`;

  // Native share sheet (mobile / MiniPay) when available; WhatsApp link otherwise.
  // Must run in the click gesture, so it's a button handler, not an href.
  function shareResult(): void {
    const url = window.location.origin;
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    if (nav?.share) void nav.share({ title: 'Ludo Arena', text: shareText, url }).catch(() => {});
    else window.open(shareUrl, '_blank', 'noopener');
  }

  const amount = staked ? (won ? `+${fmtUsd(counted)}` : `−${fmtUsd(counted)}`) : `+${counted} XP`;

  return (
    <div className="screen screen--end">
      {won && <Confetti />}
      <div className="center">
        <div className="end__emoji">{won ? '🏆' : '😔'}</div>
        <div className="end__title">{won ? t('victory') : t('defeat')}</div>
        <div className="end__amount">{amount}</div>
        <div className="paynote">
          {!staked ? (
            t('trainingGame')
          ) : won ? (
            walletBacked ? (
              <>
                <b>{t('paidInstant')}</b> {t('onWallet')} · {t('rakeIncluded')} ({fmtUsd(result.rakeCents)})
              </>
            ) : (
              t('demoPayout')
            )
          ) : (
            t('lossSafety')
          )}
        </div>
        <EloReveal delta={result.eloDelta} rating={profile.elo} />
        <small className="muted">{DIVISIONS[league.division] ?? ''} {t('league')}</small>
        {refunded ? (
          <small className="muted">
            {t('refundedNote')}
            {txLink && (
              <>
                {' · '}
                <a href={txLink} target="_blank" rel="noreferrer">
                  {t('viewTx')} ↗
                </a>
              </>
            )}
          </small>
        ) : (
          staked &&
          won &&
          settleTxHash && (
            <small className="muted">
              {txLink ? (
                <a href={txLink} target="_blank" rel="noreferrer">
                  {t('viewPayout')} ↗
                </a>
              ) : (
                t('settled')
              )}
            </small>
          )
        )}
        <div style={{ width: '100%', maxWidth: 300 }}>
          <button className="btn" onClick={onRematch}>
            {t('rematch')}
          </button>
          <div style={{ height: 10 }} />
          <div className="row">
            <button className="btn btn--ghost" onClick={() => dispatch({ type: 'GO_LOBBY' })}>
              {t('home')}
            </button>
            <button className="btn btn--ghost" style={{ textAlign: 'center' }} onClick={shareResult}>
              {t('challengeFriend')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
