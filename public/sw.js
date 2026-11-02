const CACHE_NAME = `tunnel-${self.registration.scope}-v3`;
const homeUrl = new URL('./', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.add(homeUrl)));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Only cache this application's static GET assets. Never cache API traffic.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin ||
      !url.href.startsWith(self.registration.scope) || url.pathname.includes('/api/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      // Network first so a new release cannot be hidden by cached HTML/chunks.
      const response = await fetch(event.request);
      if (response.ok && response.type === 'basic') {
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  const prefix = `tunnel-${self.registration.scope}-`;
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(prefix) && key !== CACHE_NAME).map(key => caches.delete(key))
  )));
});