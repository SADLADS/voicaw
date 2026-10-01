// voicaw.com was the app until it moved to app.voicaw.com. Browsers that had it installed still
// have its service worker, which would keep serving the old app from its cache. When they check
// for an update they get this one instead: it takes over at once, empties the old caches, removes
// itself (and with it the old push subscription) and reloads the open pages, which then load from
// nginx: this site at /, a redirect to app.voicaw.com for everything else.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) client.navigate(client.url).catch(() => {});
  })());
});
