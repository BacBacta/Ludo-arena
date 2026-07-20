/** Race Week leaderboard sheet — the event standings (top players + my rank).
 *  Opened from the lobby Race Week card; the board is fetched over a one-shot
 *  socket (App.openRaceBoard → RACE_BOARD) and read from the store here. */
import { useFocusTrap } from './useFocusTrap';
import { useAppDispatch, useAppState } from '../state/store';
import { t } from '../lib/i18n';

/** Podium marker for the top three, plain rank otherwise. */
function rankBadge(rank: number): string {
  return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
}

export function RaceSheet() {
  const { raceOpen, raceBoard, race } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'RACE_MODAL', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(raceOpen, close);
  if (!raceOpen) return null;

  const board = raceBoard;
  // My rank is only meaningful once I've scored (myRank > 0); until then, and
  // when I'm outside the visible top list, show a dedicated "you" row.
  const myInTop = board ? board.top.some((r) => r.rank === board.myRank) : false;

  return (
    <div className="modal" onClick={close}>
      <div className="modal__card racesheet" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>🏁 {t('raceBoardTitle')}</h3>
        <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>{t('raceBoardSub')}</p>

        {board === null ? (
          <p className="muted" style={{ textAlign: 'center', padding: '18px 0' }}>{t('raceBoardLoading')}</p>
        ) : board.top.length === 0 ? (
          <p className="muted" style={{ textAlign: 'center', padding: '18px 0' }}>{t('raceBoardEmpty')}</p>
        ) : (
          <ol className="raceboard">
            {board.top.map((r) => (
              <li key={r.rank} className={`racerow${r.rank === board.myRank ? ' racerow--me' : ''}`}>
                <span className="racerow__rank">{rankBadge(r.rank)}</span>
                <span className="racerow__name">{r.name}</span>
                <span className="racerow__pts">{r.points} {t('racePoints')}</span>
              </li>
            ))}
          </ol>
        )}

        {/* My standing when I'm ranked but off the visible top list. */}
        {board && board.myRank > 0 && !myInTop && (
          <div className="racerow racerow--me racerow--sticky">
            <span className="racerow__rank">#{board.myRank}</span>
            <span className="racerow__name">{t('raceYou')}</span>
            <span className="racerow__pts">{board.myPoints} {t('racePoints')}</span>
          </div>
        )}

        {race?.endsAt && (
          <p className="muted" style={{ fontSize: 11, marginTop: 10, textAlign: 'center' }}>
            {t('raceScoring')}
          </p>
        )}

        <button className="closehint" onClick={close}>{t('close')}</button>
      </div>
    </div>
  );
}
