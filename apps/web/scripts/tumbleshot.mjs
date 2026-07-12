/**
 * One-off: capture the 4-player board at start (all pawns in base) and a frame
 * mid-dice-tumble to confirm the 3D roll animation actually renders.
 * Usage: node scripts/tumbleshot.mjs [outDir] (expects vite preview on :4173)
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
await page.addInitScript(() => {
  localStorage.setItem('ludo.onboarded', '1');
  localStorage.setItem('ludo.lang', 'en');
});
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.getByText('Free', { exact: true }).first().click();
await page.waitForTimeout(250);
await page.getByText('PLAY').first().click();
await page.waitForTimeout(2400);
await page.screenshot({ path: `${OUT}/start.png` }); // all pawns in base

// roll and grab a few frames across the tumble
try {
  const die = page.locator('.ludodie--tap:not([disabled])');
  await die.click({ timeout: 4000 });
  for (const [ms, name] of [[140, 'roll_a'], [140, 'roll_b'], [160, 'roll_c']]) {
    await page.waitForTimeout(ms);
    await page.screenshot({ path: `${OUT}/${name}.png` });
  }
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/settled.png` });
} catch (e) {
  console.log('roll capture skipped:', e.message);
}

await browser.close();
console.log('tumble shots written to', OUT);
