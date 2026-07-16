/**
 * Wire-level security regressions from the pre-launch risk matrix (Phase 0):
 *  - R-AUTH-2: a wallet-keyed durable write (limits, tickets) must be refused for
 *    a CLAIMED-but-UNPROVEN wallet, so a scripted client can't spend a victim's
 *    tickets or force their self-exclusion. A proven wallet (miniPay) is allowed.
 *  - R-RT-1: a double connection (same sessionToken → "new tab") rebinds the live
 *    session to the new socket; the OLD socket closing must NOT tear the live
 *    session down (its replies keep flowing). Before the fix, the stale close
 *    nulled the live ws and (in 4p) handed a staked seat to a bot.
 *
 * Run against a local server: `node e2e/wire-security.mjs` (SRV env to override).
 */
import { WireBot, tally } from './lib/common.mjs';

const t = tally('wire-security');

// ---- R-AUTH-2: claimed-but-unproven wallet cannot key a durable write ----
{
  const VICTIM = '0x1234567890123456789012345678901234567890';

  // A scripted client claims the victim's wallet but does NOT prove it (no
  // miniPay, no wallet.prove signature).
  const attacker = new WireBot('attacker');
  await attacker.connect({ wallet: VICTIM });
  t.check('unproven wallet → walletProven is false', attacker.hello.walletProven === false, `got ${attacker.hello.walletProven}`);

  const m1 = attacker.mark();
  attacker.send({ t: 'limits.set', dailyLimitCents: 100, selfExcludeDays: 30 });
  const r1 = await attacker.awaitFrom(m1, (m) => m.t === 'error' || m.t === 'limits.update', 8000, 'limits.set reply');
  t.check('limits.set on an unproven wallet is refused', r1.t === 'error', `got ${r1.t} ${r1.message ?? ''}`);

  const m2 = attacker.mark();
  attacker.send({ t: 'skin.buy', skinId: 'gold' });
  const r2 = await attacker.awaitFrom(m2, (m) => m.t === 'error' || m.t === 'skin.owned' || m.t === 'skin.buy.ok', 8000, 'skin.buy reply');
  t.check('skin.buy on an unproven wallet is refused', r2.t === 'error', `got ${r2.t}`);
  attacker.close();

  // Control: a miniPay session is trusted-proven → the same call is NOT refused
  // with the verify-wallet error (it may still hit a limit, but not the gate).
  const legit = new WireBot('legit');
  await legit.connect({ wallet: VICTIM, miniPay: true });
  t.check('miniPay wallet → walletProven is true', legit.hello.walletProven === true, `got ${legit.hello.walletProven}`);
  const m3 = legit.mark();
  legit.send({ t: 'limits.set', dailyLimitCents: 100 });
  const r3 = await legit.awaitFrom(m3, (m) => m.t === 'error' || m.t === 'limits.update', 8000, 'limits.set reply');
  t.check('limits.set on a proven (miniPay) wallet is accepted', r3.t === 'limits.update', `got ${r3.t} ${r3.message ?? ''}`);
  legit.close();
}

// ---- R-RT-1: a stale socket's close must not kill the live (resumed) session ----
{
  const W = '0x00000000000000000000000000000000000000aa';
  const tab1 = new WireBot('tab1');
  await tab1.connect({ wallet: W, miniPay: true });
  const token = tab1.hello.sessionToken;

  // "Open in a new tab": resume the SAME token on a second socket.
  const tab2 = new WireBot('tab2');
  await tab2.connect({ wallet: W, miniPay: true, sessionToken: token });
  t.check('second connection resumes the same session', !!tab2.hello, 'no hello.ok on resume');

  // Explicitly close the STALE tab (as a user closing the old browser tab would).
  // This fires tab1's close handler on the server — the exact trigger that, before
  // the fix, nulled the shared session's live ws. Then confirm tab2 still works.
  tab1.close();
  await new Promise((r) => setTimeout(r, 400));
  const m = tab2.mark();
  tab2.send({ t: 'limits.set', dailyLimitCents: 150 });
  let alive = false;
  try {
    const reply = await tab2.awaitFrom(m, (msg) => msg.t === 'limits.update' || msg.t === 'error', 6000, 'tab2 reply after tab1 close');
    alive = reply.t === 'limits.update'; // reply DELIVERED → session.ws still points at the live socket
  } catch {
    alive = false; // no reply → the stale close nulled the live ws (the bug)
  }
  t.check('live session survives the stale tab closing (reply still delivered)', alive);
  tab2.close();
}

t.done();
