/** Race Week leaderboard sheet — the event standings, dressed as an event:
 *  checkered header, a real podium for the top 3 (winner centre, raised),
 *  staggered row animations for the chasing pack, skeleton rows while the
 *  board loads, and a play CTA when the caller is funded (the sheet should
 *  CREATE games, not just display rank). Board data is fetched over a
 *  one-shot socket (App.openRaceBoard → RACE_BOARD) and read from the store. */
import { useFocusTrap } from './useFocusTrap';
import { fmtUsd, useAppDispatch, useAppState } from '../state/store';
import { playTap } from '../lib/sound';
import { t } from '../lib/i18n';

export function RaceSheet({ onPlay }: { onPlay?: () => void }) {
  const { raceOpen, raceBoard, race } = useAppState();
  const dispatch = useAppDispatch();
  const close = (): void => void dispatch({ type: 'RACE_MODAL', open: false });
  const trapRef = useFocusTrap<HTMLDivElement>(raceOpen, close);
  if (!raceOpen) return null;

  const board = raceBoard;
  const top3 = board?.top.slice(0, 3) ?? [];
  const rest = board?.top.slice(3) ?? [];
  // Winner centre stage: render order 2nd · 1st · 3rd (classic podium layout).
  const podiumOrder = [top3[1], top3[0], top3[2]].filter(Boolean) as NonNullable<typeof top3[0]>[];
  const medalFor = (rank: number): string => (rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉');
  const myInTop = board ? board.top.some((r) => r.rank === board.myRank) : false;

  return (
    <div className="modal" onClick={close}>
      <div className="modal__card racesheet" ref={trapRef} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {/* Checkered event header */}
        <div className="racesheet__banner" aria-hidden="true" />
        <h3 className="racesheet__title">🏁 {t('raceBoardTitle')}</h3>
        <div className="racesheet__chips">
          <span className="racechip racechip--live">● {t('raceLiveBadge')}</span>
          {/* The prize pool, front and centre on the standings too — the number
              players are racing for should never be more than a glance away. */}
          {race?.poolCents ? (
            <span className="racechip racechip--pool">💰 {fmtUsd(race.poolLeftCents)} / {fmtUsd(race.poolCents)}</span>
          ) : null}
          <span className="racechip">{t('raceScoring')}</span>
        </div>

        <div className="racesheet__scroll">
          {board === null ? (
            // Skeleton: the sheet keeps its shape while the one-shot resolves.
            <div className="raceskel" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="raceskel__row" style={{ '--i': i } as React.CSSProperties}>
                  <span className="raceskel__rank" />
                  <span className="raceskel__name" />
                  <span className="raceskel__pts" />
                </div>
              ))}
            </div>
          ) : board.top.length === 0 ? (
            <div className="raceempty">
              <span className="raceempty__flag" aria-hidden="true">🏁</span>
              <b>{t('raceBoardEmpty')}</b>
              {race?.funded && onPlay && (
                <button className="btn btn--race btn--race-play raceempty__cta" onClick={() => { playTap('select'); close(); onPlay(); }}>
                  🎲 {t('racePlayCta')}
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Podium — winner centre, raised; blocks sized by rank. */}
              <div className="podium">
                {podiumOrder.map((r) => (
                  <div key={r.rank} className={`podium__col podium__col--${r.rank}${r.rank === board.myRank ? ' podium__col--me' : ''}`}>
                    {r.rank === 1 && <span className="podium__crown" aria-hidden="true">👑</span>}
                    <span className="podium__medal" aria-hidden="true">{medalFor(r.rank)}</span>
                    <b className="podium__name">{r.name}</b>
                    <span className="podium__pts">{r.points} {t('racePoints')}</span>
                    <span className="podium__block" aria-hidden="true">{r.rank}</span>
                  </div>
                ))}
              </div>

              {/* Chasing pack (4+), staggered in like the friends rows. */}
              {rest.length > 0 && (
                <ol className="raceboard">
                  {rest.map((r, i) => (
                    <li key={r.rank} className={`racerow racerow--anim${r.rank === board.myRank ? ' racerow--me' : ''}`} style={{ '--i': i } as React.CSSProperties}>
                      <span className="racerow__rank">#{r.rank}</span>
                      <span className="racerow__name">{r.name}{r.rank === board.myRank && <em className="racerow__you">{t('raceYou')}</em>}</span>
                      <span className="racerow__pts">{r.points} {t('racePoints')}</span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>

        {/* My standing when ranked but outside the visible top list. */}
        {board && board.myRank > 0 && !myInTop && (
          <div className="racerow racerow--me racerow--sticky">
            <span className="racerow__rank">#{board.myRank}</span>
            <span className="racerow__name">{t('raceYou')}</span>
            <span className="racerow__pts">{board.myPoints} {t('racePoints')}</span>
          </div>
        )}

        {/* The sheet creates games: funded players can launch straight from here. */}
        {race?.funded && onPlay && board !== null && board.top.length > 0 && (
          <button className="btn btn--race btn--race-play racesheet__play" onClick={() => { playTap('select'); close(); onPlay(); }}>
            🎲 {t('racePlayCta')} <small>{t('racePlaySub')}</small>
          </button>
        )}

        <button className="closehint" onClick={close}>{t('close')}</button>
      </div>
    </div>
  );
}
