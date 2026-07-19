import { useEffect, useMemo, useState } from 'react';
import { DIVISIONS } from '@ludo/shared';
import { fmtUsd, useAppState } from '../state/store';
import { activeChain } from '../lib/chains';
import { VictoryFxOverlay } from '../components/CosmeticFx';
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

export function EndScreen({ onRematch, onDecline, onAddFriend }: { onRematch(): void; onDecline(): void; onAddFriend(pid: string): Promise<boolean> }) {
  const { result, match, settleTxHash, refunded, league, walletBacked, profile, rematchOffer, crownGain, friends, friendRequests, victoryFx } = useAppState();
  // Friend request state for THIS opponent: idle → sent (one-way latch; the
  // reciprocal add finalizing to 'friends' shows on the lobby friends card).
  const [friendSent, setFriendSent] = useState(false);
  const opponentPid = match?.opponent.pid;
  const alreadyFriend = !!opponentPid && friends.some((f) => f.pid === opponentPid);
  // The opponent ➕'d ME during this game (their request arrived live): the
  // button flips to an ACCEPT — both players can seal the friendship without
  // ever leaving the end screen, so no request is missed in the moment.
  const incomingFromOpponent = !!opponentPid && friendRequests.some((r) => r.pid === opponentPid);

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
      {/* the WINNER's equipped victory effect — both players watch it */}
      <VictoryFxOverlay key={match.gameId} fxId={won ? victoryFx : match.opponent.victoryFx} />
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
        {crownGain && crownGain.gained > 0 && (
          <div className="crowngain" key={crownGain.n} role="status">
            +{crownGain.gained} 👑 · {t('seasonTier')} {crownGain.tier}
          </div>
        )}
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
          {/* If the opponent asked for a rematch, say so — the button becomes an
              explicit ACCEPT, and Home doubles as Decline (tells them we left). */}
          {rematchOffer && (
            <div className="rematchoffer" role="status">
              🔄 {rematchOffer} {t('wantsRematch')}
            </div>
          )}
          {/* Befriend the opponent at the peak-emotion moment (E-social 2):
              only for real humans with a durable identity (pid present) and a
              wallet on my side; hidden once we're already friends. */}
          {opponentPid && walletBacked && !alreadyFriend && (
            <button
              className={`btn endfriend${incomingFromOpponent ? '' : ' btn--ghost'}`}
              disabled={friendSent}
              onClick={() => {
                setFriendSent(true);
                void onAddFriend(opponentPid).then((ok) => { if (!ok) setFriendSent(false); });
              }}
            >
              {friendSent
                ? `✓ ${t('friendRequestSent')}`
                : incomingFromOpponent
                  ? `✓ ${t('friendAccept')} — ${match.opponent.name}`
                  : `➕ ${t('addFriend')} ${match.opponent.name}`}
            </button>
          )}
          <button className="btn" onClick={onRematch}>
            {rematchOffer ? t('acceptRematch') : t('rematch')}
          </button>
          <div style={{ height: 10 }} />
          <div className="row">
            <button className="btn btn--ghost" onClick={onDecline}>
              {rematchOffer ? t('declineRematch') : t('home')}
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
