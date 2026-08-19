/**
 * Regenerates the MiniPay listing screenshots (docs/listing/screenshots/) from
 * the REAL app, at the 360x640 Android webview viewport MiniPay targets.
 *
 * They are committed rather than generated at submission time so the store
 * listing and the repo can never drift apart silently — but a hand-cropped
 * screenshot rots the moment the UI moves, hence this script. Run it against
 * the local stack (see e2e/README.md), then commit whatever changed.
 *
 * The store caps each image at 500 KB; the run FAILS if any shot exceeds it,
 * because a shot too heavy to upload is worse than no shot at all.
 *
 *   node e2e/listing-shots.mjs [outDir]
 */
import { mkdirSync, statSync } from 'node:fs';
import { launchBrowser, newPlayer, openLobby, uiPlayTick, MOBILE_CONTEXT, WEB, tally } from './lib/common.mjs';

const OUT = process.argv[2] || 'docs/listing/screenshots';
const MAX_BYTES = 500 * 1024;
const t = tally('listing-shots');
mkdirSync(OUT, { recursive: true });

/** Dismiss the first-run "how to play" sheet without leaving the current screen. */
async function dismissWelcome(page) {
  await page.getByText(/Got it|let's play|C'est parti/i).first().click({ timeout: 3000 }).catch(() => {});
  await page.getByText(/\(tap to close\)/i).first().click({ timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(600);
}

const shot = async (page, name) => {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path });
  const bytes = statSync(path).size;
  t.check(`${name}.png ≤ 500 KB`, bytes <= MAX_BYTES, `${Math.round(bytes / 1024)} KB`);
};

const browser = await launchBrowser();
try {
  // 1 — lobby: the first thing a reviewer sees. Stake copy, free/stakes toggle.
  const host = await newPlayer(browser, MOBILE_CONTEXT);
  await openLobby(host.page);
  await dismissWelcome(host.page);
  await host.page.waitForTimeout(1000);
  await shot(host.page, '01-lobby');

  // 2 — a REAL board mid-game (two paired mobile clients, actual turns played),
  //     never a mock: the reviewer is verifying the game exists.
  await host.page.getByText(/Private table|Table privée/i).first().click({ timeout: 6000 }).catch(() => {});
  await host.page.waitForTimeout(1500);
  const code = (await host.page.locator('.tablecode').first().textContent({ timeout: 5000 }).catch(() => null))?.trim();
  const guest = await newPlayer(browser, MOBILE_CONTEXT);
  await guest.page.goto(`${WEB}/#/g/${code}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await guest.page.waitForTimeout(2200);
  await dismissWelcome(guest.page);
  await host.page.waitForTimeout(4000);
  t.check('two mobile clients actually paired', host.wire.seat !== null && guest.wire.seat !== null, `host=${host.wire.seat} guest=${guest.wire.seat}`);
  for (let i = 0; i < 8; i++) {
    await uiPlayTick(host.page);
    await uiPlayTick(guest.page);
    await host.page.waitForTimeout(400);
  }
  await shot(host.page, '02-board');
  await guest.ctx.close();

  // 3 — the shop: cosmetics are the non-wagering side of the economy, which the
  //     listing form asks about separately.
  const shopper = await newPlayer(browser, MOBILE_CONTEXT);
  await openLobby(shopper.page);
  await dismissWelcome(shopper.page);
  await shopper.page.getByText(/^Shop$|^Boutique$/i).last().click({ timeout: 5000 }).catch(() => {});
  await shopper.page.waitForTimeout(2500);
  t.check('shop screen reached', await shopper.page.getByText(/Premium dice|dés premium/i).first().isVisible().catch(() => false));
  await shot(shopper.page, '03-shop');
  await shopper.ctx.close();
  await host.ctx.close();
} finally {
  await browser.close();
}

console.log(`\n(écrit dans ${OUT}/)`);
t.done();
