// Service worker: lets the app open instantly and work as a home-screen app.
// It only stores the app's own files. Requests to your pod are never cached.
// Network-first: when online you always get the latest version of the app.

const CACHE = 'companion-v26';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/api.js',
  'js/backup.js',
  'js/creator.js',
  'js/defaults.js',
  'js/format.js',
  'js/images.js',
  'js/importer.js',
  'js/library.js',
  'js/pod.js',
  'js/prompt.js',
  'js/store.js',
  'js/ui.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    // no-cache: always check GitHub for a newer copy instead of using the browser's saved one.
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
  );
});
