// PWA_FULL_SEND_V1
// PWA_NO_FOCUS_RELOAD_V1
// PWA_RESUME_NO_NAVIGATE_V1
// PWA_FOREGROUND_STABILITY_V1
// PWA_ACTIVATE_WITHOUT_CLAIM_V2
// PWA_NAVIGATE_CACHED_SHELL_FIRST_V1
// PWA_NO_SKIP_WAITING_ON_INSTALL_V1
// PWA_NOTIFICATION_FOCUS_NO_NAVIGATE_V1
// PWA_MINIMAL_NOTIFICATION_WORKER_V1
const CACHE_PREFIX = "pulsepoint-shell-";

self.addEventListener("install", (event) => {
  // Keep this worker inert. It exists for Android notification delivery, not
  // offline shell caching. Do not call skipWaiting here: Android/Chrome can
  // install an update when the PWA regains focus, and immediately activating it
  // can interrupt background jobs or audio playback in the installed app.
});

self.addEventListener("activate", (event) => {
  // Do not call clients.claim() here. Claiming an already-open PWA can fire a
  // controllerchange while audio is playing, and older app bundles may respond
  // by refreshing the page when Android/Chrome resumes the app.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX))
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
