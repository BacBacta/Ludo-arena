/** Small cross-cutting UI components: TopBar, Toast, FairnessModal. */
import { useEffect, useMemo, useState } from 'react';
import { useFocusTrap } from './useFocusTrap';
import { fmtCents, fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { verifyFairness, type FairnessReport } from '../lib/fairnessVerify';
import { IconSoundOff, IconSoundOn } from './icons';
import { DieFace } from './Die';
import { DICE_SKINS, loadStats } from '../lib/diceSkins';
import { FRAMES, frameById, frameClass } from '../lib/avatarFrames';
import { TOKEN_SKINS, ENTRANCE_FX, VICTORY_FX, tokenSkinById, entranceFxById, victoryFxById } from '../lib/tokenSkins';
import { BOARD_THEMES, boardThemeById } from '../lib/boardThemes';
import { toastDurationMs } from '../lib/toast';
import { TokenPreview, BoardThemePreview } from './Board';
import { avatarSrc, AVATAR_ORIGINALS, AVATAR_FACES, AVATAR_CHARACTERS } from '../lib/avatars';
import { PremiumFrame, isPremiumFrame } from './PremiumFrame';
import { devUnlockCosmetics } from '../lib/devUnlock';
import { COUNTRIES, GLOBE_FLAG } from '../lib/profile';
import { COSMETIC_SETS, DIVISIONS, FEATURED_SET_MULTIPLIER, PREMIUM_COSMETICS, PREMIUM_SKINS, PROFILE_NAME_MIN, PROFILE_NAME_MAX, cosmeticById, cosmeticCents, featuredSetIdFor, potCents4, ALLOWED_STAKES_CENTS } from '@ludo/shared';
import { cosmeticsCusdAvailable, staked4Available } from '../lib/deployments';
import { isMiniPay } from '../lib/minipay';
import { playDice, playTap } from '../lib/sound';
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

export function TopBar({ onConnect, onDisconnect }: { onConnect?: () => Promise<boolean>; onDisconnect?: () => Promise<void> }) {
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
        <span className="topbar__word">LUDO <span>ARENA</span></span>
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
            {/* Outside MiniPay, let the user drop this wallet and pair a different
                one — MiniPay's wallet is ambient and not ours to disconnect. */}
            {!isMiniPay() && onDisconnect && (
              <button
                className="topbar__disconnect"
                title={t('disconnectWallet')}
                aria-label={t('disconnectWallet')}
                onClick={() => void onDisconnect()}
              >
                <svg viewBox="0 0 24 24" className="icon" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                </svg>
              </button>
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

/** Live friend challenge (E-social 2): a friend created a table for me RIGHT
 *  NOW — accept joins it, decline just closes (their table expires server-side,
 *  and they see the normal share screen, so ignoring is never an error). */
export function ChallengeOfferModal({ onAccept }: { onAccept(code: string): void }) {
  const { challengeOffer } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'CHALLENGE_OFFER', offer: null });
  const trapRef = useFocusTrap<HTMLDivElement>(!!challengeOffer, close);
  if (!challengeOffer) return null;
  const { from, code, stakeCents } = challengeOffer;
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
        <div className="challengeoffer__who">
          <span className={`profilecard__flag ${frameClass(from.frame)}`}>
            {avatarSrc(from.avatar) ? <img className="profilecard__img" src={avatarSrc(from.avatar)!} alt="" /> : from.flag}
          </span>
          <h3>{from.name} {t('challengeTitle')}</h3>
        </div>
        <p className="muted" style={{ fontSize: 13, margin: '6px 0 14px' }}>
          {stakeCents > 0 ? `${fmtUsd(stakeCents)} · ${t('challengeStakedSub')}` : t('challengeFreeSub')}
        </p>
        <button className="btn" onClick={() => { playTap(); onAccept(code); }}>
          ⚔️ {t('challengeAccept')}
        </button>
        <button className="btn btn--ghost" style={{ marginTop: 8 }} onClick={close}>
          {t('challengeDecline')}
        </button>
      </div>
    </div>
  );
}

/** Gift-a-cosmetic picker (cosmetics phase 2): choose a premium item from the
 *  shared catalog and pay ITS ticket price to unlock it on the FRIEND's account
 *  (server validates mutual friendship + balance; grant is durable). Items the
 *  friend might already own are refused server-side with a clear message. */
/** Preview tile + display name for ANY catalog cosmetic id — shared by the
 *  gift picker (phase 2) and the collection album (phase 3). Kind-dispatched;
 *  the id namespace is shared, so always resolve through cosmeticById. */
export function CosmeticPreview({ id, idKey }: { id: string; idKey: string }) {
  const kind = cosmeticById(id)?.kind;
  if (kind === 'dice') {
    const s = DICE_SKINS.find((d) => d.id === id);
    return s ? <DieFace value={6} skin={s} /> : null;
  }
  if (kind === 'token') return <TokenPreview pattern={tokenSkinById(id).pattern} idKey={idKey} />;
  if (kind === 'board') return <BoardThemePreview theme={boardThemeById(id)} />;
  if (kind === 'frame') {
    return (
      <span className="frametile__ring" aria-hidden="true">
        <PremiumFrame frame={id} />
      </span>
    );
  }
  const fx = kind === 'victory' ? victoryFxById(id) : entranceFxById(id);
  return <span style={{ fontSize: 30, display: 'block', lineHeight: '50px' }} aria-hidden="true">{fx.particles[0] ?? '🎁'}</span>;
}
export function cosmeticName(id: string): string {
  const kind = cosmeticById(id)?.kind;
  if (kind === 'dice') return DICE_SKINS.find((d) => d.id === id)?.name ?? id;
  if (kind === 'token') return tokenSkinById(id).name;
  if (kind === 'board') return boardThemeById(id).name;
  if (kind === 'frame') return t(frameById(id).nameKey);
  return kind === 'victory' ? victoryFxById(id).name : entranceFxById(id).name;
}

export function GiftCosmeticModal({ onSend }: { onSend(pid: string, id: string): Promise<boolean> }) {
  const { giftFriend, tickets } = useAppState();
  const dispatch = useAppDispatch();
  const [sendingId, setSendingId] = useState<string | null>(null);
  const close = (): void => void dispatch({ type: 'GIFT_MODAL', friend: null });
  const trapRef = useFocusTrap<HTMLDivElement>(!!giftFriend, close);
  if (!giftFriend) return null;
  // Every ticket-priced catalog item is giftable; preview + name resolve per kind.
  const giftables = PREMIUM_COSMETICS.filter((c) => c.tickets > 0);
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>🎁 {t('giftTitle')} {giftFriend.name}</h3>
        <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          {t('giftIntro')} · 🎟️ {tickets}
        </p>
        <div className="skingrid">
          {giftables.map((c) => {
            const affordable = tickets >= c.tickets;
            const busy = sendingId !== null;
            return (
              <button
                key={c.id}
                className={`skin${affordable ? '' : ' skin--locked'}`}
                disabled={!affordable || busy}
                onClick={() => {
                  setSendingId(c.id);
                  void onSend(giftFriend.pid, c.id).then((ok) => {
                    setSendingId(null);
                    if (ok) close();
                  });
                }}
              >
                <CosmeticPreview id={c.id} idKey={`gift-${c.id}`} />
                <b>{cosmeticName(c.id)}</b>
                <small>{sendingId === c.id ? '…' : `${c.tickets} 🎟️`}</small>
              </button>
            );
          })}
        </div>
        <CloseHint onClose={close} />
      </div>
    </div>
  );
}

/** Collection album (cosmetics phase 3): every set with its item tiles, an
 *  owned-count progress bar, and the one-time ticket bonus claim. Ownership is
 *  server-authoritative (ownedSkins/claimedSets both come from hello.ok). */
export function CollectionSheet({ onClaim }: { onClaim(setId: string): Promise<boolean> }) {
  const { collectionOpen, ownedSkins, claimedSets, walletAddress, season } = useAppState();
  const dispatch = useAppDispatch();
  const [claiming, setClaiming] = useState<string | null>(null);
  const close = (): void => void dispatch({ type: 'COLLECTION_MODAL', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(collectionOpen, close);
  if (!collectionOpen) return null;
  const devAll = devUnlockCosmetics(walletAddress);
  // Seasonal rotation (phase 3b): the same deterministic pick the server pays
  // ×2 on — plus the days left, for urgency. Absent until hello.ok syncs.
  const featuredId = season ? featuredSetIdFor(season.id) : null;
  const seasonDaysLeft = season ? Math.max(0, Math.ceil((new Date(season.endsAt).getTime() - Date.now()) / 86_400_000)) : 0;
  const setName = (id: string): string =>
    id === 'set-heritage' ? t('setHeritage') : id === 'set-gold' ? t('setGold') : t('setRoyale');
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>📚 {t('collectionTitle')}</h3>
        <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{t('collectionIntro')}</p>
        {COSMETIC_SETS.map((set) => {
          const ownedCount = set.itemIds.filter((i) => devAll || ownedSkins.includes(i)).length;
          const complete = ownedCount === set.itemIds.length;
          const claimed = claimedSets.includes(set.id);
          const pct = Math.round((ownedCount / set.itemIds.length) * 100);
          const featured = set.id === featuredId && !claimed;
          const bonus = set.rewardTickets * (featured ? FEATURED_SET_MULTIPLIER : 1);
          return (
            <div key={set.id} className={`collset${featured ? ' collset--featured' : ''}`}>
              {featured && (
                <div className="collset__ribbon">
                  ⭐ {t('featuredSet')} · ×{FEATURED_SET_MULTIPLIER} · {t('seasonEndsIn').replace('{d}', String(seasonDaysLeft))}
                </div>
              )}
              <div className="collset__head">
                <b>{setName(set.id)}</b>
                <small className="muted">{ownedCount}/{set.itemIds.length}</small>
              </div>
              <div className="collset__items">
                {set.itemIds.map((itemId) => {
                  const owned = devAll || ownedSkins.includes(itemId);
                  return (
                    <span key={itemId} className={`collset__item${owned ? '' : ' collset__item--missing'}`} title={cosmeticName(itemId)}>
                      <CosmeticPreview id={itemId} idKey={`coll-${set.id}-${itemId}`} />
                    </span>
                  );
                })}
              </div>
              <div className="seasonbar__track collset__bar"><span className="seasonbar__fill" style={{ width: `${pct}%` }} /></div>
              {claimed ? (
                <small className="collset__done">✓ {t('setClaimed')}</small>
              ) : complete ? (
                <button
                  className="btn collset__claim"
                  disabled={claiming !== null}
                  onClick={() => {
                    setClaiming(set.id);
                    void onClaim(set.id).then(() => setClaiming(null));
                  }}
                >
                  {claiming === set.id ? '…' : `🎁 ${t('setClaim')} +${bonus} 🎟️`}
                </button>
              ) : (
                <small className="muted">{t('setBonus')} +{bonus} 🎟️</small>
              )}
            </div>
          );
        })}
        <CloseHint onClose={close} />
      </div>
    </div>
  );
}

export function Toast() {
  const { toast } = useAppState();
  const dispatch = useAppDispatch();
  // Dwell scales with length (see toastDurationMs): a flat 2.4s flashed long
  // diagnostics away before they could be read. Tap dismisses early — and lets
  // the reader hold, then close, a message they want to capture.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => dispatch({ type: 'CLEAR_TOAST' }), toastDurationMs(toast));
    return () => clearTimeout(id);
  }, [toast, dispatch]);
  if (!toast) return null;
  return (
    <div
      className="toast"
      role="status"
      aria-live="polite"
      onClick={() => dispatch({ type: 'CLEAR_TOAST' })}
    >
      <span className="toast__msg">{toast}</span>
      {/* Dwell bar: how long the notice stays (toastDurationMs) — a premium cue
          that the card is dismissible and time-bound, not stuck. */}
      <span className="toast__dwell" style={{ animationDuration: `${toastDurationMs(toast)}ms` }} aria-hidden="true" />
    </div>
  );
}

// Self-set daily stake caps offered in Settings; the top option equals
// MAX_DAILY_STAKE_LIMIT_CENTS ($15) — the server clamps anything above it.
const LIMIT_OPTIONS = [200, 500, 1500];
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

/** Explicit purchase sheet (UX fix): tapping a LOCKED premium tile used to
 *  silently pick a payment rail by precedence (tickets if affordable, else
 *  cUSD) — nobody could SEE where to pay money. This sheet shows the item and
 *  two labelled buttons: unlock with tickets (with the player's balance) and
 *  pay in USDT (wallet flow) — the choice is the player's, in one obvious place. */
function PurchaseSheet({ id, tickets, onClose, onBuy, onBuyCusd }: {
  id: string;
  tickets: number;
  onClose(): void;
  onBuy(id: string): void;
  onBuyCusd(id: string): void;
}) {
  const item = cosmeticById(id);
  const ticketPrice = item && item.tickets > 0 ? item.tickets : undefined;
  const cents = item?.cents ?? 0;
  const affordable = ticketPrice !== undefined && tickets >= ticketPrice;
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose);
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__card buysheet" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <CosmeticPreview id={id} idKey={`buy-${id}`} />
        <h3>{cosmeticName(id)}</h3>
        {ticketPrice !== undefined && (
          <>
            <button
              className="btn"
              disabled={!affordable}
              onClick={() => { playTap('select'); onBuy(id); onClose(); }}
            >
              🎟️ {t('buyTicketsBtn')} — {ticketPrice} 🎟️
            </button>
            <small className="muted buysheet__bal">{t('yourTickets')}: {tickets} 🎟️{affordable ? '' : ` · ${t('notEnoughTickets')}`}</small>
          </>
        )}
        {cosmeticsCusdAvailable && cents > 0 && (
          <button className="btn buysheet__usdt" onClick={() => { playTap('select'); onBuyCusd(id); onClose(); }}>
            💵 {t('buyUsdtBtn')} — {fmtUsd(cents)} USDT
          </button>
        )}
        <button className="btn btn--ghost" onClick={onClose}>{t('cancel')}</button>
      </div>
    </div>
  );
}

/** Dice-skin picker: progression unlocks + ticket buys, plus cUSD buys once the
 *  CosmeticsStore is deployed (cosmeticsCusdAvailable — dormant until then). */
export function DiceModal({ onBuy, onBuyCusd }: { onBuy(skinId: string): void; onBuyCusd(id: string): void }) {
  const { diceModalOpen, diceSkin, tokenSkin, entranceFx, boardTheme, victoryFx, streak, tickets, league, ownedSkins, claimedSets, avatarFrame, walletAddress } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'DICE_MODAL', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(diceModalOpen, close);
  // Purchase sheet target: a LOCKED premium tile was tapped (see PurchaseSheet).
  const [buyingId, setBuyingId] = useState<string | null>(null);
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
        {/* Collection album entry (phase 3): completion bonuses live one tap away
            from the tiles that fill them. Shows how many sets are claimable. */}
        <button
          className="btn btn--ghost collentry"
          // Close the shop first: two stacked .modal overlays would fight for
          // the top paint order (the album mounted below and stayed hidden).
          onClick={() => { dispatch({ type: 'DICE_MODAL', open: false }); dispatch({ type: 'COLLECTION_MODAL', open: true }); }}
        >
          📚 {t('collectionTitle')}
          {(() => {
            const claimable = COSMETIC_SETS.filter(
              (cs) => !claimedSets.includes(cs.id) && cs.itemIds.every((i) => devAll || ownedSkins.includes(i)),
            ).length;
            return claimable > 0 ? <span className="collentry__badge">{claimable}</span> : null;
          })()}
        </button>
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
            // A locked PREMIUM tile opens the purchase sheet (explicit rails);
            // progression/season tiles keep their unlock hints.
            const purchasable = canBuyTickets || cusdBuyable;
            const onClick = unlocked
              ? () => {
                  // Equip = hear it: each die answers with its own material roll
                  // sound (gold=coins, crystal=chime…), so the cosmetic's audio
                  // identity is discoverable right in the shop.
                  playDice(s.sound);
                  dispatch({ type: 'SET_DICE_SKIN', id: s.id });
                }
              : purchasable
                ? () => setBuyingId(s.id)
                : undefined;
            return (
              <button
                key={s.id}
                className={`skin${equipped ? ' skin--on' : ''}${unlocked ? '' : ' skin--locked'}`}
                disabled={!unlocked && !purchasable}
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

        {/* Token (pawn) skins — the cosmetic the OPPONENT stares at all game
            (cosmetics phase 1). Dual pricing (tickets · $) per CPC guidance. */}
        <h3 style={{ marginTop: 16 }}>{t('tokensTitle')}</h3>
        <div className="skingrid">
          {TOKEN_SKINS.map((s) => {
            const price = PREMIUM_SKINS[s.id];
            const owned = devAll || ownedSkins.includes(s.id) || price === undefined;
            const equipped = s.id === tokenSkin;
            const ticketAffordable = !owned && price !== undefined && tickets >= price;
            const cusd = cosmeticCents(s.id);
            const cusdBuyable = cosmeticsCusdAvailable && cusd > 0 && !owned;
            const purchasable = !owned && (price !== undefined || cusdBuyable);
            const onClick = owned
              ? () => dispatch({ type: 'SET_TOKEN_SKIN', id: s.id })
              : purchasable
                ? () => setBuyingId(s.id)
                : undefined;
            return (
              <button
                key={s.id}
                className={`skin${equipped ? ' skin--on' : ''}${owned ? '' : ' skin--locked'}`}
                disabled={!owned && !purchasable}
                onClick={onClick}
              >
                <TokenPreview pattern={s.pattern} idKey={`shop-${s.id}`} />
                <b>{s.name}</b>
                <small>
                  {equipped
                    ? t('skinEquipped')
                    : owned
                      ? t('skinTap')
                      : price !== undefined
                        ? `${t('skinUnlock')} ${price} 🎟️${cusd > 0 ? ` · ${fmtUsd(cusd)}` : ''}`
                        : s.blurb}
                </small>
                {!owned && <span className="skin__lock">🎟️</span>}
              </button>
            );
          })}
        </div>

        {/* Board themes (phase 2) — restyle the neutral board surfaces; the four
            seat colours never change. Local view only (like Ludo King). */}
        <h3 style={{ marginTop: 16 }}>{t('boardsTitle')}</h3>
        <div className="skingrid">
          {BOARD_THEMES.map((b) => {
            const price = PREMIUM_SKINS[b.id];
            const owned = devAll || ownedSkins.includes(b.id) || price === undefined;
            const equipped = b.id === boardTheme;
            const ticketAffordable = !owned && price !== undefined && tickets >= price;
            const cusd = cosmeticCents(b.id);
            const cusdBuyable = cosmeticsCusdAvailable && cusd > 0 && !owned;
            const purchasable = !owned && (price !== undefined || cusdBuyable);
            const onClick = owned
              ? () => dispatch({ type: 'SET_BOARD_THEME', id: b.id })
              : purchasable
                ? () => setBuyingId(b.id)
                : undefined;
            return (
              <button
                key={b.id}
                className={`skin${equipped ? ' skin--on' : ''}${owned ? '' : ' skin--locked'}`}
                disabled={!owned && !purchasable}
                onClick={onClick}
              >
                <BoardThemePreview theme={b} />
                <b>{b.name}</b>
                <small>
                  {equipped
                    ? t('skinEquipped')
                    : owned
                      ? t('skinTap')
                      : price !== undefined
                        ? `${t('skinUnlock')} ${price} 🎟️${cusd > 0 ? ` · ${fmtUsd(cusd)}` : ''}`
                        : b.blurb}
                </small>
                {!owned && <span className="skin__lock">🎟️</span>}
              </button>
            );
          })}
        </div>

        {/* Entrance effects — played at match start, seen by BOTH players. */}
        <h3 style={{ marginTop: 16 }}>{t('entranceTitle')}</h3>
        <div className="skingrid">
          {ENTRANCE_FX.map((f) => {
            const price = PREMIUM_SKINS[f.id];
            const owned = devAll || ownedSkins.includes(f.id) || price === undefined;
            const equipped = f.id === entranceFx;
            const ticketAffordable = !owned && price !== undefined && tickets >= price;
            const cusd = cosmeticCents(f.id);
            const cusdBuyable = cosmeticsCusdAvailable && cusd > 0 && !owned;
            const purchasable = !owned && (price !== undefined || cusdBuyable);
            const onClick = owned
              ? () => dispatch({ type: 'SET_ENTRANCE_FX', id: f.id })
              : purchasable
                ? () => setBuyingId(f.id)
                : undefined;
            return (
              <button
                key={f.id}
                className={`skin${equipped ? ' skin--on' : ''}${owned ? '' : ' skin--locked'}`}
                disabled={!owned && !purchasable}
                onClick={onClick}
              >
                <span style={{ fontSize: 30, display: 'block', lineHeight: '50px' }} aria-hidden="true">{f.particles[0] ?? '➖'}</span>
                <b>{f.name}</b>
                <small>
                  {equipped
                    ? t('skinEquipped')
                    : owned
                      ? t('skinTap')
                      : price !== undefined
                        ? `${t('skinUnlock')} ${price} 🎟️${cusd > 0 ? ` · ${fmtUsd(cusd)}` : ''}`
                        : t('skinTap')}
                </small>
                {!owned && <span className="skin__lock">🎟️</span>}
              </button>
            );
          })}
        </div>

        {/* Victory effects (phase 2) — the winner's flourish; the LOSER watches
            it too (relayed like the entrance effect). */}
        <h3 style={{ marginTop: 16 }}>{t('victoryTitle')}</h3>
        <div className="skingrid">
          {VICTORY_FX.map((f) => {
            const price = PREMIUM_SKINS[f.id];
            const owned = devAll || ownedSkins.includes(f.id) || price === undefined;
            const equipped = f.id === victoryFx;
            const ticketAffordable = !owned && price !== undefined && tickets >= price;
            const cusd = cosmeticCents(f.id);
            const cusdBuyable = cosmeticsCusdAvailable && cusd > 0 && !owned;
            const purchasable = !owned && (price !== undefined || cusdBuyable);
            const onClick = owned
              ? () => dispatch({ type: 'SET_VICTORY_FX', id: f.id })
              : purchasable
                ? () => setBuyingId(f.id)
                : undefined;
            return (
              <button
                key={f.id}
                className={`skin${equipped ? ' skin--on' : ''}${owned ? '' : ' skin--locked'}`}
                disabled={!owned && !purchasable}
                onClick={onClick}
              >
                <span style={{ fontSize: 30, display: 'block', lineHeight: '50px' }} aria-hidden="true">{f.particles[0] ?? '➖'}</span>
                <b>{f.name}</b>
                <small>
                  {equipped
                    ? t('skinEquipped')
                    : owned
                      ? t('skinTap')
                      : price !== undefined
                        ? `${t('skinUnlock')} ${price} 🎟️${cusd > 0 ? ` · ${fmtUsd(cusd)}` : ''}`
                        : t('skinTap')}
                </small>
                {!owned && <span className="skin__lock">🎟️</span>}
              </button>
            );
          })}
        </div>

        {/* Avatar frames — the cosmetic everyone sees on your profile (C3).
            Progression rewards, plus two SHOP-ONLY animated frames (phase 2)
            that follow the same ticket/cUSD buy path as the other cosmetics. */}
        <h3 style={{ marginTop: 16 }}>{t('framesTitle')}</h3>
        <div className="framegrid">
          {FRAMES.map((f) => {
            // Catalog lookup MUST be kind-gated: the id namespace is shared with
            // dice skins ('gold' is both a die and a frame), so a bare
            // PREMIUM_SKINS[f.id] would price the progression frame as the die.
            const item = cosmeticById(f.id);
            const price = item?.kind === 'frame' ? item.tickets : undefined;
            const owned = item?.kind === 'frame' && ownedSkins.includes(f.id);
            const unlocked = devAll || owned || (price === undefined && f.unlocked(ctx));
            const equipped = f.id === avatarFrame;
            const ticketAffordable = !unlocked && price !== undefined && tickets >= price;
            const cusd = item?.kind === 'frame' ? item.cents : 0;
            const cusdBuyable = cosmeticsCusdAvailable && cusd > 0 && !unlocked;
            const purchasable = !unlocked && (price !== undefined || cusdBuyable);
            const onClick = unlocked
              ? () => dispatch({ type: 'EQUIP_FRAME', id: f.id })
              : purchasable
                ? () => setBuyingId(f.id)
                : undefined;
            return (
              <button
                key={f.id}
                className={`frametile${equipped ? ' frametile--on' : ''}${unlocked ? '' : ' frametile--locked'}`}
                disabled={!unlocked && !purchasable}
                onClick={onClick}
              >
                <span className={`frametile__ring ${frameClass(f.id)}`} aria-hidden="true">
                  {isPremiumFrame(f.id) && <PremiumFrame frame={f.id} />}
                </span>
                <b>{t(f.nameKey)}</b>
                <small>
                  {equipped
                    ? t('skinEquipped')
                    : unlocked
                      ? t('skinTap')
                      : price !== undefined
                        ? `${t('skinUnlock')} ${price} 🎟️${cusd > 0 ? ` · ${fmtUsd(cusd)}` : ''}`
                        : t(f.hintKey ?? 'skinSoon')}
                </small>
                {!unlocked && <span className="skin__lock">{price !== undefined ? '🎟️' : '🔒'}</span>}
              </button>
            );
          })}
        </div>

        <CloseHint onClose={close} />
      </div>
      {buyingId && (
        <PurchaseSheet
          id={buyingId}
          tickets={tickets}
          onClose={() => setBuyingId(null)}
          onBuy={onBuy}
          onBuyCusd={onBuyCusd}
        />
      )}
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
          {[...AVATAR_ORIGINALS, ...AVATAR_FACES, ...AVATAR_CHARACTERS].map((id) => (
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
  const openHowTo = (): void => {
    close();
    dispatch({ type: 'HOWTO_MODAL', open: true });
  };
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card help__card" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>{t('helpTitle')}</h3>
        <div className="help__scroll">
          {/* Game rules first — the MiniPay testers' top ask. This sheet only
              covers the meta (tickets, season, money); the rules live in the
              dedicated How-to-play sheet. */}
          <section className="help__sec">
            <h4>🎮 {t('howToTitle')}</h4>
            <p><a className="help__link" onClick={openHowTo}>{t('howToTitle')} →</a></p>
          </section>
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
