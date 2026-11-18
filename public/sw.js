'use strict';

// Service worker: maakt de app installeerbaar en laadt de app-schil ook zonder netwerk.
// Strategie "network first": online altijd de nieuwste versie, offline de laatst bekende.
// API-verzoeken (/api/*) worden NOOIT gecachet: contacten en sessies blijven alleen op de server.

const CACHE = 'shell-v2';
const SHELL = [
  '/',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/brand/favicon-64.png',
  '/brand/mark.png',
  '/brand/logo-light.webp',
  '/brand/logo-dark.webp',
  '/fonts/poppins-400.woff2',
  '/fonts/poppins-500.woff2',
  '/fonts/poppins-600.woff2',
  '/fonts/play-700.woff2',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        const key = req.mode === 'navigate' ? '/' : req;
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return res;
    } catch {
      const cached = await caches.match(req.mode === 'navigate' ? '/' : req);
      if (cached) return cached;
      return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
