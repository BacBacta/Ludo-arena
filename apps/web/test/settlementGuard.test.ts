import { afterEach, describe, expect, it } from 'vitest';
import { assertServerEscrow, getServerContracts, setServerContracts } from '../src/lib/settlementGuard';

// G-2: the client must refuse to deposit into an escrow the server will not settle.
// The server advertises its settlement contracts in hello.ok; assertServerEscrow is
// called at the point of no return (right before locking a stake).

const CHAIN = 11_142_220; // Celo Sepolia
const ESCROW = '0xAaAaAAaAAAAaAAAAAAaaAAaAAaaAaAaAaAAaAaA1';
const ESCROW_N = '0xBbBbBBbBBBBbBBBBBBbbBBbBBbbBbBbBbBBbBbB2';

afterEach(() => setServerContracts(undefined));

describe('assertServerEscrow (G-2 escrow concordance)', () => {
  it('passes when the escrow and chain match (case-insensitively)', () => {
    setServerContracts({ chainId: CHAIN, escrow: ESCROW.toLowerCase(), escrowN: ESCROW_N.toLowerCase() });
    expect(() => assertServerEscrow(CHAIN, ESCROW, '1v1')).not.toThrow();
    expect(() => assertServerEscrow(CHAIN, ESCROW_N, '4p')).not.toThrow();
    // the deposit address may arrive in any case; comparison is lowercased
    expect(() => assertServerEscrow(CHAIN, ESCROW.toUpperCase().replace('0X', '0x'), '1v1')).not.toThrow();
  });

  it('throws when the escrow address differs (the drift G-2 is about)', () => {
    setServerContracts({ chainId: CHAIN, escrow: ESCROW.toLowerCase() });
    const other = '0xCcCcCCcCCCCcCCCCCCccCCcCCccCcCcCcCCcCcC3';
    expect(() => assertServerEscrow(CHAIN, other, '1v1')).toThrow(/mismatch/i);
  });

  it('throws when the wallet chain differs from the settlement chain', () => {
    setServerContracts({ chainId: CHAIN, escrow: ESCROW.toLowerCase() });
    expect(() => assertServerEscrow(42_220, ESCROW, '1v1')).toThrow(/chain/i);
  });

  it('throws when the server advertised no contracts at all (settlement not armed)', () => {
    setServerContracts(undefined);
    expect(() => assertServerEscrow(CHAIN, ESCROW, '1v1')).toThrow(/unavailable|not confirmed/i);
  });

  it('throws for a 4p deposit when the server has no N-player escrow', () => {
    setServerContracts({ chainId: CHAIN, escrow: ESCROW.toLowerCase() }); // no escrowN
    expect(() => assertServerEscrow(CHAIN, ESCROW_N, '4p')).toThrow(/no 4p|unavailable/i);
  });

  it('setServerContracts stores and clears', () => {
    setServerContracts({ chainId: CHAIN, escrow: ESCROW });
    expect(getServerContracts()?.chainId).toBe(CHAIN);
    setServerContracts(undefined);
    expect(getServerContracts()).toBeNull();
  });
});
