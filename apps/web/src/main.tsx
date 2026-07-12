import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { StoreProvider } from './state/store';
import './styles/global.css';

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
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
