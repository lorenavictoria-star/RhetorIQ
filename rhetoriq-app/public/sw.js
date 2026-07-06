const CACHE = 'rhetoriq-v72';
const ASSETS = ['./index.html', './manifest.json', './onboarding.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('api.anthropic.com') || e.request.url.includes('fonts.googleapis.com')) {
    return;
  }
  // Always fetch index.html fresh from network
  if (e.request.mode === 'navigate' || e.request.url.endsWith('/') || e.request.url.endsWith('/index.html')) {
    e.respondWith(fetch(e.request).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
