/** Small cross-cutting UI components: TopBar, Toast, FairnessModal. */
import { useEffect, useMemo, useState } from 'react';
import { useFocusTrap } from './useFocusTrap';
import { fmtCents, fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { verifyFairness, type FairnessReport } from '../lib/fairnessVerify';
import { IconSoundOff, IconSoundOn } from './icons';
import { DieFace } from './Die';
import { DICE_SKINS, loadStats } from '../lib/diceSkins';
import { FRAMES, frameClass } from '../lib/avatarFrames';
import { avatarSrc, AVATAR_FACES, AVATAR_CHARACTERS } from '../lib/avatars';
import { PremiumFrame, isPremiumFrame } from './PremiumFrame';
import { devUnlockCosmetics } from '../lib/devUnlock';
import { COUNTRIES, GLOBE_FLAG } from '../lib/profile';
import { DIVISIONS, PREMIUM_SKINS, PROFILE_NAME_MIN, PROFILE_NAME_MAX, cosmeticCents, potCents4, ALLOWED_STAKES_CENTS } from '@ludo/shared';
import { cosmeticsCusdAvailable, staked4Available } from '../lib/deployments';
import { isMiniPay } from '../lib/minipay';
import { playTap } from '../lib/sound';
import { t } from '../lib/i18n';

/** The "(tap to close)" hint at the bottom of a modal card. It MUST be a real
 *  control: every modal card stops click propagation (so taps on the body don't
 *  dismiss it), which silently swallowed taps on the hint too — the one element
 *  that explicitly PROMISES to close. On a phone there is no Escape key, so a
 *  first-time guest joining via a shared link could be stuck behind the welcome
 *  modal for the whole game (auto-played as "away", rematch unreachable). */
function CloseHint({ onClose, top = 10 }: { onClose(): void; top?: number }) {
  return (
    <button
      type="button"
      className="muted closehint"
      style={{ marginTop: top }}
      onClick={(e) => {
        e.stopPropagation(); // the card's handler must not re-swallow it
        onClose();
      }}
    >
      {t('closeHint')}
    </button>
  );
}

export function TopBar({ onConnect }: { onConnect?: () => Promise<boolean> }) {
  const { balanceCents, walletBacked, soundOn, streak, challenge, tickets, profile } = useAppState();
  const dispatch = useAppDispatch();
  // Draw the eye to Progression when there's something to do there: an unfinished
  // daily challenge, or a live streak worth protecting. Only for a RETURNING
  // player — `!challenge.completed` is true for everyone at first load, so
  // without the history guard the red dot fires before the first game.
  const returning = profile.games > 0 || streak.days > 0 || tickets > 0;
  const progNudge = returning && (!challenge.completed || streak.days > 0);
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
        {/* Progression: the daily loop + rivals moved off the landing so the home
            screen stays focused on Play + Season. Accent-styled + a nudge so it
            never reads as a mere toggle users can miss. */}
        <button
          className="progbtn"
          title={t('progressionTitle')}
          aria-label={t('progressionTitle')}
          onClick={() => dispatch({ type: 'PROGRESSION_MODAL', open: true })}
        >
          {streak.days > 0 ? (
            <span className="progbtn__streak">🔥 {streak.days}</span>
          ) : (
            <svg viewBox="0 0 24 24" className="icon" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20V10M10 20V4M16 20v-7M20 20H3" />
            </svg>
          )}
          {progNudge && <span className="progbtn__dot" aria-hidden="true" />}
        </button>
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
            {/* Low balance → a top-up path instead of a dead end (MiniPay Add-Cash
                deeplink; the lowest stake is 25¢, so under that you can't stake). */}
            {balanceCents < 25 && (
              <a
                className="topbar__add"
                href="https://link.minipay.xyz/add_cash?tokens=USDT,USDC"
                onClick={(e) => { if (!isMiniPay()) e.preventDefault(); }}
              >
                {t('addCash')}
              </a>
            )}
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
        <CloseHint onClose={close} top={12} />
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

/**
 * Win-back "welcome back" modal (season Phase 3): shown on return after an absence,
 * announcing the comeback tickets already credited. Purely celebratory — the grant
 * happened server-side; this just surfaces it and nudges back into the season.
 */
export function ComebackModal() {
  const { comeback } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'COMEBACK_CLEAR' });
  const trapRef = useFocusTrap<HTMLDivElement>(!!comeback, close);
  if (!comeback) return null;
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="end__emoji">👋</div>
        <h3>{t('comebackTitle')}</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          {t('comebackBody').replace('{d}', String(comeback.daysAway))}
        </p>
        <div className="crowngain" style={{ margin: '4px auto 12px' }}>+{comeback.tickets} 🎟️</div>
        <button className="btn" onClick={close}>{t('comebackCta')}</button>
      </div>
    </div>
  );
}

/** Dice-skin picker: progression unlocks + ticket buys, plus cUSD buys once the
 *  CosmeticsStore is deployed (cosmeticsCusdAvailable — dormant until then). */
export function DiceModal({ onBuy, onBuyCusd }: { onBuy(skinId: string): void; onBuyCusd(id: string): void }) {
  const { diceModalOpen, diceSkin, streak, tickets, league, ownedSkins, avatarFrame, walletAddress } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'DICE_MODAL', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(diceModalOpen, close);
  if (!diceModalOpen) return null;
  const stats = loadStats();
  const ctx = { ...stats, streakDays: streak.days, tickets, division: league.division };
  // Dev/QA wallet: every cosmetic unlocked so the owner can test them all.
  const devAll = devUnlockCosmetics(walletAddress);
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
            const owned = devAll || ownedSkins.includes(s.id);
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
                          : s.season
                            ? t('seasonExclusive')
                            : t(s.hintKey ?? 'skinSoon')}
                </small>
                {!unlocked && <span className="skin__lock">{canBuyTickets ? '🎟️' : cusdBuyable ? '💵' : s.season ? '👑' : '🔒'}</span>}
              </button>
            );
          })}
        </div>

        {/* Avatar frames — the cosmetic everyone sees on your profile (C3). */}
        <h3 style={{ marginTop: 16 }}>{t('framesTitle')}</h3>
        <div className="framegrid">
          {FRAMES.map((f) => {
            const unlocked = devAll || f.unlocked(ctx);
            const equipped = f.id === avatarFrame;
            return (
              <button
                key={f.id}
                className={`frametile${equipped ? ' frametile--on' : ''}${unlocked ? '' : ' frametile--locked'}`}
                disabled={!unlocked}
                onClick={unlocked ? () => dispatch({ type: 'EQUIP_FRAME', id: f.id }) : undefined}
              >
                <span className={`frametile__ring ${frameClass(f.id)}`} aria-hidden="true">
                  {isPremiumFrame(f.id) && <PremiumFrame frame={f.id} />}
                </span>
                <b>{t(f.nameKey)}</b>
                <small>{equipped ? t('skinEquipped') : unlocked ? t('skinTap') : t(f.hintKey ?? 'skinSoon')}</small>
                {!unlocked && <span className="skin__lock">🔒</span>}
              </button>
            );
          })}
        </div>

        <CloseHint onClose={close} />
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
              <span className={`profilesheet__flag ${frameClass(p.frame)}`} aria-hidden="true">
                {avatarSrc(p.avatar) ? <img className="profilesheet__img" src={avatarSrc(p.avatar)!} alt="" /> : p.flag}
                <PremiumFrame frame={p.frame} />
              </span>
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

/**
 * Editable profile (E-social): set your display name (server-sanitized), pick a
 * country flag, and jump to the cosmetics for a frame. Opens from the identity
 * card; saving pushes to the server, which echoes back the effective name.
 */
export function ProfileEditor({ onSave }: { onSave(name: string, flag: string, avatar: string): void }) {
  const { profileEditOpen, profile, avatarFrame, avatar: storeAvatar } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'PROFILE_EDIT', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(profileEditOpen, close);
  const [name, setName] = useState(profile.name);
  const [flag, setFlag] = useState(profile.flag);
  const [avatar, setAvatar] = useState(storeAvatar);
  useEffect(() => {
    if (profileEditOpen) {
      setName(profile.name);
      setFlag(profile.flag);
      setAvatar(storeAvatar);
    }
  }, [profileEditOpen, profile.name, profile.flag, storeAvatar]);
  if (!profileEditOpen) return null;
  const trimmed = name.trim();
  const valid = trimmed.length >= PROFILE_NAME_MIN && trimmed.length <= PROFILE_NAME_MAX;
  const previewSrc = avatarSrc(avatar);
  const save = (): void => {
    if (!valid) return;
    onSave(trimmed, flag, avatar);
    close();
  };
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card profileeditor" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{t('editProfile')}</h3>
        <div className="pe__preview">
          <span className={`pe__flag ${frameClass(avatarFrame)}`} aria-hidden="true">
            {previewSrc ? <img className="pe__previmg" src={previewSrc} alt="" /> : flag}
            <PremiumFrame frame={avatarFrame} />
          </span>
          <b>{trimmed || '—'}</b>
        </div>

        <label className="pe__label" htmlFor="pe-name">{t('displayName')}</label>
        <input
          id="pe-name"
          className="pe__input"
          value={name}
          maxLength={PROFILE_NAME_MAX}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          placeholder={t('displayName')}
        />
        <small className="muted">{t('nameHint')}</small>

        <label className="pe__label">{t('avatar')}</label>
        <div className="pe__avatars">
          <button
            className={`pe__avbtn pe__avbtn--none${avatar === 'none' ? ' pe__avbtn--on' : ''}`}
            title={t('avatarNone')}
            onClick={() => setAvatar('none')}
          >
            <span aria-hidden="true">{flag}</span>
          </button>
          {[...AVATAR_FACES, ...AVATAR_CHARACTERS].map((id) => (
            <button
              key={id}
              className={`pe__avbtn${avatar === id ? ' pe__avbtn--on' : ''}`}
              onClick={() => setAvatar(id)}
              aria-label={id}
            >
              <img src={avatarSrc(id)!} alt="" loading="lazy" />
            </button>
          ))}
        </div>
        <small className="muted">{t('avatarHint')}</small>

        <label className="pe__label">{t('country')}</label>
        <div className="pe__flags">
          <button
            className={`pe__flagbtn${flag === GLOBE_FLAG ? ' pe__flagbtn--on' : ''}`}
            title={t('other')}
            onClick={() => setFlag(GLOBE_FLAG)}
          >
            {GLOBE_FLAG}
          </button>
          {COUNTRIES.map((c) => (
            <button
              key={c.code}
              className={`pe__flagbtn${flag === c.flag ? ' pe__flagbtn--on' : ''}`}
              title={c.name}
              onClick={() => setFlag(c.flag)}
            >
              {c.flag}
            </button>
          ))}
        </div>

        <button className="btn btn--ghost" onClick={() => { close(); dispatch({ type: 'DICE_MODAL', open: true }); }}>
          {t('framesAndDice')}
        </button>
        <div style={{ height: 8 }} />
        <button className="btn" disabled={!valid} onClick={save}>{t('save')}</button>
      </div>
    </div>
  );
}

/** "No wallet in this browser" sheet — shown when connect is tapped and no
 *  provider is injected (Chrome mobile etc.). Actionable, not a dead end:
 *  open the game inside MiniPay (deeplink), copy the link, or keep playing
 *  free. Staking itself stays MiniPay/injected-wallet only. */
export function NoWalletSheet() {
  const { noWalletOpen } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'NOWALLET', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(noWalletOpen, close);
  if (!noWalletOpen) return null;
  const here = window.location.origin + window.location.pathname;
  const openInMiniPay = `https://link.minipay.xyz/browse?url=${encodeURIComponent(here)}`;
  const copy = (): void => {
    navigator.clipboard?.writeText(here).then(
      () => dispatch({ type: 'TOAST', message: t('nwCopied') }),
      () => undefined,
    );
  };
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{t('nwTitle')}</h3>
        <p className="muted" style={{ fontSize: 13, margin: '8px 0 14px' }}>{t('nwBody')}</p>
        <a className="btn" href={openInMiniPay} target="_blank" rel="noreferrer">
          {t('nwOpen')}
        </a>
        <button className="btn btn--ghost" style={{ marginTop: 8 }} onClick={copy}>
          {t('copyLink')}
        </button>
        <button className="btn btn--ghost" style={{ marginTop: 8 }} onClick={() => { playTap(); close(); }}>
          {t('nwFree')}
        </button>
      </div>
    </div>
  );
}

/** Operator contact for the Support links (footer + help sheet). */
export const SUPPORT_EMAIL = 'swappilot.exchange@gmail.com';

/** "How it works" sheet: the landing was mute about tickets, the daily
 *  freeroll, the weekly league, fair dice and money games — this explains all
 *  five, with real constants (10 pts/win, 1 ticket entry → 3, 9% rake). */
export function HelpModal() {
  const { helpOpen } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'HELP_MODAL', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(helpOpen, close);
  if (!helpOpen) return null;
  const openFair = (): void => {
    close();
    dispatch({ type: 'FAIR_MODAL', open: true });
  };
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card help__card" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{t('helpTitle')}</h3>
        <div className="help__scroll">
          <section className="help__sec">
            <h4>🎟️ {t('hTickets')}</h4>
            <p>{t('hTicketsBody')}</p>
          </section>
          <section className="help__sec">
            <h4>🏆 {t('hFreeroll')}</h4>
            <p>{t('hFreerollBody')}</p>
          </section>
          <section className="help__sec">
            <h4>👑 {t('hSeason')}</h4>
            <p>{t('hSeasonBody')}</p>
          </section>
          <section className="help__sec">
            <h4>🎲 {t('hFair')}</h4>
            <p>
              {t('hFairBody')} <a className="help__link" onClick={openFair}>{t('howItWorks')}</a>
            </p>
          </section>
          <section className="help__sec">
            <h4>💵 {t('hMoney')}</h4>
            <p>{t('hMoneyBody')}</p>
          </section>
          <section className="help__sec">
            <h4>📮 {t('hSupport')}</h4>
            <p>
              {t('hSupportBody')} <a className="help__link" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
            </p>
          </section>
        </div>
        <button className="btn btn--ghost" onClick={() => { playTap(); close(); }}>{t('close')}</button>
      </div>
    </div>
  );
}

/** Read-only Terms/Privacy viewer, reachable from the lobby footer — before
 *  this, the drafts were only visible inside the staking consent gate. */
export function DocModal() {
  const { legalDoc } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'LEGAL_DOC', doc: null });
  if (!legalDoc) return null;
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card legal__doc" onClick={(e) => e.stopPropagation()}>
        <h3>{legalDoc === 'tos' ? t('legalReadTos') : t('legalReadPrivacy')}</h3>
        <p className="legal__body">{legalDoc === 'tos' ? TOS_DRAFT : PRIVACY_DRAFT}</p>
        <button className="btn btn--ghost" onClick={close}>{t('close')}</button>
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
        <CloseHint onClose={close} top={12} />
      </div>
    </div>
  );
}

/**
 * Terms of Service. Kept in English (single canonical language). Concise, factual
 * summary of how staked play works; the operator should have counsel review before
 * a mainnet real-money launch, but this reads as the live policy (no draft banner).
 */
const TOS_DRAFT = `1. Ludo Arena is a skill-and-chance 1v1 game. Staked matches wager
stablecoins held in a non-custodial escrow smart contract; the operator never
custodies player funds. 2. You must be at least 18 years old and legally
permitted to wager where you live. Staked play is void where prohibited.
3. A house fee (rake) is deducted from each settled pot. 4. Outcomes are
determined by provably-fair dice; disputes are resolved from the on-chain
record. 5. No refunds except the on-chain escrow's own refund paths.
6. Play responsibly — set a daily limit or self-exclude in Settings.`;

const PRIVACY_DRAFT = `We store only what the game needs: a wallet address (if
you connect one), gameplay/ELO records, and responsible-gaming limits. We do not
sell personal data. On-chain stakes and settlements are public by nature of the
blockchain. Local device storage keeps your preferences and consent. Contact the
operator to request deletion of off-chain records.`;

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
        <CloseHint onClose={doneOnboard} />
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
  const own = useMemo(
    () => (match?.myEntropy ? { entropy: match.myEntropy, seat: match.seat } : undefined),
    [match?.myEntropy, match?.seat],
  );
  useEffect(() => {
    setReport(null);
    if (!fairModalOpen || !reveal || !commit) return;
    let live = true;
    void verifyFairness(commit, reveal, diceHistory, own).then((r) => {
      if (live) setReport(r);
    });
    return () => {
      live = false;
    };
  }, [fairModalOpen, reveal, commit, diceHistory, own]);

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
                  {report.ownEntropyOk !== null && <> · {t('yourEntropyLabel')} {report.ownEntropyOk ? '✓' : '✗'}</>}
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
        <CloseHint onClose={closeFair} />
      </div>
    </div>
  );
}
