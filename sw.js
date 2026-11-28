const CACHE_NAME = 'tum-rooms-shell-v3';
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './logic.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './data/rooms.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Richieste esterne (nav.tum.de, tile OSM, CDN Leaflet) sempre dirette alla rete
  if (url.origin !== self.location.origin) {
    return;
  }

  // Network-first per gli asset locali dell'app shell
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
