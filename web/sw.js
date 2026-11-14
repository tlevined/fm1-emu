// The service worker: the whole page (its code, the emulator's wasm, the firmware list) kept for
// offline use, so the installed app opens with no network. Firmware packages are not cached here:
// the ROM library (library.js) keeps them in IndexedDB. build.sh writes BUILD and FILES.
const BUILD = "dev";
const FILES = ["./", "index.html", "style.css", "pwa.css", "main.js", "pwa.js", "library.js", "controllers.js",
  "persistence.js", "tryout.js", "worklet.js", "jit.js", "fwsc.js", "firmwares.json", "fm1_web.wasm",
  "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon-64.png"];
const SHELL = `fm1-shell-${BUILD}`;
const RUNTIME = "fm1-runtime";
// cross-origin JSON worth having offline: the Firmware Hub's list (new firmwares, newer packages)
const RUNTIME_HOSTS = ["thefirmwarehub.com"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // one by one, so a file missing from a partial build does not stop the rest
    await Promise.all(FILES.map((f) => cache.add(new Request(f, { cache: "reload" })).catch(() => {})));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("fm1-shell-") && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

// the page asks the waiting worker to take over (its "Reload to update" button)
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // the page itself, whatever its ?fw= / ?mhz=; everything else by path
    const navigate = req.mode === "navigate";
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(navigate ? new URL(url.pathname, url).href : req, { ignoreSearch: true });
      if (hit) return hit;
      try {
        const res = await fetch(req);
        // pages and files not in the list (the SMK-37's) are kept too, once seen
        if (res.ok && res.type === "basic") cache.put(navigate ? new URL(url.pathname, url).href : req, res.clone()).catch(() => {});
        return res;
      } catch (error) {
        if (navigate) return (await cache.match("index.html")) || Response.error();
        throw error;
      }
    })());
    return;
  }
  if (RUNTIME_HOSTS.includes(url.host) && url.pathname.endsWith(".json")) {
    // network first, the last copy when offline
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      } catch (error) {
        const hit = await cache.match(req);
        if (hit) return hit;
        throw error;
      }
    })());
  }
});
