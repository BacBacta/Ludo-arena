/**
 * Géométrie du plateau — UNIQUE source de vérité (le SVG du frontend est généré depuis ce fichier).
 * Grille 15×15. Piste principale de 52 cases, sens horaire.
 */
export const TRACK: ReadonlyArray<readonly [number, number]> = [
  [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
  [6, 5], [6, 4], [6, 3], [6, 2], [6, 1], [6, 0],
  [7, 0],
  [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
  [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6],
  [14, 7],
  [14, 8], [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
  [8, 9], [8, 10], [8, 11], [8, 12], [8, 13], [8, 14],
  [7, 14],
  [6, 14], [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
  [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  [0, 7], [0, 6],
];

export const TRACK_LEN = 52;

/** Index absolus des cases sûres (étoiles + cases départ). Pas de capture possible dessus. */
export const SAFE_CELLS: ReadonlySet<number> = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

/**
 * Positions relatives d'un pion :
 *  -1            : en base
 *  0..50         : sur la piste (51 cases parcourues, relatives au départ du siège)
 *  51..55        : colonne maison (5 cases)
 *  56 (FINISHED) : arrivé au centre
 */
export const LAST_TRACK_REL = 50;
export const FIRST_HOME_REL = 51;
export const FINISHED = 56;

/** Case de départ absolue par siège (Blitz 1v1 : sièges diagonalement opposés). */
export const SEAT_START: readonly number[] = [0, 26];

/** Colonnes maison par siège (coordonnées grille, de l'entrée vers le centre). */
export const HOME_COLUMNS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
];

/** Emplacements des pions en base (coordonnées grille, centres). */
export const BASE_SPOTS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[2.5, 11.5], [4.5, 11.5]],
  [[10.5, 2.5], [12.5, 2.5]],
];

/** Config Blitz par défaut. */
export const BLITZ = {
  tokensPerPlayer: 2,
  /** Le pion 0 démarre posé sur la case départ (accélère la partie). */
  firstTokenStartsOnBoard: true,
  /** Dépassement autorisé pour finir (pas de dé exact requis). */
  allowOvershootFinish: true,
  /** ms par décision avant auto-move. */
  moveClockMs: 15_000,
  /** auto-moves consécutifs avant forfait. */
  forfeitAfterAutoMoves: 3,
} as const;
