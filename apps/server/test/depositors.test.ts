import { describe, expect, it } from 'vitest';
import { sameDepositors } from '../src/depositors.js';

// R-SETTLE-3 / G-4: the stake gate voids a game whose on-chain depositors are not
// exactly the matched players. sameDepositors is the comparison it turns on, for
// both 1v1 and 4p — so its edge cases (case, order, length, a squatter) matter.

const A = '0xAAaAaA0000000000000000000000000000000001';
const B = '0xbBbBbB0000000000000000000000000000000002';
const C = '0xCcCcCc0000000000000000000000000000000003';
const D = '0xDddDdd0000000000000000000000000000000004';
const X = '0xeEeEeE0000000000000000000000000000000005'; // a squatter

describe('sameDepositors (stake-gate depositor check)', () => {
  it('matches the same set regardless of order', () => {
    expect(sameDepositors([A, B], [B, A])).toBe(true);
    expect(sameDepositors([A, B, C, D], [D, C, B, A])).toBe(true);
  });

  it('matches case-insensitively (EVM addresses are)', () => {
    expect(sameDepositors([A.toLowerCase()], [A.toUpperCase().replace('0X', '0x')])).toBe(true);
    expect(sameDepositors([A, B], [B.toLowerCase(), A.toUpperCase().replace('0X', '0x')])).toBe(true);
  });

  it('rejects a squatter who funded a seat (the attack G-4 blocks)', () => {
    // 4 matched players, but on-chain one seat is X (a party who learned the gameId)
    expect(sameDepositors([A, B, C, D], [A, B, C, X])).toBe(false);
    // 1v1: opponent seat funded by someone else
    expect(sameDepositors([A, B], [A, X])).toBe(false);
  });

  it('rejects a length mismatch (missing or extra depositor)', () => {
    expect(sameDepositors([A, B, C, D], [A, B, C])).toBe(false);
    expect(sameDepositors([A, B], [A, B, C])).toBe(false);
    expect(sameDepositors([], [A])).toBe(false);
  });

  it('does not treat a duplicate as a full set (two seats, one address twice)', () => {
    // on-chain shows A twice, expected is A + B → must NOT match
    expect(sameDepositors([A, B], [A, A])).toBe(false);
  });

  it('matches the trivial equal case', () => {
    expect(sameDepositors([A, B, C, D], [A, B, C, D])).toBe(true);
  });
});
