/*
 * Lines service worker — push and notification clicks ONLY.
 *
 * There is deliberately no `fetch` handler and no cache. A caching worker could
 * serve a stale bundle to a newer bridge (the version-skew problem the app was
 * previously installable without any worker to avoid); with no fetch handler
 * every request still goes to the network, so that cannot happen.
 *
 * Served with `Cache-Control: no-cache` (deploy/docker/web-nginx.conf) so an
 * update lands on the next navigation, and it activates straight away.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Not ours, or corrupt. Still shown below: iOS revokes a subscription whose
    // pushes arrive without a notification.
  }
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
  const title = typeof data.title === 'string' && data.title ? data.title : 'Lines';
  const body = typeof data.body === 'string' ? data.body : '';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // Same tag as the page's in-app alert, so the two collapse into one.
      tag: sessionId ?? undefined,
      icon: '/icon-192.png',
      data: { sessionId },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data && event.notification.data.sessionId;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (open) {
        // postMessage before focus: focus() can reject (no user activation on
        // some platforms), and the page still has to land on the session.
        if (sessionId) open.postMessage({ type: 'openSession', sessionId });
        try {
          await open.focus();
        } catch {
          // ignore — the page asks its shell to raise the window itself
        }
        return;
      }
      await self.clients.openWindow(sessionId ? `/session/${encodeURIComponent(sessionId)}` : '/');
    })(),
  );
});
