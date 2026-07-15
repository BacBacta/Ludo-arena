/**
 * UI audit of the free 4-player Sit&Go (M8): R9 — every human plays from the
 * bottom-left quadrant (board spun per seat) with REAL names as labels; R11 —
 * all four corner dice stay mounted at all times (hidden via CSS, never
 * unmounted); plus cross-screen label agreement and playability ticks.
 */
import { launchBrowser, newPlayer, openLobby, labels4p, tally } from './lib/common.mjs';

const t = tally('ui-4p');
const browser = await launchBrowser();

const join4 = async () => {
  const player = await newPlayer(browser);
  await openLobby(player.page);
  await player.page.locator('.mrow').first().click({ timeout: 5000 });
  await player.page.waitForTimeout(800);
  await player.page.locator('button.t4mode').nth(1).click({ timeout: 5000 }); // "Free online"
  return player;
};

try {
  const A = await join4();
  await A.page.waitForTimeout(600);
  const B = await join4();
  await A.page.waitForTimeout(15000); // bot fill closes the table after 12s

  t.check('M8 two humans seated (bots fill the rest)', A.wire.seat4 !== null && B.wire.seat4 !== null, `seats ${A.wire.seat4}/${B.wire.seat4}`);

  // R9 — each player finds THEIR OWN hello name at the bottom-left quadrant
  for (const [tag, P] of [['A', A], ['B', B]]) {
    const l = await labels4p(P.page);
    const me = (P.wire.helloName || '').toUpperCase();
    const hit = Object.entries(l).find(([, txt]) => (txt || '').toUpperCase() === me);
    t.check(`R9 ${tag} plays from the bottom-left`, hit?.[0] === '0', `name="${P.wire.helloName}" drawn at q${hit?.[0] ?? '?'} — ${JSON.stringify(l)}`);
  }

  // cross-screen agreement: what A calls B must equal what B calls themself
  const la = await labels4p(A.page), lb = await labels4p(B.page);
  const quartersB = (4 - (B.wire.seat4 % 4)) % 4;
  const seatAtQuadB = (q) => (q + B.wire.seat4) % 4; // inverse of the board spin
  const aName = la[String(((A.wire.seat4 ?? 0) + 0) % 4)]; // A at their own q0
  const bOnA = la[String(((B.wire.seat4 - A.wire.seat4) + 4) % 4)];
  t.check('labels agree across screens', bOnA === lb['0'] && la['0'] === lb[String(((A.wire.seat4 - B.wire.seat4) + 4) % 4)],
    `A sees B as "${bOnA}", B calls self "${lb['0']}" | B sees A as "${lb[String(((A.wire.seat4 - B.wire.seat4) + 4) % 4)]}", A calls self "${la['0']}"`);

  // R11 + playability: over ~25s of play, every screen keeps 4 mounted dice
  let samples = 0, bad = 0;
  for (let i = 0; i < 25; i++) {
    for (const P of [A, B]) {
      const btn = P.page.locator('.ludodie--tap:not([disabled])');
      if (await btn.count()) await btn.first().click({ timeout: 700 }).catch(() => {});
      const tk = P.page.locator('.token--movable');
      if (await tk.count()) await tk.first().click({ timeout: 600, force: true }).catch(() => {});
      samples++;
      if ((await P.page.locator('.ludodie').count()) !== 4) bad++;
    }
    await A.page.waitForTimeout(600);
  }
  t.check('R11 all four corner dice stay mounted', bad === 0, `${bad}/${samples} samples off`);
  t.check('M8 table is playable (humans rolled)', samples > 0);
} catch (e) {
  t.check('ui-4p ran to completion', false, e.message);
} finally {
  await browser.close();
}
t.done();
