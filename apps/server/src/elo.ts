const K = 32;

/** Returns the winner's ELO delta (the loser receives the opposite). */
export function eloDelta(winnerElo: number, loserElo: number): number {
  const expected = 1 / (1 + 10 ** ((loserElo - winnerElo) / 400));
  return Math.round(K * (1 - expected));
}
