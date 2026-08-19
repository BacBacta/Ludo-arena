import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { StoreProvider } from './state/store';
import './styles/global.css';

// Unmissable at every load: which build is actually running. If this line is
// absent from the console, the browser is serving a STALE cached bundle (the
// service worker) — the #1 cause of "my fix didn't take". Compare it to
// /version.json to know instantly whether a reload delivered fresh code.
console.log(`[ludo] build ${__APP_VERSION__} loaded`);

// Captured BEFORE React mounts, because App strips a `#/g/CODE` invite from the
// URL as soon as it has read it. A service-worker update reload would otherwise
// come back to a bare `/` and silently drop the invite.
const BOOT_HREF = window.location.href;

// Global safety net: surface (don't swallow) async failures instead of a
// silent white screen. A real error tracker plugs in here later.
window.addEventListener('error', (e) => console.error('[window.error]', e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[unhandledrejection]', e.reason));

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <StoreProvider>
        <App />
      </StoreProvider>
    </ErrorBoundary>
  </StrictMode>,
);

// PWA: offline app shell (E6.5). Dev uses HMR, so only register for the build.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  // When a NEWLY-INSTALLED sw takes control (skipWaiting + clients.claim), reload
  // ONCE so the page runs the fresh assets instead of the ones it booted with.
  // Without this, a returning user can sit on stale code until they manually
  // clear the SW — the trap that hid deploy after deploy.
  //
  // …but ONLY when this page already HAD a controller at boot, i.e. a genuine
  // UPDATE. On a first-ever visit there is no controller, the very first install
  // claims the page, and the unconditional reload fired on EVERY new visitor —
  // already-running code thrown away mid-flight. That is what broke `#/g/CODE`
  // invite links: App reads the code, strips it from the URL, and the SW reload
  // then reboots into a bare lobby, so the guest never joined the host's table
  // (e2e/ui-mobile.mjs: "both players matched to a seat" — host=null guest=null).
  // The assets a first visit booted with ARE the fresh ones; nothing to reload.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    // Return to the URL the page BOOTED with, not the one App rewrote: a real
    // update landing on a visitor who just opened an invite link must still
    // carry `#/g/CODE` across the reload.
    //
    // Restore the URL first, THEN reload. `location.replace(BOOT_HREF)` looks
    // equivalent and is not: when the only difference is the fragment — exactly
    // our case, App having just stripped `#/g/CODE` — the browser treats it as a
    // same-document navigation and never reloads. The update would then be
    // swallowed silently, with `reloading` latched so nothing retries.
    history.replaceState(null, '', BOOT_HREF);
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        void reg.update(); // check for a newer SW every load, not just every 24h
      })
      .catch(() => undefined);
  });
}
