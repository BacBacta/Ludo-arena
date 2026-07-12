/**
 * Self-review tool: renders the built app in headless Chromium (mobile
 * viewport) and captures lobby + in-game screenshots so the design can be
 * compared against the reference before shipping.
 * Usage: node scripts/shoot.mjs [outDir] (expects `vite preview` on :4173)
 */
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? '/tmp/shots';
const URL = process.env.SHOT_URL ?? 'http://localhost:4173';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 800 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();

// lobby (skip onboarding, force EN)
await page.addInitScript(() => {
  localStorage.setItem('ludo.onboarded', '1');
  localStorage.setItem('ludo.lang', 'en');
});
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/lobby.png` });

// game vs bot: select Free, then PLAY
await page.getByText('Free', { exact: true }).first().click();
await page.waitForTimeout(300);
await page.getByText('PLAY').first().click();
await page.waitForTimeout(2600); // bot match intro
await page.screenshot({ path: `${OUT}/game.png` });

// roll once to see dice/tokens mid-game
try {
  await page.locator('.dicebtn:not([disabled])').click({ timeout: 4000 });
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${OUT}/game2.png` });
} catch {
  /* not our turn fast enough; game.png is enough */
}

await browser.close();
console.log('shots written to', OUT);
