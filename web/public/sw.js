/**
 * Minimal app-shell service worker.
 *
 * v1 has no offline write support — gates have connectivity, and queuing an
 * approval offline would break the first-decision-wins guarantee. So this only
 * makes the shell load instantly and survive a flaky moment.
 *
 * API calls and photos are never cached: stale visitor data at a gate is worse
 * than a spinner.
 */

const CACHE = 'gatepass-shell-v2';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network first, cached shell only as a fallback, so a deploy is
  // picked up on the next load rather than being pinned to an old bundle.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }

  // Hashed build assets are immutable — serve from cache and backfill.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok && url.pathname.startsWith('/assets/')) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});

/* ------------------------------------------------------------ Web Push --- */

/**
 * Puts the alert in the phone's notification shade. This fires whether or not
 * the app is open — that is the whole point of push over polling.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: 'GatePass', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'GatePass';
  // Something waiting for a decision should stay on screen until dealt with;
  // an informational update can be dismissed by the system.
  const needsAction = data.type === 'VISIT_PENDING' || data.type === 'VISIT_UNATTENDED';

  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // Collapse repeat alerts about the same visit rather than stacking them,
      // but still re-alert so an escalation is noticed.
      tag: data.visitId ? `visit-${data.visitId}` : `gatepass-${data.id || Date.now()}`,
      renotify: true,
      requireInteraction: needsAction,
      vibrate: needsAction ? [200, 100, 200] : [100],
      data: { url: data.url || '/', id: data.id || null },
    })
  );
});

/** Tapping the notification focuses an open tab if there is one, else opens it. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.includes(target) && 'focus' in client) return client.focus();
      }
      const open = windows[0];
      if (open && 'navigate' in open) return open.navigate(target).then((c) => c && c.focus());
      return self.clients.openWindow(target);
    })
  );
});
