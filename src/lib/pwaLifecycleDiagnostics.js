const STORAGE_KEY = "sarah.pwa.lifecycle.v1";
const BOOT_KEY = "sarah.pwa.bootId";
const MAX_EVENTS = 160;

function safeNow() {
  return new Date().toISOString();
}

function readEvents() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function writeEvents(events) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch {
    // Local diagnostics should never break app startup.
  }
}

export function lifecycleBootId() {
  try {
    let id = sessionStorage.getItem(BOOT_KEY);
    if (!id) {
      id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem(BOOT_KEY, id);
    }
    return id;
  } catch {
    return "unknown";
  }
}

export function recordPwaLifecycleEvent(type, detail = {}) {
  if (typeof window === "undefined") return;
  const nav = performance.getEntriesByType?.("navigation")?.[0];
  const event = {
    type,
    at: safeNow(),
    bootId: lifecycleBootId(),
    route: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    focused: document.hasFocus?.() ?? null,
    wasDiscarded: Boolean(document.wasDiscarded),
    navigationType: nav?.type || null,
    serviceWorker: {
      controller: Boolean(navigator.serviceWorker?.controller),
    },
    ...detail,
  };
  writeEvents([...readEvents(), event]);
  window.dispatchEvent(new CustomEvent("sarah:pwa-lifecycle", { detail: event }));
}

export function readPwaLifecycleDiagnostics() {
  return readEvents();
}

export function clearPwaLifecycleDiagnostics() {
  writeEvents([]);
}

export function installPwaLifecycleDiagnostics() {
  if (typeof window === "undefined" || window.__sarahPwaLifecycleInstalled) return;
  window.__sarahPwaLifecycleInstalled = true;
  recordPwaLifecycleEvent("boot", {
    userAgent: navigator.userAgent,
    standalone: window.matchMedia?.("(display-mode: standalone)")?.matches || navigator.standalone || false,
  });
  const record = (type, extra = {}) => recordPwaLifecycleEvent(type, extra);
  window.addEventListener("focus", () => record("focus"));
  window.addEventListener("blur", () => record("blur"));
  document.addEventListener("visibilitychange", () => record("visibilitychange"));
  window.addEventListener("pageshow", (event) => record("pageshow", { persisted: Boolean(event.persisted) }));
  window.addEventListener("pagehide", (event) => record("pagehide", { persisted: Boolean(event.persisted) }));
  window.addEventListener("online", () => record("online"));
  window.addEventListener("offline", () => record("offline"));
  window.addEventListener("beforeunload", () => record("beforeunload"));
  document.addEventListener("freeze", () => record("freeze"));
  document.addEventListener("resume", () => record("resume"));
  navigator.serviceWorker?.addEventListener?.("controllerchange", () => record("controllerchange"));
  navigator.serviceWorker?.addEventListener?.("message", (event) => record("service_worker_message", { messageType: event.data?.type || null }));
}
