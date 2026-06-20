const STORAGE_KEY = "sarah.pwa.lifecycle.v1";
const BOOT_KEY = "sarah.pwa.bootId";
const DOC_KEY = "sarah.pwa.documentId";
const COUNTS_KEY = "sarah.pwa.mountCounts";
const STATE_KEY = "sarah.pwa.stateCheckpoint.v1";
const MAX_EVENTS = 160;
const STATE_MAX_AGE_MS = 1000 * 60 * 60 * 8;

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

export function lifecycleDocumentId() {
  try {
    let id = window.name || "";
    if (!id.startsWith("sarah-doc-")) {
      id = `sarah-doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      window.name = id;
    }
    sessionStorage.setItem(DOC_KEY, id);
    return id;
  } catch {
    return "unknown";
  }
}

function readCounts() {
  try {
    return JSON.parse(sessionStorage.getItem(COUNTS_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeCounts(counts) {
  try {
    sessionStorage.setItem(COUNTS_KEY, JSON.stringify(counts || {}));
  } catch {
    // Ignore diagnostics storage failures.
  }
}

export function incrementLifecycleMountCount(name, detail = {}) {
  const counts = readCounts();
  counts[name] = Number(counts[name] || 0) + 1;
  writeCounts(counts);
  recordPwaLifecycleEvent(`${name}_mount`, {
    mountCount: counts[name],
    mountCounts: counts,
    ...detail,
  });
  return counts[name];
}

export function currentLifecycleMountCounts() {
  return readCounts();
}

export function recordPwaLifecycleEvent(type, detail = {}) {
  if (typeof window === "undefined") return;
  const nav = performance.getEntriesByType?.("navigation")?.[0];
  const event = {
    type,
    at: safeNow(),
    bootId: lifecycleBootId(),
    documentId: lifecycleDocumentId(),
    route: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    focused: document.hasFocus?.() ?? null,
    wasDiscarded: Boolean(document.wasDiscarded),
    navigationType: nav?.type || null,
    serviceWorker: {
      controller: Boolean(navigator.serviceWorker?.controller),
    },
    mountCounts: readCounts(),
    ...detail,
  };
  writeEvents([...readEvents(), event]);
  window.dispatchEvent(new CustomEvent("sarah:pwa-lifecycle", { detail: event }));
}

export function savePwaStateCheckpoint(reason = "checkpoint") {
  if (typeof window === "undefined") return null;
  const checkpoint = {
    savedAt: Date.now(),
    reason,
    bootId: lifecycleBootId(),
    documentId: lifecycleDocumentId(),
    route: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    scrollX: window.scrollX || 0,
    scrollY: window.scrollY || 0,
    visibilityState: document.visibilityState,
  };
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(checkpoint));
  } catch {
    return checkpoint;
  }
  recordPwaLifecycleEvent("state_checkpoint_saved", { reason });
  return checkpoint;
}

export function loadPwaStateCheckpoint() {
  try {
    const checkpoint = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
    if (!checkpoint?.route || !checkpoint?.savedAt) return null;
    if (Date.now() - Number(checkpoint.savedAt) > STATE_MAX_AGE_MS) return null;
    return checkpoint;
  } catch {
    return null;
  }
}

export function restorePwaRouteOnColdStart() {
  if (typeof window === "undefined") return null;
  const checkpoint = loadPwaStateCheckpoint();
  if (!checkpoint?.route) return null;

  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const isLaunchRoot = window.location.pathname === "/" && /(?:^|[?&])source=pwa(?:&|$)/.test(window.location.search || "");
  const target = checkpoint.route;
  if (!isLaunchRoot || !target || target === currentPath || target === "/") return null;

  window.history.replaceState(window.history.state, "", target);
  recordPwaLifecycleEvent("cold_start_route_restored", {
    from: currentPath,
    to: target,
  });
  return target;
}

export function restorePwaScrollCheckpoint() {
  const checkpoint = loadPwaStateCheckpoint();
  if (!checkpoint) return false;
  const currentRoute = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (checkpoint.route !== currentRoute) return false;
  window.requestAnimationFrame?.(() => {
    window.scrollTo(checkpoint.scrollX || 0, checkpoint.scrollY || 0);
    recordPwaLifecycleEvent("scroll_checkpoint_restored", {
      scrollX: checkpoint.scrollX || 0,
      scrollY: checkpoint.scrollY || 0,
    });
  });
  return true;
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
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") savePwaStateCheckpoint("visibility_hidden");
    if (document.visibilityState === "visible") restorePwaScrollCheckpoint();
    record("visibilitychange");
  });
  window.addEventListener("pageshow", (event) => record("pageshow", { persisted: Boolean(event.persisted) }));
  window.addEventListener("pagehide", (event) => {
    savePwaStateCheckpoint("pagehide");
    record("pagehide", { persisted: Boolean(event.persisted) });
  });
  window.addEventListener("online", () => record("online"));
  window.addEventListener("offline", () => record("offline"));
  window.addEventListener("beforeunload", () => record("beforeunload"));
  document.addEventListener("freeze", () => {
    savePwaStateCheckpoint("freeze");
    record("freeze");
  });
  document.addEventListener("resume", () => {
    restorePwaScrollCheckpoint();
    record("resume");
  });
  navigator.serviceWorker?.addEventListener?.("controllerchange", () => record("controllerchange"));
  navigator.serviceWorker?.addEventListener?.("message", (event) => record("service_worker_message", { messageType: event.data?.type || null }));
}
