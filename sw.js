// Generated at build. Caches the app so it opens with no connection.
const CACHE = 'marlow-ee31b8e1bf85';
const FILES = ["./","index.html","icon-192.png","icon-512.png","icon-maskable-512.png","icon.svg","manifest.webmanifest","assets/index-EfqZBpv-.js","assets/inbox-xe4L0eLe.js","assets/bodoni-moda-latin-400-normal-9rKXKbpF.woff","assets/bodoni-moda-latin-400-normal-CIWtV3SY.woff2","assets/bodoni-moda-latin-500-normal-B12im5S-.woff","assets/bodoni-moda-latin-500-normal-CtAcMono.woff2","assets/hanken-grotesk-latin-400-normal-BG6hkEXj.woff2","assets/hanken-grotesk-latin-400-normal-CjyVwvJV.woff","assets/hanken-grotesk-latin-500-normal-Bo-NxEKf.woff","assets/hanken-grotesk-latin-500-normal-DrDcrrxK.woff2","assets/hanken-grotesk-latin-600-normal-CIXX6EOa.woff2","assets/hanken-grotesk-latin-600-normal-NEn2C4Q3.woff","assets/hanken-grotesk-latin-700-normal-6IGCzoPh.woff","assets/hanken-grotesk-latin-700-normal-CeQ8H3UY.woff2","assets/index-CSVcykEp.css"];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new URL(f, self.registration.scope).href))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('marlow-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin || new URL(req.url).pathname.includes('/api/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.match(new URL('index.html', self.registration.scope).href).then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
});
