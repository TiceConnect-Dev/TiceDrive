/* Service worker : appli installable, coquille hors ligne et réception des fichiers partagés (Android) */
const CACHE = 'ed-shell-v4';
const BASE = new URL(self.registration.scope).pathname; // « / » ou « /drive/ »
const SHELL = ['app.css', 'common.js', 'app.js', 'favicon.svg', 'icon-192.png', 'manifest.webmanifest', 'vendor/qrcode.js'].map(p => BASE + p);

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('ed-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(BASE)) return;
  const rel = url.pathname.slice(BASE.length);
  // Fichiers partagés depuis une autre appli (menu « Partager » d'Android)
  if (e.request.method === 'POST' && rel === 'share-target') {
    e.respondWith((async () => {
      const fd = await e.request.formData();
      const cache = await caches.open('ed-share');
      let i = 0;
      for (const f of fd.getAll('files')) {
        if (!(f instanceof File)) continue;
        await cache.put(BASE + 'shared-file/' + Date.now() + '-' + (i++), new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Name': encodeURIComponent(f.name || 'fichier') } }));
      }
      const text = [fd.get('title'), fd.get('text')].filter(Boolean).join('\n');
      if (!i && text) await cache.put(BASE + 'shared-file/' + Date.now(), new Response(text, { headers: { 'Content-Type': 'text/plain', 'X-Name': encodeURIComponent('Note partagée.txt') } }));
      return Response.redirect(BASE + '?share-target=1', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET') return;
  if (/^(api|dav|oo|s|edit)(\/|$)/.test(rel)) return;
  if (SHELL.includes(url.pathname)) {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hors ligne</title><body style="font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#161616"><div style="text-align:center"><h1 style="color:#000091">Hors ligne</h1><p>Vérifiez votre connexion puis réessayez.</p><button onclick="location.reload()" style="background:#000091;color:#fff;border:0;padding:10px 18px;font-size:16px">Réessayer</button></div>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
  }
});
