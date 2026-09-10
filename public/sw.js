/*
 * Service worker: enough to be an installable app, deliberately not an
 * offline-first cache.
 *
 * Foovox is useless without the socket — there is no offline mode to fall
 * back to — so caching is only about the shell appearing instantly on launch.
 * Everything else, and every API call, goes to the network. A stale cache here
 * would mean a phone pinned to an old build with no obvious way to clear it,
 * which is a far worse failure than a slightly slower cold start.
 */

// v2: barge-in fixes. Bumping the name makes activate() delete the old
// cache, so a phone cannot keep serving the build that would not stop talking.
const CACHE = 'foovox-v20';
const SHELL = ['/', '/app.js', '/echo.js', '/level.js', '/intent.js', '/app.css', '/theme.css', '/capture-worklet.js', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never cache the API or the socket, and never serve a cached /login: the
  // redirect between signed-in and signed-out states has to be live.
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/login') return;
  if (event.request.method !== 'GET') return;

  // Network first, cache only as the fallback, so a new build always wins.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? Response.error())),
  );
});
