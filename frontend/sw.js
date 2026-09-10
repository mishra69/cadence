// Cadence service worker. Based on the pwa-cloudflare skill's template.
//
// The version is stamped into this file by deploy.sh, which is also what makes
// the worker install: a service worker only updates when its own bytes change,
// so reading the version from somewhere else would deadlock — the worker would
// serve the old value and the page would re-register what it already had.
const VERSION = '20260909_2039';
const CACHE = 'cadence-' + VERSION;

// The same suffix the HTML carries, built from the stamped VERSION above.
// These must be byte-identical strings or the page asks for a URL the cache has
// never held: fine online, and silently no offline support at all.
const V = '?v=' + VERSION;

const SHELL = [
  // '/' only, never '/index.html': Workers Static Assets 307-redirects
  // /index.html to /, and the Cache API refuses to store a redirected response.
  '/',
  '/css/styles.css' + V,
  '/js/config.js' + V,
  '/js/calc.js' + V,
  '/js/idb.js' + V,
  '/js/api.js' + V,
  '/js/charts.js' + V,
  '/js/lock.js' + V,
  '/js/version-check.js' + V,
  '/js/pwa-install.js' + V,
  '/js/app.js' + V,
  // Unversioned on purpose: client.js is a module that imports './sw.js'
  // relatively, and that inner request can't carry a version — so neither does
  // the outer one, or the pair would straddle two builds. These are vendored
  // copies that change only when the package does.
  '/js/vendor/webpush-edge/client.js',
  '/js/vendor/webpush-edge/sw.js',
  // Also unversioned: the manifest is fetched by the browser rather than the
  // page, and a URL that changes every deploy churns install state. Icons
  // change only when their content does.
  '/manifest.json',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // Cache each file independently: with addAll() a single 404 rejects the
      // whole install and the app silently loses offline support.
      .then(c => Promise.all(
        SHELL.map(url => c.add(url).catch(err => {
          console.warn('[sw] failed to precache', url, err);
        }))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Web Push ────────────────────────────────────────────────────────────────
//
// Hand-written rather than `import { createPushHandler } from 'webpush-edge/sw'`.
// Importing it would require registering this worker with { type: 'module' },
// and iOS is the entire reason the feature exists — not a bet worth taking. The
// contract below is the same one the library implements.

self.addEventListener('push', e => {
  // A push handler is required: on iOS, Declarative Web Push alone does not
  // display. A push event with no showNotification() call is also a spec
  // violation the browser may punish by revoking the subscription.
  let data = {};
  try {
    const payload = e.data ? e.data.json() : {};
    // webpush-edge sends the Declarative Web Push envelope:
    //   { web_push: 8030, notification: { title, body, navigate, ... } }
    // Reading those fields off the top level silently yields undefined for all
    // of them — so the title falls back to the app name, the body renders
    // empty, and navigate becomes '/', which is why tapping a check-in landed
    // on the app's default screen instead of the sweep. Accept either shape.
    data = payload.notification || payload;
  } catch {
    data = { body: e.data ? e.data.text() : '' };
  }

  // Title never varies and never says more than the app name — the body arrives
  // on a lock screen without anyone choosing to show it.
  e.waitUntil(self.registration.showNotification(data.title || 'Cadence', {
    body: data.body || '',
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/icon-192.png',
    tag: data.tag || 'cadence',
    renotify: false,
    data: { url: data.navigate || data.url || '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Focus an existing window rather than opening a second copy of the app.
    for (const c of all) {
      if (new URL(c.url).origin === location.origin) {
        await c.focus();
        if ('navigate' in c) await c.navigate(target).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

// Push services rotate endpoints. Without this the subscription silently dies
// and notifications just stop, with nothing user-visible to explain why. The
// worker holds no session token, so this posts to a public route authorised by
// possession of the old endpoint.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const oldEndpoint = e.oldSubscription?.endpoint
      || (await self.registration.pushManager.getSubscription())?.endpoint;
    try {
      const { key } = await fetch('/api/push/key').then(r => r.json());
      if (!key) return;
      const fresh = e.newSubscription || await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(key),
      });
      await fetch('/api/push/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_endpoint: oldEndpoint, subscription: fresh.toJSON() }),
      });
    } catch (err) {
      console.warn('[sw] resubscribe failed', err);
    }
  })());
});

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Never touch the cache for non-GET or cross-origin requests. Google's
  // sign-in script is cross-origin and lands here on every visit.
  if (request.method !== 'GET' || url.origin !== location.origin) return;

  // Network-only for API calls. The 503 is JSON so the client can parse it and
  // fall back to its own cached stats rather than showing an error page.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(request).catch(() => new Response(JSON.stringify({ error: 'offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }))
    );
    return;
  }

  // Network-first for navigations so a deploy is picked up on the next launch;
  // falls back to the cached shell when offline.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok && !res.redirected) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put('/', clone));
          }
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Version probes (?_v=) must reach the network — otherwise the app compares
  // the cache against itself and can never notice it's running an old build.
  if (url.searchParams.has('_v')) {
    e.respondWith(fetch(request));
    return;
  }

  // Cache-first for static assets, refreshing the cache in the background.
  e.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(request, clone));
        }
        return res;
      }).catch(err => {
        if (cached) return cached;
        throw err;
      });
      return cached || network;
    })
  );
});
