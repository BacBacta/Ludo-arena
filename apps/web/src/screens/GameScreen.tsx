import { fmtCents, useAppDispatch, useAppState } from '../state/store';
import { Board } from '../components/Board';
import { t } from '../lib/i18n';

const DICE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'] as const;

export function GameScreen({ onRoll, onMove }: { onRoll(): void; onMove(token: number): void }) {
  const { game, match, lastDice } = useAppState();
  const dispatch = useAppDispatch();
  if (!game || !match) return null;

  const mySeat = match.seat;
  const myTurn = game.turn === mySeat;
  const canRoll = myTurn && game.phase === 'awaiting-roll';
  const needPick = myTurn && game.phase === 'awaiting-move' && game.legal.length > 1;

  const message = needPick
    ? `🎲 ${lastDice?.value ?? ''} — ${t('pickToken')}`
    : myTurn
      ? t('yourTurn')
      : `${match.opponent.name} ${t('oppTurn')}`;

  return (
    <div className="screen">
      <div className="hud">
        <div className={`player${game.turn === mySeat ? ' player--turn' : ''}`}>
          <div className="player__chip" style={{ background: 'var(--me)' }}>
            🟢
          </div>
          {t('you')}
        </div>
        <div className="pot">
          {match.stakeCents > 0 ? `${t('pot')} ${fmtCents(match.potCents)} $` : t('training')}
        </div>
        <div className={`player${game.turn !== mySeat ? ' player--turn' : ''}`}>
          <div className="player__chip" style={{ background: 'var(--opp)' }}>
            🟠
          </div>
          {match.opponent.name}
        </div>
      </div>

      <Board game={game} mySeat={mySeat} onTokenTap={onMove} />

      <div className="controls">
        <button className="dicebtn" disabled={!canRoll} onClick={onRoll}>
          {lastDice && !canRoll ? DICE_FACES[lastDice.value] : '🎲'}
        </button>
        <div className="gamemsg">
          <span>{message}</span>
          <small>
            Lancer #{lastDice?.index ?? 0} · commit {match.fairnessCommit.slice(0, 10)}… ·{' '}
            <a onClick={() => dispatch({ type: 'FAIR_MODAL', open: true })}>{t('verify')}</a>
          </small>
        </div>
      </div>
    </div>
  );
}
