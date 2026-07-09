/**
 * Mass simulation: 2,000 games with random moves.
 * Guarantees termination and reports duration stats. Used in CI.
 */
import { applyMove, applyRoll, newGame, pickAutoMove } from '../src/index.js';
import type { GameState } from '../src/index.js';

const GAMES = 2_000;
const MAX_ROLLS = 3_000;

let totalRolls = 0;
let maxRolls = 0;
const wins = [0, 0];

for (let i = 0; i < GAMES; i++) {
  let g: GameState = newGame();
  while (g.phase !== 'over') {
    if (g.rollCount >= MAX_ROLLS) {
      console.error('FAIL: game ' + i + ' not finished after ' + MAX_ROLLS + ' rolls');
      console.error(JSON.stringify(g));
      process.exit(1);
    }
    const die = 1 + Math.floor(Math.random() * 6);
    g = applyRoll(g, die);
    if (g.phase === 'awaiting-move') {
      // 50% random move / 50% auto-move heuristic (covers both paths)
      const token =
        Math.random() < 0.5
          ? g.legal[Math.floor(Math.random() * g.legal.length)]!
          : (pickAutoMove(g, g.turn, die) ?? g.legal[0]!);
      g = applyMove(g, token).state;
    }
  }
  if (g.winner !== null) wins[g.winner] = (wins[g.winner] ?? 0) + 1;
  totalRolls += g.rollCount;
  maxRolls = Math.max(maxRolls, g.rollCount);
}

const avg = (totalRolls / GAMES).toFixed(1);
console.log(
  'OK - ' + GAMES + ' games finished. Avg rolls: ' + avg +
  ', max: ' + maxRolls + ', wins: ' + wins[0] + '/' + wins[1],
);
