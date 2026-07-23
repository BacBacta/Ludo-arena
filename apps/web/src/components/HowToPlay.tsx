/**
 * "How to play" rules sheet — the MiniPay testers' #1 feedback was "I don't
 * understand how gameplay works". Our 1v1 is a BLITZ variant (2 pawns, 15s
 * clock, auto-play, timeout forfeit) that deviates from the classic Ludo
 * people know, and none of those deviations were explained anywhere. In a
 * real-money game an unexplained auto-forfeit reads as theft, so this sheet
 * auto-opens once on a fresh install (before any game) and stays reachable
 * from the lobby footer and the Help sheet.
 *
 * The rules text mirrors the ENGINE (packages/game-engine BLITZ config +
 * engine.ts), not generic Ludo: exit on 6; extra roll on a 6, a capture or a
 * finished pawn; three 6s lose the turn; safe stars + protected pairs; exact
 * finish; 15s auto-play; 3 missed turns forfeit.
 */
import { useAppDispatch, useAppState } from '../state/store';
import { useFocusTrap } from './useFocusTrap';
import { playTap } from '../lib/sound';
import { t } from '../lib/i18n';

/** One-shot first-run flag: the sheet auto-opens until it has been seen once. */
const HOWTO_SEEN_KEY = 'ludo.howto.v1';

export function howToSeen(): boolean {
  try {
    return localStorage.getItem(HOWTO_SEEN_KEY) === '1';
  } catch {
    return true; // storage unavailable → never auto-open (avoid a nag loop)
  }
}

function markHowToSeen(): void {
  try {
    localStorage.setItem(HOWTO_SEEN_KEY, '1');
  } catch {
    /* best effort */
  }
}

const SECTIONS: Array<{ icon: string; title: 'htPawns' | 'htDice' | 'htCapture' | 'htFinish' | 'htClock'; body: 'htPawnsBody' | 'htDiceBody' | 'htCaptureBody' | 'htFinishBody' | 'htClockBody' }> = [
  { icon: '🔵', title: 'htPawns', body: 'htPawnsBody' },
  { icon: '🎲', title: 'htDice', body: 'htDiceBody' },
  { icon: '⭐', title: 'htCapture', body: 'htCaptureBody' },
  { icon: '🎯', title: 'htFinish', body: 'htFinishBody' },
  { icon: '⏱️', title: 'htClock', body: 'htClockBody' },
];

export function HowToPlayModal({ onPractice }: {
  /** Launch an instant free practice game (local bot 1v1 — the same Blitz
   *  board staked games use). Shown as the primary CTA before the first game. */
  onPractice(): void;
}) {
  const { howToOpen, profile } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => {
    markHowToSeen();
    dispatch({ type: 'HOWTO_MODAL', open: false });
  };
  const trapRef = useFocusTrap<HTMLDivElement>(howToOpen, close);
  if (!howToOpen) return null;
  // Practice is the primary CTA only while it teaches something (no games yet).
  const firstRun = profile.games === 0;
  return (
    <div className="modal" onClick={close}>
      <div className="modal__card help__card howto__card" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('howToTitle')} onClick={(e) => e.stopPropagation()}>
        <h3>🎮 {t('howToTitle')}</h3>
        <div className="help__scroll">
          {SECTIONS.map((s) => (
            <section className="help__sec" key={s.title}>
              <h4>{s.icon} {t(s.title)}</h4>
              <p>{t(s.body)}</p>
            </section>
          ))}
        </div>
        <div className="howto__actions">
          {firstRun && (
            <button
              className="btn howto__practice"
              onClick={() => {
                playTap();
                close();
                onPractice();
              }}
            >
              🤖 {t('htPractice')}
            </button>
          )}
          <button className={firstRun ? 'btn btn--ghost' : 'btn'} onClick={() => { playTap(); close(); }}>
            {t('htGotIt')}
          </button>
        </div>
      </div>
    </div>
  );
}
