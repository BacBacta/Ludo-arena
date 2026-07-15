/**
 * Ludo Arena service worker (E6.5) — offline app shell so the game loads
 * without a network; the client then falls back to bot mode (RemoteSession →
 * LocalBotSession) when the server is unreachable.
 *
 * Strategy: navigations use network-first with a cached index.html fallback;
 * same-origin GETs use cache-first, populating the cache on first fetch. WS and
 * cross-origin (RPC/wallet) requests are never intercepted.
 */
const CACHE = 'ludo-v23';
const SHELL = ['/', '/index.html', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Range requests (streamed <audio>, e.g. the landing music) return 206
  // partials that must NOT be cached or served as full responses — let the
  // browser handle them directly.
  if (req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let RPC/wallet/WS pass through

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          caches.open(CACHE).then((c) => c.put('/index.html', res.clone()));
          return res;
        })
        // Offline: fall back to the cached shell. The final `|| new Response`
        // guarantees a Response even if nothing is cached — respondWith() must
        // NEVER receive a promise that resolves to undefined or rejects.
        .catch(() =>
          caches
            .match('/index.html')
            .then((m) => m || caches.match('/'))
            .then((m) => m || new Response('<!doctype html><meta charset=utf-8><title>Offline</title>Offline — reconnecting…', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })),
        ),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        // A same-origin GET whose network fetch FAILS (server unreachable, flaky
        // mobile data) must degrade gracefully. Without this catch the rejected
        // promise reaches respondWith() — an uncaught error that spams the console
        // ("passed a rejected promise to FetchEvent.respondWith()") and leaves the
        // request with no response at all (e.g. a sound that never loads).
        .catch(() =>
          caches.match(req).then((c) => c || new Response('', { status: 504, statusText: 'Offline' })),
        );
    }),
  );
});
