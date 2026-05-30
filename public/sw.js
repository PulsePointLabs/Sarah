// PWA_FULL_SEND_V1
// PWA_NO_FOCUS_RELOAD_V1
const CACHE_NAME = "pulsepoint-shell-v4";
const SHELL_ASSETS = [
  "/",
  "/manifest.json",
  "/icons/pulsepoint-icon.svg",
  "/icons/pulsepoint-192.png",
  "/icons/pulsepoint-512.png",
  "/icons/pulsepoint-maskable-512.png"
];

function isSensitiveOrDynamicRequest(url) {
  return (
    url.pathname.startsWith("/api") ||
    url.pathname.startsWith("/uploads") ||
    url.pathname.startsWith("/data") ||
    url.pathname.includes("/tts") ||
    url.pathname.includes("/audio") ||
    url.pathname.match(/\.(mp4|mov|webm|mkv|mp3|wav|m4a|ogg|csv|sqlite|db)$/i)
  );
}

function isDevelopmentAsset(url) {
  return (
    url.pathname.startsWith("/src/") ||
    url.pathname.startsWith("/@vite/") ||
    url.pathname.startsWith("/@react-refresh") ||
    url.pathname.startsWith("/node_modules/.vite/")
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("pulsepoint-shell-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "PULSEPOINT_SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isSensitiveOrDynamicRequest(url) || isDevelopmentAsset(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(() => caches.match("/") || Response.error())
    );
    return;
  }

  const isShellAsset = SHELL_ASSETS.includes(url.pathname) || url.pathname.startsWith("/icons/");
  if (isShellAsset) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }))
    );
    return;
  }

  event.respondWith(fetch(request));
});

self.addEventListener("notificationclick", (event) => {
  const route = event.notification?.data?.route || "/";
  event.notification?.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const existingClient = clients[0];
      if (existingClient) {
        await existingClient.focus();
        if ("navigate" in existingClient) return existingClient.navigate(route);
        return existingClient;
      }
      return self.clients.openWindow ? self.clients.openWindow(route) : null;
    })
  );
});
