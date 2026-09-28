/*
 * Swypik service worker (minimal, hand-written).
 *  - app-shell cache (offline fallback pentru navigări)
 *  - Web Push: handler `push` + `notificationclick`
 * Înregistrat de components/pwa/ServiceWorkerRegistrar.tsx.
 */

const CACHE_NAME = "swypik-shell-v3";
const SHELL_ASSETS = [
  "/",
  "/offline.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/favicon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// Network-first pentru navigări (fallback la shell din cache când e offline).
// Nu interceptăm API-uri sau asset-uri Next (au propriul caching).
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && url.pathname === "/") {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put("/", copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches
          .match(req)
          .then((hit) => hit || caches.match("/offline.html"))
          .then((hit) => hit || caches.match("/")),
      )
      .then((res) => res || Response.error()),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Swypik", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Swypik";
  const options = {
    body: data.body || "",
    icon: data.icon || "/icon-192.png",
    badge: data.badge || "/icon-192.png",
    tag: data.tag || undefined,
    data: { url: data.url || "/", ...(data.data || {}) },
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      // Anunță ferestrele deschise (ex: PWA curier) ca să reacționeze instant,
      // fără să aștepte următorul polling.
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((clients) => {
          for (const client of clients) {
            client.postMessage({ type: "push", payload: data });
          }
        })
        .catch(() => {}),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
