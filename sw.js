// Service worker KANGA — fonctionnement hors ligne
// Changer CACHE_VERSION à chaque mise à jour des fichiers pour forcer le rafraîchissement du cache.
const CACHE_VERSION = 'kanga-v4';
const CORE = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Les données Firebase ne passent jamais par le cache du service worker
  if (/firebaseio\.com|firebasedatabase\.app|googleapis\.com\/identitytoolkit/.test(url.host + url.pathname)) return;

  if (url.origin === self.location.origin) {
    // Fichiers de l'application : réseau d'abord (mises à jour immédiates), cache en secours hors ligne
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('index.html')))
    );
    return;
  }

  // Bibliothèques et polices externes (Firebase SDK versionné, Google Fonts) : cache d'abord
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE_VERSION).then(c => c.put(req, copy));
      return res;
    }))
  );
});
