import { describe, expect, it } from 'vitest';

// THE BUG, reported as: "I try to mint with a NEW address and it answers
// already funded". The address (0x743bB002…) was verified on-chain to hold
// 0 cUSD and 0 CELO — it had never received anything, so neither branch of
// race.claim's alreadyFunded could legitimately fire FOR IT. The server was not
// looking at that address at all.
//
// `resumeSession` reconciles the wallet on the IN-MEMORY branch:
//
//     const existing = sessions.get(token);
//     if (existing) {
//       if (!inGame && !walletsMatch(existing.wallet, wallet)) return null;  // ✅
//
// …and did NOT on the DURABLE branch:
//
//     const rec = await store.loadSession(token);
//     const session = makeSession(rec.id, ws, rec);   // ❌ wallet := rec.wallet
//
// The durable branch is the one that runs after every restart — the in-memory
// map is empty then, so EVERY returning client lands on it. A player who
// switched wallets was resumed onto the PREVIOUS address, so race.seed and
// race.claim keyed on the OLD wallet: the new address got nothing, and the old
// wallet's grant record answered "already funded" on its behalf, permanently.
//
// It also defeated the guard the in-memory branch documents: a stale
// wallet-less token could resume a now-wallet-backed client as
// walletBacked=false and pair a real-money player against a demo opponent.

function walletsMatch(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '') === (b ?? '');
}

/** The durable-branch decision: may this stored record answer for `wallet`? */
function mayResumeStored(rec: { wallet?: string; gameId?: string | null }, wallet: string | undefined): boolean {
  if (!walletsMatch(rec.wallet, wallet) && !rec.gameId) return false;
  return true;
}

const OLD = '0x1111111111111111111111111111111111111111';
const NEW = '0x743bB002B6f925442BE7F6AE0a3F9D56Ed15cD7B';

describe('a stored session must not answer for a different wallet', () => {
  it('REFUSES the resume when the client switched address (the reported bug)', () => {
    expect(mayResumeStored({ wallet: OLD, gameId: null }, NEW)).toBe(false);
  });

  it('allows it for the same address', () => {
    expect(mayResumeStored({ wallet: OLD, gameId: null }, OLD)).toBe(true);
  });

  it('REFUSES a wallet-less record for a now-wallet-backed client', () => {
    // The money-mode hazard: resuming here keeps walletBacked=false and can seat
    // a real staker opposite a demo opponent.
    expect(mayResumeStored({ wallet: undefined, gameId: null }, NEW)).toBe(false);
  });

  it('REFUSES a wallet-backed record for a now-anonymous client', () => {
    expect(mayResumeStored({ wallet: OLD, gameId: null }, undefined)).toBe(false);
  });

  it('allows an anonymous record for an anonymous client', () => {
    expect(mayResumeStored({ wallet: undefined, gameId: null }, undefined)).toBe(true);
  });
});

describe('mid-game is the one exception', () => {
  it('a live game resumes even on a wallet mismatch — refusing would strand the room', () => {
    expect(mayResumeStored({ wallet: OLD, gameId: 'g1' }, NEW)).toBe(true);
  });

  it('…but a FINISHED record (no gameId) never gets that pass', () => {
    expect(mayResumeStored({ wallet: OLD, gameId: null }, NEW)).toBe(false);
    expect(mayResumeStored({ wallet: OLD }, NEW)).toBe(false);
  });
});

describe('the two branches now agree', () => {
  // The in-memory rule, transcribed. The durable rule must not be laxer: the
  // durable one runs after a restart, i.e. for everybody.
  const mayResumeInMemory = (existing: { wallet?: string }, inGame: boolean, wallet: string | undefined): boolean =>
    inGame || walletsMatch(existing.wallet, wallet);

  it('agree on every wallet combination when no game is live', () => {
    const wallets: Array<string | undefined> = [undefined, OLD, NEW];
    for (const stored of wallets) {
      for (const incoming of wallets) {
        expect(mayResumeStored({ wallet: stored, gameId: null }, incoming)).toBe(
          mayResumeInMemory({ wallet: stored }, false, incoming),
        );
      }
    }
  });

  it('agree that a live game always resumes', () => {
    expect(mayResumeStored({ wallet: OLD, gameId: 'g1' }, NEW)).toBe(mayResumeInMemory({ wallet: OLD }, true, NEW));
  });
});
