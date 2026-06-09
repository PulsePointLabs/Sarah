const ENABLED_KEY = "pulsepoint.backgroundJobs.notificationsEnabled";
const NOTIFIED_KEY = "pulsepoint.backgroundJobs.notifiedTerminalJobs.v1";

function storageValue(storage, key, fallback) {
  try {
    return JSON.parse(storage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

export function isNotificationSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

export function getNotificationPermission() {
  return isNotificationSupported() ? window.Notification.permission : "unsupported";
}

export function areBackgroundNotificationsEnabled() {
  if (!isNotificationSupported() || getNotificationPermission() !== "granted") return false;
  return storageValue(window.localStorage, ENABLED_KEY, false) === true;
}

export function setBackgroundNotificationsEnabled(enabled) {
  try {
    window.localStorage.setItem(ENABLED_KEY, JSON.stringify(Boolean(enabled)));
  } catch {
    // Notification preference storage is optional.
  }
}

export async function requestBackgroundNotificationPermission() {
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
      title: "PulsePoint job failed",
      body: "Open PulsePoint for details.",
    };
  }
  return {
    title: "PulsePoint analysis complete",
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

export async function notifyBackgroundJobFinished(job, { route, onOpen, force = false } = {}) {
  if (!["complete", "error"].includes(job?.status) || !canNotifyForBackgroundJob({ force }) || hasNotified(job)) {
    return false;
  }

  const message = buildSafeJobNotification(job);
  const options = {
    body: message.body,
    icon: "/icons/pulsepoint-192.png",
    badge: "/icons/pulsepoint-192.png",
    tag: `pulsepoint-job-${job.id}-${job.status}`,
    requireInteraction: false,
    data: { route: route || "/" },
  };

  try {
    const registration = await getReadyServiceWorkerRegistration({ timeoutMs: force ? 2200 : 1500 });
    if (registration?.showNotification) {
      await registration.showNotification(message.title, options);
      markNotified(job);
      return true;
    }

    if ("serviceWorker" in navigator) return false;

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
