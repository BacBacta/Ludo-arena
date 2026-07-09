import { describe, expect, it } from 'vitest';
import {
  absCell,
  applyMove,
  applyRoll,
  FINISHED,
  legalMoves,
  newGame,
  pickAutoMove,
  SAFE_CELLS,
  SEAT_START,
  TRACK,
  TRACK_LEN,
} from '../src/index.js';
import type { GameState } from '../src/index.js';

describe('géométrie', () => {
  it('la piste fait 52 cases uniques', () => {
    expect(TRACK.length).toBe(TRACK_LEN);
    expect(new Set(TRACK.map(([x, y]) => `${x},${y}`)).size).toBe(TRACK_LEN);
  });
  it('les départs des deux sièges sont des cases sûres', () => {
    expect(SAFE_CELLS.has(SEAT_START[0]!)).toBe(true);
    expect(SAFE_CELLS.has(SEAT_START[1]!)).toBe(true);
  });
});

describe('newGame', () => {
  it('pion 0 sur la case départ, pion 1 en base', () => {
    const g = newGame();
    expect(g.positions).toEqual([
      [0, -1],
      [0, -1],
    ]);
    expect(g.turn).toBe(0);
    expect(g.phase).toBe('awaiting-roll');
  });
});

describe('legalMoves', () => {
  it('sans 6, le pion en base ne peut pas sortir', () => {
    const g = newGame();
    expect(legalMoves(g, 0, 3)).toEqual([0]);
    expect(legalMoves(g, 0, 6)).toEqual([0, 1]);
  });
  it('un pion arrivé n’est plus jouable', () => {
    const g: GameState = { ...newGame(), positions: [[FINISHED, 4], [0, -1]] };
    expect(legalMoves(g, 0, 2)).toEqual([1]);
  });
});

describe('applyRoll / applyMove', () => {
  it('avance de la valeur du dé', () => {
    let g = newGame();
    g = applyRoll(g, 4);
    const { state } = applyMove(g, 0);
    expect(state.positions[0]![0]).toBe(4);
    expect(state.turn).toBe(1); // pas un 6 → tour passe
  });
  it('6 = rejoue', () => {
    let g = newGame();
    g = applyRoll(g, 6);
    const { state, events } = applyMove(g, 0);
    expect(events.extraTurn).toBe(true);
    expect(state.turn).toBe(0);
  });
  it('capture renvoie le pion adverse en base et fait rejouer', () => {
    // siège 0 en rel 3 (abs 3), siège 1 : abs 3 = rel (3 - 26 + 52) % 52 = 29
    let g: GameState = {
      ...newGame(),
      positions: [
        [1, -1],
        [29, -1],
      ],
    };
    g = applyRoll(g, 2); // 1 + 2 = rel 3 → abs 3, non sûre
    const { state, events } = applyMove(g, 0);
    expect(events.capture).toBe(true);
    expect(state.positions[1]![0]).toBe(-1);
    expect(state.turn).toBe(0);
  });
  it('pas de capture sur case sûre', () => {
    // abs 8 est sûre. siège 0 rel 8 ; siège 1 : abs 8 = rel (8-26+52)%52 = 34
    let g: GameState = {
      ...newGame(),
      positions: [
        [6, -1],
        [34, -1],
      ],
    };
    g = applyRoll(g, 2); // rel 8 → abs 8 (sûre)
    const { events } = applyMove(g, 0);
    expect(events.capture).toBe(false);
  });
  it('dépassement autorisé : atteint FINISHED', () => {
    let g: GameState = { ...newGame(), positions: [[54, FINISHED], [0, -1]] };
    g = applyRoll(g, 6); // 54 + 6 = 60 → clamp FINISHED
    const { state, events } = applyMove(g, 0);
    expect(state.positions[0]![0]).toBe(FINISHED);
    expect(events.won).toBe(true);
    expect(state.winner).toBe(0);
    expect(state.phase).toBe('over');
  });
  it('aucun coup possible → le tour passe', () => {
    const g: GameState = { ...newGame(), positions: [[-1, -1], [0, -1]] };
    const next = applyRoll(g, 3); // besoin d’un 6 pour sortir
    expect(next.turn).toBe(1);
    expect(next.phase).toBe('awaiting-roll');
  });
  it('coup illégal rejeté', () => {
    let g = newGame();
    g = applyRoll(g, 3);
    expect(() => applyMove(g, 1)).toThrow(/ILLEGAL_MOVE/);
  });
});

describe('pickAutoMove', () => {
  it('préfère finir', () => {
    const g: GameState = { ...newGame(), positions: [[52, 10], [0, -1]] };
    expect(pickAutoMove(g, 0, 5)).toBe(0);
  });
  it('préfère capturer sinon', () => {
    // siège 0 : pion 0 rel 1 → +2 = abs 3 où siège 1 (rel 29) est capturable
    const g: GameState = {
      ...newGame(),
      positions: [
        [1, 20],
        [29, -1],
      ],
    };
    expect(pickAutoMove(g, 0, 2)).toBe(0);
  });
});

describe('immutabilité', () => {
  it('applyMove ne mute pas l’état d’entrée', () => {
    let g = newGame();
    g = applyRoll(g, 4);
    const snapshot = JSON.stringify(g);
    applyMove(g, 0);
    expect(JSON.stringify(g)).toBe(snapshot);
  });
});
