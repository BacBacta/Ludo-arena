/**
 * UI audit of the private 1v1 table (M5) — one full game + rematch, with the
 * regression oracles that live in the DOM: R5 (reconnect keeps the player able
 * to roll), R6 (client heartbeat), R7/R8 (banners: both players see THEMSELVES
 * bottom-left), R10 (my die outlives the turn handoff), R14 (no native focus
 * ring on pawn taps). See docs/QA-GAME-AUDIT-PROMPT.md §6.
 */
import { launchBrowser, uiPrivatePair, banners2p, tally, WEB } from './lib/common.mjs';

const t = tally('ui-2p');
const browser = await launchBrowser();

try {
  const { host, guest } = await uiPrivatePair(browser);
  t.check('M5 pairing via deep link', host.wire.seat !== null && guest.wire.seat !== null, `host seat ${host.wire.seat}, guest seat ${guest.wire.seat}`);

  // R7/R8 — both players read the board from the bottom-left, names agree across screens
  const [hb, gb] = [await banners2p(host.page), await banners2p(guest.page)];
  const strip = (s) => (s ?? '').replace(/[^\p{L}\p{N} ]/gu, '').trim().toUpperCase();
  t.check('R7/R8 both see THEMSELVES bottom-left', strip(hb['0']) === strip(gb['1']) && strip(gb['0']) === strip(hb['1']),
    `host ${JSON.stringify(hb)} guest ${JSON.stringify(gb)}`);

  // R6 — the client heartbeat pings within 12s even when idle (the lib counts
  // ping frames from socket open, so the delta over this window is reliable)
  const pingStart = guest.wire.pingsSent;
  await host.page.waitForTimeout(12500);
  t.check('R6 heartbeat ping within 12s idle', guest.wire.pingsSent > pingStart, `${guest.wire.pingsSent - pingStart} pings in the window`);

  // play the FULL game through the UI, sampling R10 + R14 as we go
  let dieChecks = 0, dieViolations = 0, taps = 0, outlineBad = 0, over = false;
  for (let i = 0; i < 300 && !over; i++) {
    for (const p of [host.page, guest.page]) {
      const rb = p.locator('button.dicebtn:not([disabled])');
      if (await rb.count()) {
        // only a click that actually LANDED counts as a roll sample — the button
        // can legitimately vanish between count() and click() when the turn moves
        const clicked = await rb.first().click({ timeout: 800 }).then(() => true).catch(() => false);
        await p.waitForTimeout(650);
        if (clicked) {
          dieChecks++;
          if (!(await p.locator('button.dicebtn').count()) && !(await p.getByText(/REMATCH|REVANCHE/i).count())) dieViolations++;
        }
      }
      const tk = p.locator('.token--movable');
      if (await tk.count()) {
        await tk.first().click({ timeout: 700, force: true }).catch(() => {});
        taps++;
        const o = await p.evaluate(() => {
          const el = document.activeElement;
          return el && el.classList?.contains('token') ? getComputedStyle(el).outlineStyle : 'n/a';
        });
        if (o !== 'none' && o !== 'n/a') outlineBad++;
      }
      if (await p.getByText(/REMATCH|REVANCHE/i).count()) over = true;
    }
    // R5 — once, mid-game: cut the guest's network for 2s, then let them resume
    if (i === 8) {
      await guest.ctx.setOffline(true);
      await guest.page.waitForTimeout(2000);
      await guest.ctx.setOffline(false);
      // recovery oracle: within 30s the guest can roll again (their turn comes back)
      let canRoll = false;
      for (let k = 0; k < 100 && !canRoll; k++) {
        canRoll = (await guest.page.locator('button.dicebtn:not([disabled])').count()) > 0;
        if (!canRoll) await guest.page.waitForTimeout(300);
      }
      t.check('R5 reconnect mid-game leaves the player able to roll', canRoll);
    }
    await host.page.waitForTimeout(150);
  }
  t.check('M5 full UI game reaches the result screen', over);
  t.check('R10 my die never vanishes mid-tumble', dieChecks > 20 && dieViolations === 0, `${dieViolations}/${dieChecks} vanished`);
  t.check('R14 no focus ring on pawn taps', taps >= 1 && outlineBad === 0, `${outlineBad}/${taps} outlined`);

  // rematch through the UI: host clicks FIRST, guest LAST (the old seat-swap trigger)
  if (over) {
    await host.page.getByText(/REMATCH|REVANCHE/i).first().click({ timeout: 4000 }).catch(() => {});
    await host.page.waitForTimeout(700);
    await guest.page.getByText(/REMATCH|REVANCHE/i).first().click({ timeout: 4000 }).catch(() => {});
    await host.page.waitForTimeout(4500);
    const [hb2, gb2] = [await banners2p(host.page), await banners2p(guest.page)];
    const sameLayout = strip(hb2['0']) === strip(hb['0']) && strip(gb2['0']) === strip(gb['0']);
    t.check('rematch keeps every banner where it was', sameLayout, `g2 host ${JSON.stringify(hb2)} guest ${JSON.stringify(gb2)}`);
    // and game 2 is actually playable: someone rolls within 20s
    let rolled = false;
    for (let k = 0; k < 66 && !rolled; k++) {
      for (const p of [host.page, guest.page]) {
        const rb = p.locator('button.dicebtn:not([disabled])');
        if (await rb.count()) { await rb.first().click({ timeout: 700 }).catch(() => {}); rolled = true; }
      }
      if (!rolled) await host.page.waitForTimeout(300);
    }
    t.check('rematch game is playable', rolled);
  }
} catch (e) {
  t.check('ui-2p ran to completion', false, e.message);
} finally {
  await browser.close();
}
t.done();
