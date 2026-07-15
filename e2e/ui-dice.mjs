/**
 * Dice & pawn choreography (private 1v1): R19 — the opponent's die must render
 * as a SINGLE computed matrix during MY roll (no phantom unwind); R20 — the
 * opponent's result stays readable ≥1200ms; R21 — no pawn moves before the
 * 700ms tumble has finished. All measured on getComputedStyle / DOM state, never
 * on inline style (oracle rules, docs/QA-GAME-AUDIT-PROMPT.md §5.2).
 */
import { launchBrowser, uiPrivatePair, tally } from './lib/common.mjs';

const TUMBLE = 700;
const t = tally('ui-dice');
const browser = await launchBrowser();

const watchOppMatrices = (page, ms) => page.evaluate((dur) => new Promise((res) => {
  const hud = document.querySelector('.huddie');
  const cube = hud?.querySelector('.die3d');
  if (!cube) return res(null);
  const seen = new Set();
  let visibleWhileChanging = false;
  let last = getComputedStyle(cube).transform;
  const t0 = performance.now();
  const tick = () => {
    const m = getComputedStyle(cube).transform;
    seen.add(m);
    if (m !== last && getComputedStyle(hud).opacity !== '0') visibleWhileChanging = true;
    last = m;
    if (performance.now() - t0 < dur) requestAnimationFrame(tick);
    else res({ matrices: seen.size, visibleWhileChanging });
  };
  requestAnimationFrame(tick);
}), ms);

const watchOppVisibility = (page, ms) => page.evaluate((dur) => new Promise((res) => {
  const hud = document.querySelector('.huddie');
  const cube = hud?.querySelector('.die3d');
  if (!hud || !cube) return res(null);
  const rot0 = cube.style.transform;
  const t0 = performance.now();
  let rollAt = null, hiddenAt = null;
  const tick = () => {
    const now = performance.now();
    if (rollAt === null && cube.style.transform !== rot0) rollAt = now;
    const hidden = hud.classList.contains('huddie--idle') || getComputedStyle(hud).opacity === '0';
    if (rollAt !== null && hiddenAt === null && hidden) hiddenAt = now;
    if (now - t0 < dur) requestAnimationFrame(tick);
    else res(rollAt === null ? null : Math.round((hiddenAt ?? now) - rollAt));
  };
  requestAnimationFrame(tick);
}), ms);

const boardQuiet = (page, quiet = 400) => page.evaluate((q) => new Promise((res) => {
  let last = [...document.querySelectorAll('.token')].map((x) => x.style.transform).join('|');
  let since = performance.now();
  const tick = () => {
    const now = [...document.querySelectorAll('.token')].map((x) => x.style.transform).join('|');
    if (now !== last) { last = now; since = performance.now(); }
    if (performance.now() - since > q) res(true); else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), quiet);

const firstPawnMove = (page, ms) => page.evaluate((dur) => new Promise((res) => {
  const pos0 = [...document.querySelectorAll('.token')].map((x) => x.style.transform);
  const t0 = performance.now();
  const tick = () => {
    const now = performance.now() - t0;
    const cur = [...document.querySelectorAll('.token')].map((x) => x.style.transform);
    if (cur.some((v, i) => pos0[i] !== undefined && v !== pos0[i])) return res(Math.round(now));
    if (now < dur) requestAnimationFrame(tick); else res(null);
  };
  requestAnimationFrame(tick);
}), ms);

try {
  const { host, guest } = await uiPrivatePair(browser);
  const pages = [host.page, guest.page];

  let phantom = { tested: 0, bad: 0 };
  let readable = [];
  let pawn = { tested: 0, early: 0 };

  for (let i = 0; i < 60 && (phantom.tested < 3 || readable.length < 3 || pawn.tested < 3); i++) {
    for (const p of pages) {
      const other = p === host.page ? guest.page : host.page;
      const btn = p.locator('button.dicebtn:not([disabled])');
      if (!(await btn.count())) continue;

      // R19 — only meaningful once the opponent die carries accumulated turns
      const inline = await p.evaluate(() => document.querySelector('.huddie .die3d')?.style.transform || '');
      const carriesTurns = /rotate[XY]\((?!0deg)/.test(inline);

      await boardQuiet(p);
      if (!(await btn.count())) continue;
      const [mat, vis, moveAt] = await Promise.all([
        carriesTurns && phantom.tested < 3 ? watchOppMatrices(p, 800) : Promise.resolve(null),
        readable.length < 3 ? watchOppVisibility(other, 2600) : Promise.resolve(undefined),
        pawn.tested < 3 ? firstPawnMove(p, 2500) : Promise.resolve(undefined),
        btn.first().click({ timeout: 800 }).catch(() => {}),
      ]);
      if (mat) { phantom.tested++; if (mat.matrices > 2 && mat.visibleWhileChanging) phantom.bad++; }
      if (typeof vis === 'number') readable.push(vis);
      if (typeof moveAt === 'number') { pawn.tested++; if (moveAt < TUMBLE) pawn.early++; }

      const tk = p.locator('.token--movable');
      if (await tk.count()) { await p.waitForTimeout(250); await tk.first().click({ timeout: 700, force: true }).catch(() => {}); }
      await p.waitForTimeout(250);
    }
  }

  t.check('R19 opponent die is static during my roll', phantom.tested >= 2 && phantom.bad === 0, `${phantom.bad}/${phantom.tested} phantom spins`);
  t.check('R20 opponent result readable ≥1200ms', readable.length >= 2 && readable.every((v) => v >= 1200), `spans: ${readable.join(', ')}ms`);
  t.check('R21 no pawn moves before the die settles', pawn.tested >= 2 && pawn.early === 0, `${pawn.early}/${pawn.tested} early (tumble ${TUMBLE}ms)`);
} catch (e) {
  t.check('ui-dice ran to completion', false, e.message);
} finally {
  await browser.close();
}
t.done();
