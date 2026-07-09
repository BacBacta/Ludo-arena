/**
 * Simulation de masse : 2 000 parties avec coups aleatoires.
 * Garantit la terminaison et donne les stats de duree. Utilisee en CI.
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
      console.error('ECHEC: partie ' + i + ' non terminee apres ' + MAX_ROLLS + ' lancers');
      console.error(JSON.stringify(g));
      process.exit(1);
    }
    const die = 1 + Math.floor(Math.random() * 6);
    g = applyRoll(g, die);
    if (g.phase === 'awaiting-move') {
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
  'OK - ' + GAMES + ' parties terminees. Lancers moyens: ' + avg +
  ', max: ' + maxRolls + ', victoires: ' + wins[0] + '/' + wins[1],
);
