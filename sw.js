/* Focus Den service worker — network-first, self-updating.
 *
 * Goal: a GitHub Pages push is picked up automatically, with NO manual cache
 * version bump. Every same-origin GET tries the network first and refreshes the
 * cache, so the freshest index.html/JS is served on the next launch when online.
 * The cache is only a fallback for offline use. Because content is never pinned
 * to a version string, you almost never need to touch this file again.
 *
 * skipWaiting() + clients.claim() mean that if this file *itself* ever changes,
 * the new worker takes over immediately instead of waiting for every tab to
 * close. Cross-origin requests (Google Fonts, Firebase, the Notion proxy) are
 * left completely untouched and go straight to the network.
 */
const CACHE = 'focus-den-runtime';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  // Only manage our own origin. Fonts / Firebase / Notion proxy go to network as-is.
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    // no-store so we always reach GitHub Pages, never a stale HTTP cache entry.
    const fresh = await fetch(req, { cache: 'no-store' });
    if (fresh && fresh.ok && fresh.type === 'basic') cache.put(req, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const shell = (await cache.match('./index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    throw err;
  }
}

// Lets the page trigger an immediate activation if it ever sends a message.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
