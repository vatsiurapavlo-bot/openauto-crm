/* OpenAuto CRM — service worker.
   Buforuje wyłącznie powłokę aplikacji (HTML/JS/CSS/ikony), aby aplikacja otwierała się szybko
   i dała się zainstalować. Żądania /api/* NIGDY nie są buforowane — dane finansowe zawsze na żywo. */
const VERSION = '__BUILD_ID__';
const CACHE = 'openauto-shell-' + VERSION;
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', __ASSETS__];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    // sieć najpierw; offline → zbuforowana powłoka (aplikacja pokaże komunikat o braku połączenia)
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
