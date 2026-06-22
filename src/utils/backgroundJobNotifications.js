const ENABLED_KEY = "pulsepoint.backgroundJobs.notificationsEnabled";
const NOTIFIED_KEY = "pulsepoint.backgroundJobs.notifiedTerminalJobs.v1";
const NATIVE_CHANNEL_ID = "pulsepoint-background-jobs";
const DEV_SERVICE_WORKER_DISABLED = import.meta.env.DEV;

let nativeBridgePromise = null;
let nativeChannelReady = false;

function isNativeAppShell() {
  if (typeof window === "undefined") return false;
  if (window.location?.protocol === "capacitor:") return true;
  try {
    if (window.Capacitor?.isNativePlatform?.()) return true;
    return ["android", "ios"].includes(window.Capacitor?.getPlatform?.());
  } catch {
    return false;
  }
}

async function getNativeBridge() {
  if (!isNativeAppShell()) return null;
  if (!nativeBridgePromise) {
    nativeBridgePromise = Promise.all([
      import("@capacitor/core"),
      import("@capacitor/local-notifications"),
    ]).then(([core, notifications]) => {
      const Capacitor = core.Capacitor;
      if (Capacitor?.isNativePlatform && !Capacitor.isNativePlatform()) return null;
      return { Capacitor, LocalNotifications: notifications.LocalNotifications };
    }).catch(() => null);
  }
  return nativeBridgePromise;
}

function stableNotificationId(job) {
  const seed = `${job?.id || "pulsepoint"}:${job?.status || "complete"}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
  }
  return Math.abs(hash % 2147480000) || 1001;
}

async function ensureNativeChannel(LocalNotifications) {
  if (nativeChannelReady || !LocalNotifications?.createChannel) return;
  try {
    await LocalNotifications.createChannel({
      id: NATIVE_CHANNEL_ID,
      name: "Sarah Background Jobs",
      description: "Completion alerts for Sarah analysis, audio, and video renders.",
      importance: 4,
      visibility: 1,
      lights: true,
      vibration: true,
    });
    nativeChannelReady = true;
  } catch {
    nativeChannelReady = true;
  }
}

function storageValue(storage, key, fallback) {
  try {
    return JSON.parse(storage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

export function isNotificationSupported() {
  return isNativeAppShell() || (typeof window !== "undefined" && "Notification" in window);
}

export function getNotificationPermission() {
  if (isNativeAppShell()) {
    return storageValue(window.localStorage, ENABLED_KEY, false) === true ? "granted" : "default";
  }
  return isNotificationSupported() ? window.Notification.permission : "unsupported";
}

export function areBackgroundNotificationsEnabled() {
  if (isNativeAppShell()) return storageValue(window.localStorage, ENABLED_KEY, false) === true;
  if (!isNotificationSupported() || getNotificationPermission() !== "granted") return false;
  return storageValue(window.localStorage, ENABLED_KEY, false) === true;
}

export function isNotificationServiceWorkerDisabled() {
  return DEV_SERVICE_WORKER_DISABLED;
}

function canUseWindowNotificationConstructor() {
  if (typeof window === "undefined") return false;
  if (isNativeAppShell()) return false;
  if (window.matchMedia?.("(display-mode: standalone)")?.matches) return false;
  if (navigator.standalone) return false;
  return typeof window.Notification === "function";
}

export function setBackgroundNotificationsEnabled(enabled) {
  try {
    window.localStorage.setItem(ENABLED_KEY, JSON.stringify(Boolean(enabled)));
  } catch {
    // Notification preference storage is optional.
  }
}

export async function requestBackgroundNotificationPermission() {
  const nativeBridge = await getNativeBridge();
  if (nativeBridge?.LocalNotifications) {
    const { LocalNotifications } = nativeBridge;
    const existing = await LocalNotifications.checkPermissions().catch(() => null);
    const next = existing?.display === "granted"
      ? existing
      : await LocalNotifications.requestPermissions().catch(() => null);
    const permission = next?.display === "granted" ? "granted" : next?.display === "denied" ? "denied" : "default";
    setBackgroundNotificationsEnabled(permission === "granted");
    if (permission === "granted") await ensureNativeChannel(LocalNotifications);
    return permission;
  }
  if (!isNotificationSupported()) return "unsupported";
  const permission = await window.Notification.requestPermission();
  setBackgroundNotificationsEnabled(permission === "granted");
  return permission;
}

export function shouldNotifyForBackgroundJob() {
  return areBackgroundNotificationsEnabled()
    && (document.hidden || document.visibilityState !== "visible" || !document.hasFocus());
}

function canNotifyForBackgroundJob({ force = false } = {}) {
  return areBackgroundNotificationsEnabled()
    && (force || document.hidden || document.visibilityState !== "visible" || !document.hasFocus());
}

function notificationKey(job) {
  return `${job?.id || "unknown"}:${job?.status || "terminal"}`;
}

function hasNotified(job) {
  try {
    const keys = storageValue(window.sessionStorage, NOTIFIED_KEY, []);
    return Array.isArray(keys) && keys.includes(notificationKey(job));
  } catch {
    return false;
  }
}

function markNotified(job) {
  try {
    const keys = storageValue(window.sessionStorage, NOTIFIED_KEY, []);
    const next = [...new Set([...(Array.isArray(keys) ? keys : []), notificationKey(job)])].slice(-100);
    window.sessionStorage.setItem(NOTIFIED_KEY, JSON.stringify(next));
  } catch {
    // Dedupe storage is best-effort for the active browser session.
  }
}

export function buildSafeJobNotification(job) {
  if (job?.status === "error") {
    return {
      title: "Sarah job failed",
      body: "Open Sarah for details.",
    };
  }
  return {
    title: "Sarah analysis complete",
    body: "Your analysis is ready.",
  };
}

function waitForNotificationRegistration(timeoutMs) {
  if (!navigator.serviceWorker.ready) return Promise.resolve(null);
  return Promise.race([
    navigator.serviceWorker.ready.catch(() => null),
    new Promise((resolve) => window.setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

export async function getReadyServiceWorkerRegistration({ timeoutMs = 1500 } = {}) {
  if (DEV_SERVICE_WORKER_DISABLED) return null;
  if (!("serviceWorker" in navigator)) return null;

  const readyRegistration = await waitForNotificationRegistration(timeoutMs);
  if (readyRegistration?.showNotification) return readyRegistration;

  try {
    const existing = await navigator.serviceWorker.getRegistration?.();
    if (existing?.showNotification) return existing;
    if (window.isSecureContext && navigator.serviceWorker.register) {
      const registered = await navigator.serviceWorker.register("/sw.js");
      if (registered?.showNotification) return registered;
    }
    return existing || null;
  } catch {
    return null;
  }
}

async function showNativeNotification(job, message, { route } = {}) {
  const nativeBridge = await getNativeBridge();
  if (!nativeBridge?.LocalNotifications) return false;
  const { LocalNotifications } = nativeBridge;
  const permission = await LocalNotifications.checkPermissions().catch(() => null);
  if (permission?.display !== "granted") return false;
  await ensureNativeChannel(LocalNotifications);
  await LocalNotifications.schedule({
    notifications: [
      {
        id: stableNotificationId(job),
        title: message.title,
        body: message.body,
        channelId: NATIVE_CHANNEL_ID,
        schedule: { at: new Date(Date.now() + 100) },
        extra: {
          route: route || "/",
          jobId: job?.id || null,
          jobStatus: job?.status || null,
        },
      },
    ],
  });
  return true;
}

export async function notifyBackgroundJobFinished(job, { route, onOpen, force = false } = {}) {
  if (!["complete", "error"].includes(job?.status) || !canNotifyForBackgroundJob({ force }) || hasNotified(job)) {
    return false;
  }

  const message = buildSafeJobNotification(job);
  const options = {
    body: message.body,
    icon: "/icons/sarah-192.png",
    badge: "/icons/sarah-192.png",
    tag: `pulsepoint-job-${job.id}-${job.status}`,
    requireInteraction: false,
    data: { route: route || "/" },
  };

  try {
    const nativeSent = await showNativeNotification(job, message, { route });
    if (nativeSent) {
      markNotified(job);
      return true;
    }

    const registration = await getReadyServiceWorkerRegistration({ timeoutMs: force ? 2200 : 1500 });
    if (registration?.showNotification) {
      await registration.showNotification(message.title, options);
      markNotified(job);
      return true;
    }

    if ("serviceWorker" in navigator || !canUseWindowNotificationConstructor()) return false;

    const notification = new window.Notification(message.title, options);
    notification.onclick = () => {
      notification.close();
      window.focus();
      onOpen?.(route || "/");
    };
    markNotified(job);
    return true;
  } catch {
    return false;
  }
}

export async function sendBackgroundTestNotification({ route = "/settings", onOpen } = {}) {
  const job = {
    id: `test-${Date.now()}`,
    status: "complete",
  };
  const message = {
    title: "Sarah is ready",
    body: "Local notifications are working. Tap to open Settings & Status.",
  };

  const nativeSent = await showNativeNotification(job, message, { route });
  if (nativeSent) return true;

  if (!isNotificationSupported() || getNotificationPermission() !== "granted") return false;
  const options = {
    body: message.body,
    icon: "/icons/sarah-192.png",
    badge: "/icons/sarah-192.png",
    tag: "pulsepoint-test-notification",
    renotify: true,
    data: { route },
  };
  const registration = await getReadyServiceWorkerRegistration({ timeoutMs: 1500 });
  if (registration?.showNotification) {
    await registration.showNotification(message.title, options);
    return true;
  }
  if ("serviceWorker" in navigator || !canUseWindowNotificationConstructor()) return false;
  const notification = new window.Notification(message.title, options);
  notification.onclick = () => {
    notification.close();
    window.focus();
    onOpen?.(route);
  };
  return true;
}

export function listenForBackgroundNotificationActions(onOpen) {
  let removeListener = null;
  let cancelled = false;
  getNativeBridge().then(async (nativeBridge) => {
    if (cancelled || !nativeBridge?.LocalNotifications?.addListener) return;
    const handle = await nativeBridge.LocalNotifications.addListener("localNotificationActionPerformed", (event) => {
      const route = event?.notification?.extra?.route;
      if (route) onOpen?.(route);
    }).catch(() => null);
    if (cancelled) {
      handle?.remove?.();
      return;
    }
    removeListener = () => handle?.remove?.();
  });
  return () => {
    cancelled = true;
    removeListener?.();
  };
}
