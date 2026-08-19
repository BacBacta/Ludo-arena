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

/**
 * First move time PER OWN PAWN, keyed by its token index — not "any pawn moved".
 * Two things otherwise land in this window and have nothing to do with my roll:
 * the OPPONENT's relayed move (excluded by `[data-mine]`), and one of my own
 * pawns being sent back to base by their capture. Only the pawn I actually
 * TAPPED answers R21's question, so the caller pairs this map with the index
 * `tapWhenMovable` reports.
 */
const pawnMoveTimes = (page, ms) => page.evaluate((dur) => new Promise((res) => {
  const mine = () => [...document.querySelectorAll('.token[data-token]')];
  const key = (el) => el.getAttribute('data-token');
  const pos0 = new Map(mine().map((el) => [key(el), el.style.transform]));
  const seen = {};
  const t0 = performance.now();
  const tick = () => {
    const now = Math.round(performance.now() - t0);
    for (const el of mine()) {
      const k = key(el);
      if (seen[k] === undefined && pos0.has(k) && el.style.transform !== pos0.get(k)) seen[k] = now;
    }
    if (now < dur) requestAnimationFrame(tick); else res(seen);
  };
  requestAnimationFrame(tick);
}), ms);

/**
 * Tap the first movable pawn as soon as one appears, WITHIN the observation
 * window. R21's oracle is "the pawn must not move before the die settles" — so
 * the stimulus has to be an EARLY tap. The harness used to tap only after the
 * watcher had already closed, which meant the watcher almost never saw a move
 * at all: R21 kept failing its `tested >= 2` guard on 1 sample rather than on
 * any real finding.
 */
const tapWhenMovable = async (page, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const tk = page.locator('.token--movable').first();
    if (await tk.count()) {
      const idx = await tk.getAttribute('data-token').catch(() => null);
      await tk.click({ timeout: 500, force: true }).catch(() => {});
      return idx;
    }
    await page.waitForTimeout(60);
  }
  return null;
};

try {
  const { host, guest } = await uiPrivatePair(browser);
  const pages = [host.page, guest.page];

  let phantom = { tested: 0, bad: 0 };
  let readable = [];
  let pawn = { tested: 0, early: 0 };
  const pawnAt = [];

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
      const [mat, vis, moveAt, tapped] = await Promise.all([
        carriesTurns && phantom.tested < 3 ? watchOppMatrices(p, 800) : Promise.resolve(null),
        readable.length < 3 ? watchOppVisibility(other, 2600) : Promise.resolve(undefined),
        pawn.tested < 3 ? pawnMoveTimes(p, 2500) : Promise.resolve(undefined),
        btn.first().click({ timeout: 800 }).then(() => (pawn.tested < 3 ? tapWhenMovable(p, 2200) : null)).catch(() => null),
      ]);
      if (mat) { phantom.tested++; if (mat.matrices > 2 && mat.visibleWhileChanging) phantom.bad++; }
      if (typeof vis === 'number') readable.push(vis);
      // `tapped` is the 4th entry of the Promise.all above (the roll-then-tap arm).
      const at = moveAt && tapped != null ? moveAt[tapped] : undefined;
      if (typeof at === 'number') { pawn.tested++; pawnAt.push(at); if (at < TUMBLE) pawn.early++; }

      const tk = p.locator('.token--movable');
      if (await tk.count()) { await p.waitForTimeout(250); await tk.first().click({ timeout: 700, force: true }).catch(() => {}); }
      await p.waitForTimeout(250);
    }
  }

  t.check('R19 opponent die is static during my roll', phantom.tested >= 2 && phantom.bad === 0, `${phantom.bad}/${phantom.tested} phantom spins`);
  t.check('R20 opponent result readable ≥1200ms', readable.length >= 2 && readable.every((v) => v >= 1200), `spans: ${readable.join(', ')}ms`);
  t.check('R21 no pawn moves before the die settles', pawn.tested >= 2 && pawn.early === 0, `${pawn.early}/${pawn.tested} early (tumble ${TUMBLE}ms) — moveAt: ${pawnAt.join(', ')}ms`);
} catch (e) {
  t.check('ui-dice ran to completion', false, e.message);
} finally {
  await browser.close();
}
t.done();
