/**
 * Practice modes: M1 — the offline bot fallback (server unreachable → the free
 * game must still start against the local bot and be playable), and M7 — the
 * 4-player practice table (local bots) stays playable turn after turn.
 */
import { launchBrowser, newPlayer, openLobby, tally } from './lib/common.mjs';

const t = tally('ui-practice');
const browser = await launchBrowser();

try {
  // ---------- M1: the OFFLINE free experience. Product decision (App.startMatch):
  // the free PLAY CTA launches the LOCAL 4-player practice game — no network at
  // all — so "offline play" means that table must start and stay playable with
  // the network down. (The 2p LocalBotSession remains a fallback of the CONNECTED
  // flows only; noted in the audit report.)
  {
    const P = await newPlayer(browser);
    await openLobby(P.page);
    await P.page.locator('.gstake--free').first().click({ timeout: 4000 }).catch(() => {});
    await P.ctx.setOffline(true); // page loaded, stake picked; NOW the network dies
    await P.page.locator('.btn--hero').first().click({ timeout: 4000 });
    await P.page.waitForTimeout(2500);
    t.check('M1 offline free CTA opens the practice table', (await P.page.locator('.plabel').count()) === 4);
    let myTurns = 0;
    const deadline = Date.now() + 60_000;
    while (myTurns < 3 && Date.now() < deadline) {
      const btn = P.page.locator('.ludodie--tap:not([disabled])');
      if (await btn.count()) {
        await btn.first().click({ timeout: 700 }).catch(() => {});
        myTurns++;
        await P.page.waitForTimeout(1100);
        const tk = P.page.locator('.token--movable');
        if (await tk.count()) await tk.first().click({ timeout: 600, force: true }).catch(() => {});
      }
      await P.page.waitForTimeout(400);
    }
    t.check('M1 offline practice game is playable', myTurns >= 3, `${myTurns} of my turns, network down`);
    await P.ctx.close();
  }

  // ---------- M7: 4-player practice (local bots)
  {
    const P = await newPlayer(browser);
    await openLobby(P.page);
    await P.page.locator('.mrow').first().click({ timeout: 5000 });
    await P.page.waitForTimeout(800);
    await P.page.locator('button.t4mode').nth(0).click({ timeout: 5000 }); // "Practice"
    await P.page.waitForTimeout(2500);
    t.check('M7 practice table opens', (await P.page.locator('.plabel').count()) === 4);

    // my turns keep coming back and stay playable across many bot cycles
    let myTurns = 0;
    const deadline = Date.now() + 90_000;
    while (myTurns < 5 && Date.now() < deadline) {
      const btn = P.page.locator('.ludodie--tap:not([disabled])');
      if (await btn.count()) {
        await btn.first().click({ timeout: 700 }).catch(() => {});
        myTurns++;
        await P.page.waitForTimeout(1100);
        const tk = P.page.locator('.token--movable');
        if (await tk.count()) await tk.first().click({ timeout: 600, force: true }).catch(() => {});
      }
      await P.page.waitForTimeout(400);
    }
    t.check('M7 my turn returns repeatedly (bots never wedge the table)', myTurns >= 5, `${myTurns} of my turns played`);
    await P.ctx.close();
  }
} catch (e) {
  t.check('ui-practice ran to completion', false, e.message);
} finally {
  await browser.close();
}
t.done();
