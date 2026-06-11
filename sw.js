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
 * close.
 *
 * Offline: the app is self-contained (HTML/CSS/JS inline, localStorage data),
 * so the cached shell runs with no network. Google Fonts are cached stale-while-
 * revalidate so type still looks right offline. Firebase cloud sync and the
 * Notion proxy are intentionally left to the network — they simply pause offline
 * and resume when a connection returns.
 */
const CACHE = 'focus-den-runtime';
const FONT_CACHE = 'focus-den-fonts';
const FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
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
    const keep = [CACHE, FONT_CACHE];
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));        // our shell: freshest online, cache offline
  } else if (FONT_ORIGINS.includes(url.origin)) {
    event.respondWith(staleWhileRevalidate(req)); // fonts: instant + cached for offline
  }
  // Everything else (Firebase, Notion proxy) goes straight to the network as-is.
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

// Fonts: serve cache immediately if we have it, refresh in the background.
// Works with opaque (status 0) font responses, so we don't gate on .ok here.
async function staleWhileRevalidate(req) {
  const cache = await caches.open(FONT_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

// Lets the page trigger an immediate activation if it ever sends a message.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

/* Web Push (focus/break-end notification when the app is fully closed). The push
   payload is JSON {title, body, tag} sent by the Cloudflare cron worker. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { try { data = { body: event.data && event.data.text() }; } catch (_) { data = {}; } }
  const title = data.title || 'Focus Den';
  const opts = {
    body: data.body || '',
    icon: 'icon-192.png', badge: 'icon-192.png',
    tag: data.tag || 'fd-timer', renotify: true,
    data: { url: './' }
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

// Tapping the banner focuses an open Focus Den window or opens one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { try { await w.focus(); return; } catch (e) {} } }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
