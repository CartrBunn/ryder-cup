// Service worker: shows push notifications from the send-push Edge Function and opens the app
// when one is tapped. Served from the app's base path, so its scope is the whole app.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Safari revokes a subscription that receives pushes without showing a notification, so on
// Apple devices one is always shown. Elsewhere, skip it while the app is open in front —
// the in-app pop-up already covers it.
const isApple = /iPhone|iPad|Macintosh/.test(navigator.userAgent) && !/Chrome|CriOS|Firefox|FxiOS|Edg/.test(navigator.userAgent);

self.addEventListener('push', e => e.waitUntil((async () => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  if (!d.body) return;

  if (!isApple) {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some(w => w.focused || w.visibilityState === 'visible')) return;
  }

  // A burst shows as one notification: fold this into the one already on screen.
  const tag = d.tag || 'rydercup';
  const [prev] = await self.registration.getNotifications({ tag });
  const lines = [...((prev && prev.data && prev.data.lines) || []), d.body].slice(-5);
  prev && prev.close();
  await self.registration.showNotification(
    lines.length > 1 ? `Ryder Cup · ${lines.length} updates` : 'Ryder Cup',
    {
      body: lines.slice().reverse().join('\n'),
      tag,
      renotify: true,
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-72.png',
      data: { lines, url: d.url || '#/chat' }
    });
})()));

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || '#/chat', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => w.url.startsWith(self.registration.scope));
    if (win) { await win.focus(); return win.navigate(target).catch(() => {}); }
    return self.clients.openWindow(target);
  })());
});
