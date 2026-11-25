// Service worker: lets CafeMS be installed on a tablet or phone, and keeps the shared files (styles,
// scripts, fonts, icons) on the device so screens open quickly.
//
// It never stores staff pages or anything from /api, so nothing private or out of date is kept: those
// always come from the server, which checks the session on every request. With no connection, a
// public page falls back to a short "offline" page.
const VERSION = "cafems-v9.7";
const OFFLINE = "/offline.html";
const SHARED = /^\/(?:css|js|fonts|assets|vendor)\//;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll([OFFLINE, "/assets/favicon.svg", "/css/style.css?v=9.7"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  // Files from an older version are removed
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // Shared files carry a version in their address, so a stored copy never goes stale
  if (SHARED.test(url.pathname)) {
    event.respondWith(caches.open(VERSION).then(async (cache) => {
      const stored = await cache.match(request);
      if (stored) return stored;
      const response = await fetch(request);
      if (response.ok && url.search) cache.put(request, response.clone());
      return response;
    }));
    return;
  }

  // Pages always come from the server; only when it cannot be reached is the offline page shown
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
  }
});
