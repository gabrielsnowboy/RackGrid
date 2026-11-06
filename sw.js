// RackGrid offline support: keeps the app itself available without a connection.
// Your data is stored separately (local storage / IndexedDB) and synced by the app.
const CACHE = "rackgrid-v4";
const CORE = ["./", "./index.html", "./config.js", "./vendor/supabase.js", "./manifest.webmanifest"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.hostname.endsWith(".supabase.co") || url.pathname.includes("/rest/v1/") || url.pathname.includes("/storage/v1/") || url.pathname.includes("/auth/v1/")) return; // live data: never cached here
  const sameOrigin = url.origin === location.origin;
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) || url.hostname === "cdnjs.cloudflare.com";
  if (!sameOrigin && !isFont) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: req.mode === "navigate" }) || (req.mode === "navigate" && await cache.match("./index.html"));
      if (hit) return hit;
      throw err;
    }
  })());
});
