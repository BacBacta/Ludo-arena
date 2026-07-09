const K = 32;

/** Retourne le delta ELO du gagnant (le perdant reçoit l'opposé). */
export function eloDelta(winnerElo: number, loserElo: number): number {
  const expected = 1 / (1 + 10 ** ((loserElo - winnerElo) / 400));
  return Math.round(K * (1 - expected));
}
