/* Swypik Web Push service worker. Registered as /sw-push.js */

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: "Swypik", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Swypik";
  const options = {
    body: data.body || "",
    icon: data.icon || "/icons/icon-192.png",
    badge: data.badge || "/icons/badge.png",
    tag: data.tag,
    data: {
      url: data.url || "/",
      notificationId: data.notificationId,
      type: data.type,
    },
    renotify: !!data.tag,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          try {
            const url = new URL(client.url);
            if (url.origin === self.location.origin) {
              client.focus();
              return client.navigate(targetUrl);
            }
          } catch (e) {
            // ignore
          }
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});
