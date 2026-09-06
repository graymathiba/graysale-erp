// Service worker: offline app shell cache + network-first strategy.
// API calls (/api/v1/*) are NOT cached — they require the live server.
// Static assets (app shell) are cached so the app can be installed and
// opened offline over the local network.

const CACHE = 'graysale-erp-v1';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Always hit the network for API and SSE — never cache business data.
  if (url.pathname.startsWith('/api/')) return;

  // Network-first with cache fallback for the app shell.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('/index.html')))
  );
});
