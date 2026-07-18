/**
 * Deterministic replay (Phase 4). Re-drives the PURE engine with a recorded game's
 * dice + move sequence and reproduces the exact state path OFFLINE. Used to (a)
 * prove a recorded game is engine-consistent (replay reaches the same winner +
 * final board the server produced) and (b) reproduce any invariant violation from
 * a simulation/out/fail-*.json for conversion into a regression test.
 *
 * Run with tsx (imports the TS engine):
 *   npx tsx simulation/replay.mjs                 # self-check: record 1 game, replay, assert identical
 *   npx tsx simulation/replay.mjs out/fail-42.json  # replay a recorded failure
 */
import { newGame, applyRoll, applyMove } from '../packages/game-engine/src/index.js';
import { checkState, checkMove, checkCapture } from './invariants.mjs';
import { readFileSync } from 'node:fs';

/**
 * Replay a 2p game record through the engine. At each awaiting-move the server
 * auto-plays a SINGLE legal move (not recorded) and the bot chooses a MULTI move
 * (recorded, consumed in order) — so this reconstructs the identical path.
 */
export function replay2p(rec) {
  let g = newGame();
  const dice = rec.dice ?? [];
  const moves = [...(rec.moves ?? [])];
  const violations = [];
  let prev = null;
  let di = 0;
  let guard = 0;

  while (g.phase !== 'over' && guard++ < 20000 && di < dice.length) {
    const die = dice[di++].value;
    g = applyRoll(g, die);
    const v1 = checkState(g, 2, prev);
    if (v1) violations.push({ step: di, phase: 'roll', reason: v1 });
    if (g.phase === 'awaiting-move') {
      const seat = g.turn;
      const before = g;
      const token = g.legal.length === 1 ? g.legal[0] : (moves.shift()?.token ?? g.legal[0]);
      const r = applyMove(g, token);
      const mv = checkMove(before, r.state, seat, token, die);
      if (mv) violations.push({ step: di, phase: 'move', reason: mv });
      const cv = checkCapture(before, r.state, seat, r.events.capture);
      if (cv) violations.push({ step: di, phase: 'capture', reason: cv });
      g = r.state;
      const v2 = checkState(g, 2, prev);
      if (v2) violations.push({ step: di, phase: 'post-move', reason: v2 });
    }
    prev = g;
  }
  return { finalPositions: g.positions, winner: g.winner, over: g.phase === 'over', diceConsumed: di, violations };
}

/** True when the engine replay reproduces the server-recorded outcome. */
export function matchesRecorded(rec, replayed) {
  if (rec.winner != null && replayed.winner !== rec.winner) return false;
  if (rec.finalPositions && JSON.stringify(replayed.finalPositions) !== JSON.stringify(rec.finalPositions)) return false;
  return true;
}

async function selfCheck() {
  // Record ONE fresh game over the real WS, then replay it through the engine and
  // assert the offline replay reproduces the server's winner + final board.
  const { playRationalGame } = await import('./rational.mjs');
  const rec = await playRationalGame(999999, 'advanced', 'random');
  if (!rec.over) {
    console.log('[replay] self-check inconclusive (game did not finish):', rec.crash || rec.zombie);
    process.exit(2);
  }
  const replayed = replay2p(rec);
  const ok = replayed.over && replayed.violations.length === 0 && matchesRecorded(rec, replayed);
  console.log(`[replay] self-check: server winner=${rec.winner} · engine-replay winner=${replayed.winner} · dice=${rec.dice.length} · moves=${rec.moves.length}`);
  console.log(`[replay] engine replay ${ok ? 'REPRODUCED the game deterministically ✅' : 'DIVERGED ❌'}${replayed.violations.length ? ` — violations: ${JSON.stringify(replayed.violations)}` : ''}`);
  process.exit(ok ? 0 : 1);
}

function replayFile(path) {
  const rec = JSON.parse(readFileSync(path, 'utf8'));
  const replayed = replay2p(rec);
  console.log(`[replay] ${path}: over=${replayed.over} winner=${replayed.winner} violations=${replayed.violations.length}`);
  if (replayed.violations.length) console.log(JSON.stringify(replayed.violations, null, 1));
  console.log(replayed.violations.length ? '→ violation REPRODUCED offline: an engine-level bug — convert to a regression test.' : '→ no engine violation on replay: the live anomaly was protocol/timing, not an engine bug.');
  process.exit(replayed.violations.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (arg) replayFile(arg);
  else void selfCheck();
}
