// PWA_FULL_SEND_V1
// PWA_NO_FOCUS_RELOAD_V1
// PWA_RESUME_NO_NAVIGATE_V1
// PWA_FOREGROUND_STABILITY_V1
// PWA_ACTIVATE_WITHOUT_CLAIM_V2
// PWA_NAVIGATE_CACHED_SHELL_FIRST_V1
// PWA_NO_SKIP_WAITING_ON_INSTALL_V1
// PWA_NOTIFICATION_FOCUS_NO_NAVIGATE_V1
const CACHE_NAME = "pulsepoint-shell-v12";
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
      // Do not call skipWaiting here. Android/Chrome can install an update
      // when the PWA regains focus; immediately activating it can trigger
      // controllerchange and effectively reload the installed app. Let the new
      // worker wait until all existing app windows are closed.
  );
});

self.addEventListener("activate", (event) => {
  // Do not call clients.claim() here. Claiming an already-open PWA can fire a
  // controllerchange while audio is playing, and older app bundles may respond
  // by refreshing the page when Android/Chrome resumes the app.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("pulsepoint-shell-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "PULSEPOINT_SKIP_WAITING") {
    // Foreground stability is more important than immediate SW updates in
    // PulsePoint. Ignore legacy skip-waiting messages from older bundles.
    return;
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isSensitiveOrDynamicRequest(url) || isDevelopmentAsset(url)) return;

  if (request.mode === "navigate") {
    const networkRefresh = fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/", copy));
        }
        return response;
      })
      .catch(() => null);

    event.waitUntil(networkRefresh);
    event.respondWith(
      caches.match("/").then((cached) => cached || networkRefresh.then((response) => response || Response.error()))
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
        return existingClient;
      }
      return self.clients.openWindow ? self.clients.openWindow(route) : null;
    })
  );
});
