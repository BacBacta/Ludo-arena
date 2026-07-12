import { describe, expect, it } from 'vitest';
import { getAddress, recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TOS_VERSION, parseClientMsg, walletProofMessage } from '@ludo/shared';

// A fixed, well-known test key (never used for real funds).
const TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(TEST_PK);

describe('wallet ownership proof (SIWE)', () => {
  it('a signature over the nonce recovers to the signer address', async () => {
    const nonce = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const signature = await account.signMessage({ message: walletProofMessage(nonce) });
    const recovered = await recoverMessageAddress({ message: walletProofMessage(nonce), signature });
    expect(getAddress(recovered)).toBe(getAddress(account.address));
  });

  it('rejects a signature made over a DIFFERENT nonce (no replay)', async () => {
    const signature = await account.signMessage({ message: walletProofMessage('nonce-A') });
    const recovered = await recoverMessageAddress({ message: walletProofMessage('nonce-B'), signature });
    expect(getAddress(recovered)).not.toBe(getAddress(account.address));
  });

  it('the message builder is deterministic and nonce-bound', () => {
    expect(walletProofMessage('x')).toBe(walletProofMessage('x'));
    expect(walletProofMessage('x')).not.toBe(walletProofMessage('y'));
    expect(walletProofMessage('n')).toContain('n');
  });
});

describe('protocol validation for the new auth fields', () => {
  it('accepts hello with a well-formed consent block', () => {
    const raw = JSON.stringify({ t: 'hello', entropyCommit: 'a'.repeat(64), consent: { tosVersion: TOS_VERSION, age18: true } });
    expect(parseClientMsg(raw)).not.toBeNull();
  });

  it('rejects hello with a malformed consent block', () => {
    const bad = JSON.stringify({ t: 'hello', entropyCommit: 'a'.repeat(64), consent: { tosVersion: 123, age18: 'yes' } });
    expect(parseClientMsg(bad)).toBeNull();
  });

  it('accepts hello with no consent (optional)', () => {
    const raw = JSON.stringify({ t: 'hello', entropyCommit: 'a'.repeat(64) });
    expect(parseClientMsg(raw)).not.toBeNull();
  });

  it('accepts a well-formed wallet.prove and rejects a bad signature shape', () => {
    const ok = JSON.stringify({ t: 'wallet.prove', signature: `0x${'ab'.repeat(65)}` });
    expect(parseClientMsg(ok)).not.toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'wallet.prove', signature: 'nope' }))).toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'wallet.prove' }))).toBeNull();
  });
});
