// Service Worker for TDR HVAC Field List (Offline PWA)
const CACHE_NAME = 'tdr-hvac-field-v17';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './master-data.js',
  './qrcode.min.js',
  './manifest.json',
  './favicon-6.png',
  './apple-touch-icon-6.png',
  './icon6-192.png',
  './icon6-512.png',
  'https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.warn('Cache addAll warning:', err);
      });
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Network-first for all app files so updates appear immediately; fallback to cache offline
  e.respondWith(
    fetch(e.request).then((networkResponse) => {
      if (networkResponse && networkResponse.status === 200) {
        const clone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
      }
      return networkResponse;
    }).catch(() => {
      return caches.match(e.request).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
