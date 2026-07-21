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
  // When a newly-installed SW takes control (it calls skipWaiting + clients.claim),
  // reload ONCE so the page runs the fresh assets instead of the ones it booted
  // with. Without this, a returning user can sit on stale code until they manually
  // clear the SW — the trap that hid deploy after deploy.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
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
