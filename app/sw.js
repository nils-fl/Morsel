// Morsel's service worker: keeps the app and its fonts in the browser, so it starts (and installs as an app) without
// a network. The serviceWorker plugin in vite.config.ts fills in the build (below) and writes it to dist/sw.js; main.tsx
// registers it in production builds. The app lives under /app/ (the landing page is at /).
const { version, files, fontCss } = __BUILD__;
const APP = `morsel-${version}`;
const FONTS = "morsel-fonts";
// The app's page: every page under it is the same index.html.
const APP_PAGE = "/app/";
// How long a page load waits for the network before it starts from the cached app.
const PAGE_TIMEOUT_MS = 3000;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    await (await caches.open(APP)).addAll(files);
    // Without the fonts the app still works offline, in the fallback fonts.
    await cacheFonts().catch((err) => console.warn("Morsel: fonts not cached for offline use", err));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("morsel-") && key !== APP && key !== FONTS) await caches.delete(key);
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
  else if (url.hostname === "fonts.googleapis.com") e.respondWith(fontCssFor(req, e));
  else if (url.hostname === "fonts.gstatic.com") e.respondWith(font(req));
});

/** The Google Fonts stylesheets index.html links, and every font file they name (all subsets: the browser picks). */
async function cacheFonts() {
  const cache = await caches.open(FONTS);
  for (const href of fontCss) {
    const res = await fetch(href);
    if (!res.ok) throw new Error(`${href}: ${res.status}`);
    const css = await res.clone().text();
    await cache.put(href, res);
    // A variable font serves every weight from one file, and addAll refuses a list with the same URL twice.
    await cache.addAll([...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]))]);
  }
}

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

/** The stylesheet from the cache, refreshed in the background. Vary is ignored: the page and cacheFonts fetch it differently. */
async function fontCssFor(req, e) {
  const cache = await caches.open(FONTS);
  const hit = await cache.match(req, { ignoreVary: true });
  const net = fetch(req).then((res) => {
    if (res.ok) void cache.put(req, res.clone());
    return res;
  });
  if (!hit) return net;
  e.waitUntil(net.catch(() => {}));
  return hit;
}

/** Font files never change under their URL. */
async function font(req) {
  const cache = await caches.open(FONTS);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) void cache.put(req, res.clone());
  return res;
}
