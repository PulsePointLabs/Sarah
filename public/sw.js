// PWA_FULL_SEND_V1
// PWA_NO_FOCUS_RELOAD_V1
// PWA_RESUME_NO_NAVIGATE_V1
// PWA_FOREGROUND_STABILITY_V1
// PWA_ACTIVATE_WITHOUT_CLAIM_V2
// PWA_NAVIGATE_CACHED_SHELL_FIRST_V1
// PWA_NO_SKIP_WAITING_ON_INSTALL_V1
// PWA_NOTIFICATION_FOCUS_NO_NAVIGATE_V1
// PWA_MINIMAL_NOTIFICATION_WORKER_V1
// PWA_SAFE_WAITING_UPDATE_V1
const CACHE_PREFIX = "pulsepoint-shell-";
const CACHE_PREFIXES = ["pulsepoint-shell-", "workbox-", "vite-"];
const SW_BUILD_ID = "sarah-sw-safe-waiting-update-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.resolve());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)))
        .map((key) => caches.delete(key))))
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SARAH_SW_VERSION") {
    event.source?.postMessage?.({ type: "SARAH_SW_VERSION", buildId: SW_BUILD_ID });
    return;
  }
  if (["SARAH_SKIP_WAITING", "PULSEPOINT_SKIP_WAITING"].includes(event.data?.type)) {
    self.skipWaiting();
    return;
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate") return;

  event.respondWith(
    fetch(request, { cache: "no-store" }).catch(() => new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sarah offline</title></head><body style="margin:0;background:#f7f1fa;color:#281f30;font-family:system-ui,sans-serif;display:grid;min-height:100vh;place-items:center;text-align:center;padding:24px"><main><h1 style="font-size:20px">Sarah is offline</h1><p style="color:#6b5a76">The local server or Tailscale route is not reachable. Reopen or reload once the desktop app is online.</p></main></body></html>`,
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
