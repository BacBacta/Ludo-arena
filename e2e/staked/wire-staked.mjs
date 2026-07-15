/**
 * STAKED server frontier: the same-network anti-collusion control. Two
 * SIWE-proven, consenting wallet sessions from the same host (same IP) must NOT
 * be allowed to stake against each other — the defence against chip-dumping
 * (one person moving money between their own accounts by losing on purpose).
 *
 * This is why the on-chain money path is proven at the CONTRACT level instead
 * (e2e/staked/contract-settle.mjs, 9/9): a single-host bench shares one IP, so
 * pairing two staked players through matchmaking is correctly refused here.
 *
 * Needs the server in durable staked mode + funded test wallets (see README).
 */
import { WireBot, sleep, tally } from '../lib/common.mjs';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const t = tally('wire-staked');

const TOS_VERSION = '2026-07-01';
const walletProofMessage = (nonce) => `Ludo Arena — verify wallet ownership.\nNonce: ${nonce}`;
const { players } = JSON.parse(readFileSync('/tmp/claude-1000/-workspaces-Ludo-arena/00d95733-8211-42be-a067-2b4e08916f8a/scratchpad/test-wallets.json', 'utf8'));

/** A consenting, SIWE-proven wallet session. */
async function provenPlayer(name, pk) {
  const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
  const bot = new WireBot(name);
  await bot.connect({ wallet: account.address, consent: { tosVersion: TOS_VERSION, age18: true } });
  if (bot.hello.walletNonce) {
    const signature = await account.signMessage({ message: walletProofMessage(bot.hello.walletNonce) });
    bot.send({ t: 'wallet.prove', signature });
    await sleep(800);
  }
  return { bot, account };
}

const A = await provenPlayer('StakeGateHost', players[0].pk);
const B = await provenPlayer('StakeGateGuest', players[1].pk);
t.check('both wallet sessions established (consent + SIWE nonce issued)', !!A.bot.hello.walletNonce && !!B.bot.hello.walletNonce);

// A opens a staked table — the money gates (consent + SIWE) must pass
let mark = A.bot.mark();
A.bot.send({ t: 'table.create', stake: 25 });
const created = await A.bot.awaitFrom(mark, (m) => m.t === 'table.created' || m.t === 'error', 8000, 'create').catch(() => null);
t.check('staked table.create passes the money gates', created?.t === 'table.created', created?.message ?? created?.code);

// B (same host → same IP) tries to join → refused by the anti-collusion control
if (created?.t === 'table.created') {
  mark = B.bot.mark();
  B.bot.send({ t: 'table.join', code: created.code });
  const res = await B.bot.awaitFrom(mark, (m) => m.t === 'match.found' || m.t === 'error', 6000, 'join result').catch(() => null);
  t.check('same-network staked pairing is refused (anti chip-dumping)', res?.t === 'error' && /same-network|same-device/i.test(res.message ?? ''), res?.message ?? res?.t);
}

t.note('on-chain money path verified separately: e2e/staked/contract-settle.mjs (9/9)');
A.bot.close(); B.bot.close();
t.done();
