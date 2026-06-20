import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clearPwaLifecycleDiagnostics,
  currentLifecycleMountCounts,
  incrementLifecycleMountCount,
  loadPwaStateCheckpoint,
  recordPwaLifecycleEvent,
  restorePwaRouteOnColdStart,
  savePwaStateCheckpoint,
} from "./pwaLifecycleDiagnostics.js";

function storageMock() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}

function installBrowserMocks({ path = "/exploration/abc?display=focus" } = {}) {
  const [pathname, query = ""] = path.split("?");
  const search = query ? `?${query}` : "";
  globalThis.localStorage = storageMock();
  globalThis.sessionStorage = storageMock();
  globalThis.window = {
    name: "",
    location: { pathname, search, hash: "" },
    history: {
      state: null,
      replaceState: (_state, _title, next) => {
        const [nextPath, nextQuery = ""] = String(next).split("?");
        window.location.pathname = nextPath;
        window.location.search = nextQuery ? `?${nextQuery}` : "";
      },
    },
    scrollX: 3,
    scrollY: 456,
    dispatchEvent: () => {},
    requestAnimationFrame: (fn) => fn(),
  };
  globalThis.document = {
    visibilityState: "visible",
    hidden: false,
    wasDiscarded: false,
    hasFocus: () => true,
  };
  globalThis.performance = {
    getEntriesByType: () => [{ type: "navigate" }],
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { serviceWorker: { controller: {} } },
    configurable: true,
  });
}

test("lifecycle diagnostics track root/router/auth mount counts", () => {
  installBrowserMocks();
  clearPwaLifecycleDiagnostics();

  assert.equal(incrementLifecycleMountCount("react_root"), 1);
  assert.equal(incrementLifecycleMountCount("router_tree"), 1);
  assert.equal(incrementLifecycleMountCount("auth_provider"), 1);
  assert.equal(incrementLifecycleMountCount("auth_provider"), 2);

  assert.deepEqual(currentLifecycleMountCounts(), {
    react_root: 1,
    router_tree: 1,
    auth_provider: 2,
  });
});

test("state checkpoint restores the last route only on PWA cold-start root launch", () => {
  installBrowserMocks({ path: "/exploration/abc?display=focus" });
  savePwaStateCheckpoint("test");
  const saved = loadPwaStateCheckpoint();
  assert.equal(saved.route, "/exploration/abc?display=focus");

  window.location.pathname = "/";
  window.location.search = "?source=pwa";
  const restored = restorePwaRouteOnColdStart();
  assert.equal(restored, "/exploration/abc?display=focus");
  assert.equal(window.location.pathname, "/exploration/abc");
  assert.equal(window.location.search, "?display=focus");
});

test("same-document lifecycle events do not imply a new boot", () => {
  installBrowserMocks();
  clearPwaLifecycleDiagnostics();
  recordPwaLifecycleEvent("visibilitychange", { phase: "hidden" });
  recordPwaLifecycleEvent("visibilitychange", { phase: "visible" });

  const events = JSON.parse(localStorage.getItem("sarah.pwa.lifecycle.v1"));
  assert.equal(events.length, 2);
  assert.equal(events[0].bootId, events[1].bootId);
  assert.equal(events[0].documentId, events[1].documentId);
});

test("service worker does not force takeover during install or claim active clients", () => {
  const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
  const installBlock = source.match(/self\.addEventListener\("install"[\s\S]*?\n\}\);/)?.[0] || "";

  assert.equal(/skipWaiting\(/.test(installBlock), false);
  assert.equal(/clients\.claim\(/.test(source), false);
  assert.match(source, /clients\.matchAll\(\{ type: "window", includeUncontrolled: true \}\)/);
  assert.match(source, /clients\.length > 0/);
});
