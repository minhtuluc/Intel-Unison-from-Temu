/**
 * UniversalTrans Service Worker (PWA)
 * Network-first for API transfers & WebSocket, cache-first for app shell.
 */

// Replaced by the server with a version-derived name before this file is served,
// so the cache rolls over on every release without anyone editing it by hand.
const CACHE_NAME = '__SHELL_CACHE_NAME__';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.json',
  '/css/variables.css',
  '/css/base.css',
  '/css/layout.css',
  '/css/components.css',
  '/css/animations.css',
  '/js/api.js',
  '/js/app.js',
  '/js/capabilities.js',
  '/js/connection.js',
  '/js/host-session.js',
  '/js/file-browser.js',
  '/js/drop-zone.js',
  '/js/transfer.js',
  '/js/ui.js',
  '/js/utils.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .catch((err) => console.warn('Failed to cache assets during install:', err))
  );
  // Activation deliberately waits: a new shell is applied when the page asks for it
  // via SKIP_WAITING, so an update cannot swap assets out mid-transfer.
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // APIs/WebSocket describe live state. Spike pages are measurement instruments and
  // must never be served from an older shell cache during a go/no-go run.
  if (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/spike/')
  ) {
    return;
  }

  // Cache-first for static shell assets with network fallback
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return networkResponse;
      });
    })
  );
});
