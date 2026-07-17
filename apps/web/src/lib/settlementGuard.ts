/**
 * Escrow concordance guard (G-2). The server resolves the escrow it will settle
 * against from a Fly secret; the client resolves the escrow it DEPOSITS into from
 * a copy vendored into this bundle. A redeploy that updates one but not the other
 * would send a real stake to an escrow the server never settles — the funds would
 * sit there until the contract's 24 h refundActive.
 *
 * The server advertises its settlement contracts in hello.ok; we record them here
 * and check them at the point of no return (right before locking a stake). A
 * mismatch throws, so the deposit never happens.
 */
import type { SettlementContracts } from '@ludo/shared';

let serverContracts: SettlementContracts | null = null;

/** Record the settlement contracts the server advertised in hello.ok. Called on
 *  every hello.ok (fresh + resume) so the guard always reflects the live server. */
export function setServerContracts(c: SettlementContracts | undefined): void {
  serverContracts = c ?? null;
}

export function getServerContracts(): SettlementContracts | null {
  return serverContracts;
}

/**
 * Throw unless the escrow we are about to deposit into is exactly the one the
 * server will settle against, on the same chain. Called from lockStake/lockStake4
 * before any token moves.
 */
export function assertServerEscrow(chainId: number, escrow: string, variant: '1v1' | '4p'): void {
  const c = serverContracts;
  // No advertised contracts → settlement is not armed (or an old server). Never
  // deposit real funds we cannot confirm the server settles.
  if (!c) {
    throw new Error('Staking unavailable: the server has not confirmed a settlement contract.');
  }
  if (c.chainId !== chainId) {
    throw new Error(`Chain mismatch: the server settles on chain ${c.chainId}, but the wallet is on ${chainId}.`);
  }
  const expected = variant === '4p' ? c.escrowN : c.escrow;
  if (!expected) {
    throw new Error(`Staking unavailable: the server has no ${variant} settlement contract configured.`);
  }
  if (expected.toLowerCase() !== escrow.toLowerCase()) {
    throw new Error(
      `Escrow mismatch (${variant}): the app would deposit into ${escrow} but the server settles ${expected}. Please update the app.`,
    );
  }
}
