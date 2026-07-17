/**
 * Phase 8 — the STAKING_ENABLED launch gate must FAIL SAFE.
 *
 * STAKING_ENABLED != true only nulls the arbiter. `needsLock` is
 * `stake > 0 && both wallets && !!arbiter`, so with no arbiter a wallet-backed
 * staked game would start WITHOUT waiting for the escrow and would never be
 * settled — a client that deposited anyway (its escrow address is baked into its
 * own bundle, not handed out by the server) leaves real funds locked until the
 * contract's 24h refundActive. Turning staking OFF must stop staked play, not
 * turn it into UNSETTLED staked play.
 *
 * This only bites when the store is DURABLE: the `settlementDurable()` gate
 * already refuses staked play on an in-memory store, masking the hole. So this
 * probe REQUIRES a Postgres+Redis-backed server with staking disabled:
 *
 *   docker run -d --name ludo-pg -e POSTGRES_PASSWORD=ludo -e POSTGRES_DB=ludo -p 55432:5432 postgres:16-alpine
 *   docker run -d --name ludo-redis -p 56379:6379 redis:7-alpine
 *   REDIS_URL=redis://localhost:56379 \
 *   DATABASE_URL=postgres://postgres:ludo@localhost:55432/ludo \
 *   QA_KEY=simkey DIE_SETTLE_MS=0 PORT=8787 npx tsx apps/server/src/index.ts
 *
 *   SRV='ws://localhost:8787' node e2e/wire-launchgate.mjs
 *
 * Run it WITHOUT a ?qa= key, deliberately. A QA session is refused staked play by
 * its OWN gate ("QA sessions cannot join staked queues"), which fires FIRST and
 * would make queue.join below pass for the wrong reason — green while testing
 * nothing. The assertions print the refusal text so that masking stays visible.
 *
 * Discriminating (verified): against the pre-fix server queue.join returns
 * queue.ok and table.create returns table.created — i.e. the player is seated in
 * a real-money game that can never be settled.
 */
import { WireBot, tally } from './lib/common.mjs';
import { TOS_VERSION } from '../packages/shared/src/protocol.ts';

const t = tally('wire-launchgate');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A wallet-backed player who has cleared every OTHER staked gate: MiniPay (so the
// wallet counts as proven) + current ToS consent. The only thing left standing
// between them and a real-money game is the launch gate.
const WALLET = '0x862F0b37B4eb6d121E7D3d51C02c5e58461E5897';
const staker = (name) =>
  new WireBot(name).connect({
    wallet: WALLET,
    miniPay: true,
    consent: { tosVersion: TOS_VERSION, age18: true },
  });

const refusal = (bot, from) =>
  bot.log.slice(from).find((m) => m.t === 'error')?.message ?? null;

async function main() {
  const bot = await staker('LaunchGate');

  // Sanity: the session really is wallet-proven and consented, so a refusal below
  // cannot be one of the other gates firing. Without this the test could pass for
  // the wrong reason (the trap this campaign kept hitting).
  t.check('session is wallet-proven (MiniPay) — other gates cannot explain a refusal', bot.hello?.walletProven === true, `walletProven=${bot.hello?.walletProven}`);
  t.check('session carries the current ToS consent', bot.hello?.consentTosVersion === TOS_VERSION, `tos=${bot.hello?.consentTosVersion}`);

  // 1. public staked queue
  let from = bot.mark();
  bot.send({ t: 'queue.join', stake: 25 });
  await sleep(400);
  const queued = bot.log.slice(from).some((m) => m.t === 'queue.ok');
  t.check('staked queue.join is REFUSED while the arbiter is disarmed', !queued && !!refusal(bot, from), refusal(bot, from) ?? 'got queue.ok');

  // 2. private staked table — the same gate must cover it (a staked table that
  //    never settles is the same stranded-funds bug with a friend code on it).
  from = bot.mark();
  bot.send({ t: 'table.create', stake: 25 });
  await sleep(400);
  const created = bot.log.slice(from).some((m) => m.t === 'table.created');
  t.check('staked table.create is REFUSED while the arbiter is disarmed', !created && !!refusal(bot, from), refusal(bot, from) ?? 'got table.created');

  // 3. free play still works — the gate must stop MONEY, not the product.
  from = bot.mark();
  bot.send({ t: 'queue.join', stake: 0 });
  const ok = await bot.awaitFrom(from, (m) => m.t === 'queue.ok', 5000, 'queue.ok').catch(() => null);
  t.check('free play is unaffected by the launch gate', !!ok);
  bot.send({ t: 'queue.leave' });

  bot.close();
  t.done();
}

void main();
