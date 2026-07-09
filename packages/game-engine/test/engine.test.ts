import { describe, expect, it } from 'vitest';
import {
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

describe('geometry', () => {
  it('the track has 52 unique cells', () => {
    expect(TRACK.length).toBe(TRACK_LEN);
    expect(new Set(TRACK.map(([x, y]) => `${x},${y}`)).size).toBe(TRACK_LEN);
  });
  it('both seat start cells are safe', () => {
    expect(SAFE_CELLS.has(SEAT_START[0]!)).toBe(true);
    expect(SAFE_CELLS.has(SEAT_START[1]!)).toBe(true);
  });
});

describe('newGame', () => {
  it('token 0 on the start cell, token 1 in base', () => {
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
  it('without a 6, the base token cannot exit', () => {
    const g = newGame();
    expect(legalMoves(g, 0, 3)).toEqual([0]);
    expect(legalMoves(g, 0, 6)).toEqual([0, 1]);
  });
  it('a finished token is no longer playable', () => {
    const g: GameState = { ...newGame(), positions: [[FINISHED, 4], [0, -1]] };
    expect(legalMoves(g, 0, 2)).toEqual([1]);
  });
});

describe('applyRoll / applyMove', () => {
  it('advances by the die value', () => {
    let g = newGame();
    g = applyRoll(g, 4);
    const { state } = applyMove(g, 0);
    expect(state.positions[0]![0]).toBe(4);
    expect(state.turn).toBe(1); // not a 6 -> turn passes
  });
  it('6 = roll again', () => {
    let g = newGame();
    g = applyRoll(g, 6);
    const { state, events } = applyMove(g, 0);
    expect(events.extraTurn).toBe(true);
    expect(state.turn).toBe(0);
  });
  it('capture sends the opponent token back to base and grants another turn', () => {
    // seat 0 at rel 3 (abs 3); seat 1: abs 3 = rel (3 - 26 + 52) % 52 = 29
    let g: GameState = {
      ...newGame(),
      positions: [
        [1, -1],
        [29, -1],
      ],
    };
    g = applyRoll(g, 2); // 1 + 2 = rel 3 -> abs 3, not safe
    const { state, events } = applyMove(g, 0);
    expect(events.capture).toBe(true);
    expect(state.positions[1]![0]).toBe(-1);
    expect(state.turn).toBe(0);
  });
  it('no capture on a safe cell', () => {
    // abs 8 is safe. seat 0 rel 8; seat 1: abs 8 = rel (8-26+52)%52 = 34
    let g: GameState = {
      ...newGame(),
      positions: [
        [6, -1],
        [34, -1],
      ],
    };
    g = applyRoll(g, 2); // rel 8 -> abs 8 (safe)
    const { events } = applyMove(g, 0);
    expect(events.capture).toBe(false);
  });
  it('overshoot allowed: reaches FINISHED', () => {
    let g: GameState = { ...newGame(), positions: [[54, FINISHED], [0, -1]] };
    g = applyRoll(g, 6); // 54 + 6 = 60 -> clamped to FINISHED
    const { state, events } = applyMove(g, 0);
    expect(state.positions[0]![0]).toBe(FINISHED);
    expect(events.won).toBe(true);
    expect(state.winner).toBe(0);
    expect(state.phase).toBe('over');
  });
  it('no possible move -> the turn passes', () => {
    const g: GameState = { ...newGame(), positions: [[-1, -1], [0, -1]] };
    const next = applyRoll(g, 3); // needs a 6 to exit
    expect(next.turn).toBe(1);
    expect(next.phase).toBe('awaiting-roll');
  });
  it('illegal move rejected', () => {
    let g = newGame();
    g = applyRoll(g, 3);
    expect(() => applyMove(g, 1)).toThrow(/ILLEGAL_MOVE/);
  });
});

describe('pickAutoMove', () => {
  it('prefers finishing', () => {
    const g: GameState = { ...newGame(), positions: [[52, 10], [0, -1]] };
    expect(pickAutoMove(g, 0, 5)).toBe(0);
  });
  it('prefers capturing otherwise', () => {
    // seat 0: token 0 rel 1 -> +2 = abs 3 where seat 1 (rel 29) is capturable
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

describe('immutability', () => {
  it('applyMove does not mutate the input state', () => {
    let g = newGame();
    g = applyRoll(g, 4);
    const snapshot = JSON.stringify(g);
    applyMove(g, 0);
    expect(JSON.stringify(g)).toBe(snapshot);
  });
});
