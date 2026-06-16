// PWA_FULL_SEND_V1
// PWA_NO_FOCUS_RELOAD_V1
// PWA_RESUME_NO_NAVIGATE_V1
// PWA_FOREGROUND_STABILITY_V1
// PWA_ACTIVATE_WITHOUT_CLAIM_V2
// PWA_NAVIGATE_CACHED_SHELL_FIRST_V1
// PWA_NO_SKIP_WAITING_ON_INSTALL_V1
// PWA_NOTIFICATION_FOCUS_NO_NAVIGATE_V1
// PWA_MINIMAL_NOTIFICATION_WORKER_V1
// PWA_FORCE_RECOVER_FROM_OLD_OFFLINE_SHELL_V1
const CACHE_PREFIX = "pulsepoint-shell-";
const CACHE_PREFIXES = ["pulsepoint-shell-", "workbox-", "vite-"];

self.addEventListener("install", (event) => {
  // Force activation so phones controlled by an older offline-shell worker stop
  // serving stale cached HTML before the live app can clean itself up.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)))
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "PULSEPOINT_SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate") return;

  event.respondWith(
    fetch(request, { cache: "no-store" }).catch(() => new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>PulsePoint offline</title></head><body style="margin:0;background:#111827;color:#e5e7eb;font-family:system-ui,sans-serif;display:grid;min-height:100vh;place-items:center;text-align:center;padding:24px"><main><h1 style="font-size:20px">PulsePoint is offline</h1><p style="color:#9ca3af">The local server or Tailscale route is not reachable. Reopen or reload once the desktop app is online.</p></main></body></html>`,
      {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    ))
  );
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
