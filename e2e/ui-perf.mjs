/**
 * Phase 6 — real MiniPay conditions on the E2E path:
 *   - 3G throttling (750 kb/s, 100 ms RTT) via CDP Network.emulateNetworkConditions
 *   - low-end CPU profile (4x slowdown) via CDP Emulation.setCPUThrottlingRate
 *   - Android 360x800 webview viewport
 * Budgets (the single source of truth — AGENTS.md golden rule 4 mirrors these):
 *   - CRITICAL PATH (all JS+CSS except the lazily-loaded 3D dice engine chunk)
 *     < 300 KB gzipped — this is what gates interactivity;
 *   - TOTAL landing transfer (including the lazy three.js diceEngine chunk the
 *     lobby hero pulls in after paint) < 500 KB gzipped;
 *   - time-to-interactive < 5 s.
 *
 * IMPORTANT: serve the build from a COMPRESSING origin, like production does
 * (Vercel gzip/brotli). `python3 -m http.server` does NOT compress — measuring
 * against it reports the uncompressed transfer (~669 KB) and a ~10 s TTI on the
 * 3G profile, which is a measurement artifact, not the app. The probe asserts the
 * assets really arrived compressed so this can't pass unnoticed again.
 */
import { launchBrowser, newPlayer, MOBILE_CONTEXT, tally, WEB } from './lib/common.mjs';

const t = tally('ui-perf');
const browser = await launchBrowser();

// Official MiniPay target: low-end Android on slow mobile data.
const THREE_G = { offline: false, downloadThroughput: (750 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 100 };
const CPU_SLOWDOWN = 4; // low-end device profile

try {
  const { ctx, page } = await newPlayer(browser, MOBILE_CONTEXT);

  // measure the REAL transferred bytes of the initial landing
  let jsCss = 0;
  let critical = 0; // everything except the lazy 3D dice-engine chunk
  let compressed = 0;
  let assets = 0;
  const seen = new Set();
  page.on('response', async (res) => {
    const url = res.url();
    if (seen.has(url)) return;
    seen.add(url);
    if (!/\.(js|css)(\?|$)/.test(url)) return;
    try {
      const h = await res.allHeaders();
      const len = Number(h['content-length'] || 0);
      const bytes = len || (await res.body().catch(() => Buffer.alloc(0))).length;
      jsCss += bytes;
      if (!/diceEngine/.test(url)) critical += bytes; // the lazy three.js chunk is budgeted separately
      assets++;
      if (/gzip|br|deflate/.test(h['content-encoding'] || '')) compressed++;
    } catch { /* redirected/aborted */ }
  });

  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', THREE_G);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });

  const t0 = Date.now();
  await page.goto(WEB, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Interactive = the lobby's primary CTA is visible and clickable.
  const cta = page.getByText(/play|jouer|practice|pratique|stake|mise/i).first();
  await cta.waitFor({ state: 'visible', timeout: 60000 }).catch(() => {});
  const tti = Date.now() - t0;

  t.check('renders at Android 360x800 under 3G + 4x CPU', page.viewportSize().width === 360);
  // Guard the measurement itself: an origin that doesn't compress makes the two
  // budgets below meaningless (they'd measure raw bytes, not what users download).
  t.check('origin serves COMPRESSED assets (production-like)', assets > 0 && compressed === assets, `${compressed}/${assets} assets gzip/br — use a compressing server, not python http.server`);
  t.check(`critical-path JS+CSS (excl. lazy dice engine) < 300 KB`, critical > 0 && critical < 300 * 1024, `${(critical / 1024).toFixed(0)} KB (gzipped over the wire)`);
  t.check(`total JS+CSS transferred < 500 KB`, jsCss > 0 && jsCss < 500 * 1024, `${(jsCss / 1024).toFixed(0)} KB (gzipped over the wire)`);
  t.check('time-to-interactive < 5 s on 3G + low-end CPU', tti < 5000, `${tti} ms`);

  // the app must be usable, not just painted
  const clickable = await cta.isEnabled().catch(() => false);
  t.check('primary CTA is actually interactive', clickable, `tti=${tti}ms`);

  await ctx.close();
} finally {
  await browser.close();
}

console.log(`\n(WEB=${WEB} · 3G 750kb/s 100ms RTT · CPU 4x slowdown)`);
t.done();
