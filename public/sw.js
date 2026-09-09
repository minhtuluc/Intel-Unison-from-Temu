/**
 * UniversalTrans Service Worker
 * Network-first for API, cache-first for app shell.
 */

const CACHE_NAME = 'utrans-shell-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/variables.css',
  '/css/base.css',
  '/css/layout.css',
  '/css/components.css',
  '/css/animations.css',
  '/js/app.js',
  '/js/connection.js',
  '/js/file-browser.js',
  '/js/drop-zone.js',
  '/js/transfer.js',
  '/js/ui.js',
  '/js/utils.js',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
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

  // Network-first for API and WebSocket
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) {
    return;
  }

  // Cache-first for static shell assets
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
