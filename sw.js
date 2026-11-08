// The site's main address now forwards to the free demo. Devices that installed the old app here
// get this worker once: it clears the old app's files, removes itself and reloads the page.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('marlow-app-') || /^marlow-[0-9a-f]{12}$/.test(k)).map((k) => caches.delete(k)));
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: 'window' });
    for (const w of windows) w.navigate(w.url);
  })());
});
