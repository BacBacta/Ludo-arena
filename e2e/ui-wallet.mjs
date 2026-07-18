/**
 * Phase 3 — wallet integration + mobile UI, with a MOCKED MiniPay provider (for
 * CI). Covers: MiniPay detection + zero-click connect, a REFUSED connection, an
 * ABSENT provider (demo fallback), all on an Android 360x800 webview viewport.
 * Real transaction signing → settlement is exercised manually on Celo Sepolia
 * (e2e/staked/). Run against the local stack (see e2e/README.md).
 */
import { launchBrowser, newPlayer, openLobby, injectMiniPay, MOBILE_CONTEXT, tally, WEB } from './lib/common.mjs';

const t = tally('ui-wallet');
const browser = await launchBrowser();

try {
  // ---- 1. MiniPay present → detected + zero-click connect, on mobile viewport ----
  {
    const { ctx, page } = await newPlayer(browser, MOBILE_CONTEXT);
    await injectMiniPay(page, { address: '0x00000000000000000000000000000000000000Aa' });
    await openLobby(page);

    const vp = page.viewportSize();
    t.check('renders at Android 360x800 viewport', vp.width === 360 && vp.height === 800, `${vp.width}x${vp.height}`);

    const isMini = await page.evaluate(() => Boolean(window.ethereum && window.ethereum.isMiniPay));
    t.check('app sees window.ethereum.isMiniPay', isMini);

    // MiniPay path auto-connects (App.tsx: if (isMiniPay()) connectWalletCta) —
    // so eth_requestAccounts is called with NO user click (zero-click connect).
    const calls = await page.evaluate(() => window.__ethCalls || []);
    t.check('zero-click connect calls eth_requestAccounts', calls.includes('eth_requestAccounts'), calls.join(','));

    // lobby is usable (a Play control is present and enabled)
    const lobbyLive = await page.getByText(/play|jouer|stake|mise/i).first().isVisible().catch(() => false);
    t.check('lobby is interactive under MiniPay', lobbyLive);
    await ctx.close();
  }

  // ---- 2. Connection REFUSED (user rejects) → app stays usable, no crash ----
  {
    const { ctx, page } = await newPlayer(browser, MOBILE_CONTEXT);
    await injectMiniPay(page, { reject: true }); // eth_requestAccounts throws 4001
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await openLobby(page);

    const calls = await page.evaluate(() => window.__ethCalls || []);
    t.check('refused connect still attempted eth_requestAccounts', calls.includes('eth_requestAccounts'), calls.join(','));
    t.check('a rejected connection does not throw an uncaught page error', errors.length === 0, errors[0] || '');
    const lobbyLive = await page.getByText(/play|jouer|practice|pratique|stake|mise/i).first().isVisible().catch(() => false);
    t.check('lobby remains interactive after a refused connection', lobbyLive);
    await ctx.close();
  }

  // ---- 3. Provider ABSENT → demo/practice path works on mobile, no crash ----
  {
    const { ctx, page } = await newPlayer(browser, MOBILE_CONTEXT); // no injectMiniPay
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await openLobby(page);

    const noWallet = await page.evaluate(() => typeof window.ethereum === 'undefined');
    t.check('no window.ethereum injected (demo mode)', noWallet);
    t.check('app boots with no wallet without a page error', errors.length === 0, errors[0] || '');

    // The free/practice CTA must still start a playable game with no wallet.
    await page.getByText(/practice|pratique|play|jouer/i).first().click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const board = await page.locator('.board, svg, .token, canvas').first().isVisible().catch(() => false);
    t.check('a game/board is reachable without a wallet (demo fallback)', board);
    await ctx.close();
  }

  console.log(`\n(WEB=${WEB})`);
} finally {
  await browser.close();
}

t.done();
