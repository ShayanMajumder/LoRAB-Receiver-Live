// Service worker: makes the app installable and lets it open offline.
// Network first, so a published update is picked up on the next load.

const CACHE = "lorab-receiver-v4";
const SHELL = [
  "./", "index.html", "style.css", "manifest.webmanifest", "icon.svg",
  "js/app.js", "js/radio.js", "js/airspy.js", "js/rtlsdr.js", "js/dsp.js", "js/demo.js",
  "js/worker.js", "js/station-worker.js", "js/station-core.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("index.html"))),
  );
});
