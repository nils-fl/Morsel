// Morsel's service worker: keeps the app, its fonts included (src/fonts.css), in the browser, so it starts (and installs
// as an app) without a network. The serviceWorker plugin in vite.config.ts fills in the build (below) and writes it to
// dist/sw.js; main.tsx registers it in production builds. The app lives under /app/ (the landing page is at /).
const { version, files } = __BUILD__;
const APP = `morsel-${version}`;
// The app's page: every page under it is the same index.html.
const APP_PAGE = "/app/";
// How long a page load waits for the network before it starts from the cached app.
const PAGE_TIMEOUT_MS = 3000;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    await (await caches.open(APP)).addAll(files);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // Older versions, and the Google Fonts cache from before the fonts were served from the site.
    for (const key of await caches.keys()) if (key.startsWith("morsel-") && key !== APP) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (req.mode !== "navigate") e.respondWith(asset(req));
    else e.respondWith(url.pathname.startsWith(APP_PAGE) ? page(req) : sitePage(req));
  }
});

/** The page from the network, so a new version shows on the next load; the cached one offline or on a slow network. */
async function page(req) {
  const cache = await caches.open(APP);
  const net = fetch(req).then((res) => {
    if (res.ok) void cache.put(APP_PAGE, res.clone());
    return res;
  });
  const res = await Promise.race([net.catch(() => null), new Promise((r) => setTimeout(r, PAGE_TIMEOUT_MS))]);
  return res ?? (await cache.match(APP_PAGE)) ?? net;
}

/** The site's other pages (the landing page) from the network; offline, the app, so an app installed when it was at / still starts. */
async function sitePage(req) {
  try {
    return await fetch(req);
  } catch (err) {
    return (await caches.match(APP_PAGE)) ?? Promise.reject(err);
  }
}

/** Built files have content hashes in their names, so a cached copy is always right. */
async function asset(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // A missing file comes back as index.html (single-page fallback): not something to keep under its name.
  if (res.ok && new URL(req.url).pathname.startsWith("/assets/") && !res.headers.get("content-type")?.startsWith("text/html")) {
    void (await caches.open(APP)).put(req, res.clone());
  }
  return res;
}

