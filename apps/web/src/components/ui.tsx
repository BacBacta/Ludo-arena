/** Small cross-cutting UI components: TopBar, Toast, FairnessModal. */
import { useEffect, useState } from 'react';
import { useFocusTrap } from './useFocusTrap';
import { fmtCents, fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { verifyFairness, type FairnessReport } from '../lib/fairnessVerify';
import { IconSoundOff, IconSoundOn } from './icons';
import { DieFace } from './Die';
import { DICE_SKINS, loadStats } from '../lib/diceSkins';
import { DIVISIONS, PREMIUM_SKINS, cosmeticCents, potCents4, ALLOWED_STAKES_CENTS } from '@ludo/shared';
import { cosmeticsCusdAvailable, staked4Available } from '../lib/deployments';
import { isMiniPay } from '../lib/minipay';
import { playTap } from '../lib/sound';
import { t } from '../lib/i18n';

export function TopBar({ onConnect }: { onConnect?: () => Promise<boolean> }) {
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
        {/* Cosmetics shop entry — accent-tinted + a sparkle so it reads as a SHOP,
            not a settings toggle (it used to reuse .soundtoggle and vanish). */}
        <button
          className="shopbtn"
          title={t('diceTitle')}
          aria-label={t('diceTitle')}
          onClick={() => dispatch({ type: 'DICE_MODAL', open: true })}
        >
          <svg viewBox="0 0 24 24" className="icon" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round">
            <rect x={3} y={3} width={18} height={18} rx={5} />
            <circle cx={8.5} cy={8.5} r={1.3} fill="currentColor" stroke="none" />
            <circle cx={15.5} cy={15.5} r={1.3} fill="currentColor" stroke="none" />
            <circle cx={12} cy={12} r={1.3} fill="currentColor" stroke="none" />
          </svg>
          <span className="shopbtn__spark" aria-hidden="true">✦</span>
        </button>
        <button
          className="soundtoggle"
          title={soundOn ? t('soundOn') : t('soundOff')}
          onClick={() => dispatch({ type: 'TOGGLE_SOUND' })}
        >
          {soundOn ? <IconSoundOn /> : <IconSoundOff className="icon--muted" />}
        </button>
        {walletBacked ? (
          <div className="topbar__balance">
            <span className="topbar__dot" />
            {fmtCents(balanceCents)} USDT
          </div>
        ) : isMiniPay() ? (
          // MiniPay requirement: never show a "Connect" button inside MiniPay —
          // the wallet is auto-connected on launch; show nothing until it lands.
          null
        ) : (
          // Regular browser: an honest connect CTA (no demo money to fake).
          <button className="topbar__balance topbar__connect" onClick={() => void onConnect?.()}>
            {t('connectWallet')}
          </button>
        )}
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
  return (
    <div className="toast" role="status" aria-live="polite">
      {toast}
    </div>
  );
}

const LIMIT_OPTIONS = [100, 200, 500];
const EXCLUDE_OPTIONS = [1, 7, 30];

export function SettingsModal({ onApply }: { onApply(payload: { dailyLimitCents?: number; selfExcludeDays?: number }): void }) {
  const { settingsOpen, limits } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'SETTINGS', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(settingsOpen, close);
  if (!settingsOpen) return null;
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
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

/**
 * Responsible-gaming reality check: a periodic reminder of time played + amount
 * staked today, with a one-tap cooling-off (self-exclude 1 day). Shown while a
 * session that has staked is active — a recognised RG safeguard.
 */
export function RealityCheckModal({ minutesPlayed, onBreak }: { minutesPlayed: number; onBreak(): void }) {
  const { realityOpen, limits } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'REALITY_CHECK', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(realityOpen, close);
  if (!realityOpen) return null;
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{t('realityTitle')}</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          {t('realityPlayed')} <b>{minutesPlayed} {t('realityMinutes')}</b>. {t('realityStaked')} <b>{fmtUsd(limits.stakedTodayCents)}</b>.
        </p>
        <p className="muted" style={{ fontSize: 12 }}>{t('realityPrompt')}</p>
        <button className="btn" onClick={close}>{t('realityKeep')}</button>
        <button
          className="btn btn--ghost"
          onClick={() => {
            onBreak();
            close();
          }}
        >
          {t('realityBreak')}
        </button>
      </div>
    </div>
  );
}

/** Dice-skin picker: progression unlocks + ticket buys, plus cUSD buys once the
 *  CosmeticsStore is deployed (cosmeticsCusdAvailable — dormant until then). */
export function DiceModal({ onBuy, onBuyCusd }: { onBuy(skinId: string): void; onBuyCusd(id: string): void }) {
  const { diceModalOpen, diceSkin, streak, tickets, league, ownedSkins } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'DICE_MODAL', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(diceModalOpen, close);
  if (!diceModalOpen) return null;
  const stats = loadStats();
  const ctx = { ...stats, streakDays: streak.days, tickets, division: league.division };
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{t('diceTitle')}</h3>
        <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          {t('diceIntro')}
        </p>
        <div className="skingrid">
          {DICE_SKINS.map((s) => {
            const price = PREMIUM_SKINS[s.id]; // premium skins are ticket-priced
            const owned = ownedSkins.includes(s.id);
            const unlocked = owned || (price === undefined && s.unlocked(ctx));
            const equipped = s.id === diceSkin;
            const canBuyTickets = price !== undefined && !owned;
            const ticketAffordable = canBuyTickets && tickets >= price;
            // cUSD buy is a fallback path, live only once the store is deployed.
            const cusd = cosmeticCents(s.id);
            const cusdBuyable = cosmeticsCusdAvailable && cusd > 0 && !owned;
            // onClick precedence: equip → ticket-buy (if affordable) → cUSD-buy.
            const onClick = unlocked
              ? () => dispatch({ type: 'SET_DICE_SKIN', id: s.id })
              : ticketAffordable
                ? () => onBuy(s.id)
                : cusdBuyable
                  ? () => onBuyCusd(s.id)
                  : undefined;
            return (
              <button
                key={s.id}
                className={`skin${equipped ? ' skin--on' : ''}${unlocked ? '' : ' skin--locked'}`}
                disabled={!unlocked && !ticketAffordable && !cusdBuyable}
                onClick={onClick}
              >
                <DieFace value={6} skin={s} />
                <b>{s.name}</b>
                <small>
                  {equipped
                    ? t('skinEquipped')
                    : unlocked
                      ? t('skinTap')
                      : canBuyTickets
                        ? `${t('skinUnlock')} ${price} 🎟️${cusdBuyable ? ` · ${fmtUsd(cusd)}` : ''}`
                        : cusdBuyable
                          ? `${fmtUsd(cusd)} USDT`
                          : t(s.hintKey ?? 'skinSoon')}
                </small>
                {!unlocked && <span className="skin__lock">{canBuyTickets ? '🎟️' : cusdBuyable ? '💵' : '🔒'}</span>}
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: 10, textAlign: 'center' }} className="muted">
          {t('closeHint')}
        </div>
      </div>
    </div>
  );
}

/**
 * 4-player mode chooser. The old design hid the free-vs-staked choice inside the
 * 1v1 stake picker (tapping "4-Player" silently inherited whatever 1v1 stake was
 * selected — a real-money table could start unannounced). Here the three flavours
 * are named side by side, with their own stake selection for real money.
 */
/**
 * Tap-on-avatar public profile (E-social): who this player is — identity,
 * division, ELO, W/L — plus your 1v1 head-to-head when the server knows both
 * of you. Opens instantly with a loading shimmer; fed by fetchProfile().
 */
export function ProfileSheet() {
  const { viewProfile } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'PROFILE_CLOSE' });
  const trapRef = useFocusTrap<HTMLDivElement>(!!viewProfile, close);
  if (!viewProfile) return null;
  const p = viewProfile.data;
  const losses = p ? Math.max(0, p.games - p.wins) : 0;
  const winPct = p && p.games > 0 ? Math.round((p.wins / p.games) * 100) : null;
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card profilesheet" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {viewProfile.failed ? (
          <p className="muted" style={{ textAlign: 'center', margin: '18px 0' }}>{t('profileUnavailable')}</p>
        ) : !p ? (
          <div className="profilesheet__loading" aria-label="loading">
            <span className="profilesheet__shimmer" />
          </div>
        ) : (
          <>
            <div className="profilesheet__head">
              <span className="profilesheet__flag" aria-hidden="true">{p.flag}</span>
              <div>
                <b className="profilesheet__name">{p.name}</b>
                <small className="muted">{DIVISIONS[p.division] ?? ''} {t('league')}</small>
              </div>
            </div>
            <div className="profilesheet__stats">
              <div className="pstat"><b>{p.elo}</b><small>ELO</small></div>
              <div className="pstat pstat--w"><b>{p.wins}</b><small>{t('winsShort')}</small></div>
              <div className="pstat pstat--l"><b>{losses}</b><small>{t('lossesShort')}</small></div>
              {winPct !== null && <div className="pstat"><b>{winPct}%</b><small>{t('winRate')}</small></div>}
            </div>
            {p.h2h && (
              <div className="profilesheet__h2h">
                {t('h2h')} : <b className="profilesheet__h2hyou">{p.h2h.wins}</b> – <b className="profilesheet__h2hthem">{p.h2h.losses}</b>
              </div>
            )}
          </>
        )}
        <button className="btn btn--ghost" style={{ width: '100%', marginTop: 12 }} onClick={close}>{t('cancel')}</button>
      </div>
    </div>
  );
}

export function Table4Modal({ onPractice, onFree, onStaked }: {
  onPractice(): void;
  onFree(): void;
  onStaked(stake: number): void;
}) {
  const { table4Open, walletBacked } = useAppState();
  const dispatch = useAppDispatch();
  const [stake, setStake] = useState<number>(25);
  const close = (): void => void dispatch({ type: 'TABLE4_MODAL', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(table4Open, close);
  if (!table4Open) return null;
  const staked = (ALLOWED_STAKES_CENTS as readonly number[]).filter((s) => s > 0);
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{t('fourPlayer')}</h3>
        <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>{t('t4Pick')}</p>
        <div className="t4modes">
          <button className="t4mode" onClick={() => { playTap(); onPractice(); }}>
            <span className="t4mode__ic" aria-hidden="true">🤖</span>
            <span className="t4mode__txt"><b>{t('t4Practice')}</b><small>{t('t4PracticeD')}</small></span>
          </button>
          <button className="t4mode" onClick={() => { playTap(); onFree(); }}>
            <span className="t4mode__ic" aria-hidden="true">🌍</span>
            <span className="t4mode__txt"><b>{t('t4FreeOnline')}</b><small>{t('t4FreeOnlineD')}</small></span>
          </button>
          {staked4Available && (
            <div className="t4mode t4mode--real">
              <div className="t4mode__row">
                <span className="t4mode__ic" aria-hidden="true">💵</span>
                <span className="t4mode__txt"><b>{t('t4Real')}</b><small>{t('t4RealD')}</small></span>
              </div>
              <div className="t4chips">
                {staked.map((s) => (
                  <button
                    key={s}
                    className={`t4chip${s === stake ? ' t4chip--sel' : ''}`}
                    onClick={() => { playTap('select'); setStake(s); }}
                  >
                    <b>{s >= 100 ? `$${s / 100}` : `${s}¢`}</b>
                    <small>{t('win')} {fmtUsd(potCents4(s))}</small>
                  </button>
                ))}
              </div>
              <button className="btn" style={{ marginTop: 4 }} onClick={() => { playTap(); onStaked(stake); }}>
                {walletBacked ? `${t('play')} · ${fmtUsd(stake)}` : t('connectWallet')}
              </button>
            </div>
          )}
        </div>
        <div style={{ marginTop: 12, textAlign: 'center' }} className="muted">{t('closeHint')}</div>
      </div>
    </div>
  );
}

/**
 * DRAFT legal text — placeholders the operator MUST replace with real,
 * lawyer-reviewed Terms and a Privacy Policy before any real-money launch.
 * Kept in English (single review language) with a visible DRAFT banner.
 */
const TOS_DRAFT = `1. Ludo Arena is a skill-and-chance 1v1 game. Staked matches wager real
stablecoins held in a non-custodial escrow smart contract; the operator never
custodies player funds. 2. You must be at least 18 years old and legally
permitted to wager where you live. Staked play is void where prohibited.
3. A house fee (rake) is deducted from each settled pot. 4. Outcomes are
determined by provably-fair dice; disputes are resolved from the on-chain
record. 5. No refunds except the on-chain escrow's own refund paths.
6. Play responsibly — set a daily limit or self-exclude in Settings.
[DRAFT — replace with counsel-reviewed Terms before launch.]`;

const PRIVACY_DRAFT = `We store only what the game needs: a wallet address (if
you connect one), gameplay/ELO records, and responsible-gaming limits. We do not
sell personal data. On-chain stakes and settlements are public by nature of the
blockchain. Local device storage keeps your preferences and consent. Contact the
operator to request deletion of off-chain records.
[DRAFT — replace with a counsel-reviewed Privacy Policy before launch.]`;

/** Age (18+) + Terms/Privacy consent gate, shown once before any staked play. */
export function LegalModal({ onAccept }: { onAccept(): void }) {
  const { legalOpen } = useAppState();
  const dispatch = useAppDispatch();
  const [age, setAge] = useState(false);
  const [agree, setAgree] = useState(false);
  const [view, setView] = useState<'gate' | 'tos' | 'privacy'>('gate');
  const closeLegal = (): void => void dispatch({ type: 'LEGAL_MODAL', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(legalOpen && view === 'gate', closeLegal);
  if (!legalOpen) return null;

  if (view !== 'gate') {
    return (
      <div className="modal" onClick={() => setView('gate')}>
        <div className="modal__card legal__doc" onClick={(e) => e.stopPropagation()}>
          <h3>{view === 'tos' ? t('legalReadTos') : t('legalReadPrivacy')}</h3>
          <div className="legal__draft">{t('legalDraft')}</div>
          <p className="legal__body">{view === 'tos' ? TOS_DRAFT : PRIVACY_DRAFT}</p>
          <button className="btn btn--ghost" onClick={() => setView('gate')}>
            {t('cancel')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={t('legalTitle')}>
      <div className="modal__card" ref={trapRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <h3>{t('legalTitle')}</h3>
        <div className="legal__draft">{t('legalDraft')}</div>
        <label className="legal__check">
          <input type="checkbox" checked={age} onChange={(e) => setAge(e.target.checked)} /> {t('legalAge')}
        </label>
        <label className="legal__check">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> {t('legalAgree')}
        </label>
        <div className="legal__links">
          <button className="linklike" onClick={() => setView('tos')}>{t('legalReadTos')}</button>
          {' · '}
          <button className="linklike" onClick={() => setView('privacy')}>{t('legalReadPrivacy')}</button>
        </div>
        <button className="btn" disabled={!age || !agree} onClick={onAccept}>
          {t('legalAccept')}
        </button>
        <button className="btn btn--ghost" style={{ marginTop: 8 }} onClick={() => dispatch({ type: 'LEGAL_MODAL', open: false })}>
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}

export function WelcomeModal({ onStartFree }: { onStartFree(): void }) {
  const { onboardOpen } = useAppState();
  const dispatch = useAppDispatch();
  const doneOnboard = (): void => void dispatch({ type: 'ONBOARD_DONE' });
  const trapRef = useFocusTrap<HTMLDivElement>(onboardOpen, doneOnboard);
  if (!onboardOpen) return null;
  return (
    <div className="modal" onClick={() => dispatch({ type: 'ONBOARD_DONE' })}>
      <div className="modal__card" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
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

export function StakingOverlay({ onCancel }: { onCancel?: () => void }) {
  const { staking, match } = useAppState();
  const active = staking === 'approving' || staking === 'joining';
  // Reveal a cancel after a normal confirmation window so a wallet that never
  // resolves can't strand the user behind a spinner while their clock runs.
  const [showCancel, setShowCancel] = useState(false);
  useEffect(() => {
    setShowCancel(false);
    if (!active) return;
    const id = setTimeout(() => setShowCancel(true), 8000);
    return () => clearTimeout(id);
  }, [active, staking]);
  if (!active) return null;
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
        {showCancel && onCancel && (
          <button className="btn btn--ghost" style={{ marginTop: 16 }} onClick={onCancel}>
            {t('cancel')}
          </button>
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

  const closeFair = (): void => void dispatch({ type: 'FAIR_MODAL', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(fairModalOpen, closeFair);
  if (!fairModalOpen) return null;
  return (
    <div className="modal" onClick={closeFair}>
      <div className="modal__card" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
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
