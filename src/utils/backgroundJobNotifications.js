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

async function getReadyServiceWorkerRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  if (navigator.serviceWorker.ready) {
    try {
      return await navigator.serviceWorker.ready;
    } catch {
      // Fall through to best-effort registration lookup.
    }
  }
  return navigator.serviceWorker.getRegistration?.() || null;
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
    const registration = await getReadyServiceWorkerRegistration();
    if (registration?.showNotification) {
      await registration.showNotification(message.title, options);
      markNotified(job);
      return true;
    }

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
