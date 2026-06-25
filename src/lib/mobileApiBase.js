const API_BASE_STORAGE_KEY = "pulsepoint.apiBase";
const API_BASE_QUERY_KEYS = ["pulsepoint_api_base", "api_base"];
const CAPACITOR_API_BASES = [
  "http://192.168.0.33:8787/api",
  "http://100.65.16.104:8787/api",
  "https://benm-desktop.tail980777.ts.net/api",
  "http://10.0.2.2:8787/api",
];

export function isSarahNativeShell() {
  if (typeof window === "undefined") return false;
  if (window.location.protocol === "capacitor:") return true;
  try {
    const capacitor = window.Capacitor;
    if (capacitor?.isNativePlatform?.()) return true;
    return ["android", "ios"].includes(capacitor?.getPlatform?.());
  } catch {
    return false;
  }
}

function cleanBase(value) {
  if (!value || typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
}

function splitBases(value) {
  if (!value || typeof value !== "string") return [];
  return value
    .split(",")
    .map(cleanBase)
    .filter(Boolean);
}

function uniqueBases(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function readStoredApiBase() {
  if (typeof window === "undefined") return "";
  try {
    return cleanBase(window.localStorage.getItem(API_BASE_STORAGE_KEY) || "");
  } catch {
    return "";
  }
}

function writeStoredApiBase(value) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(API_BASE_STORAGE_KEY, value);
  } catch {
    // Storage is just a convenience; the active in-memory base still works.
  }
}

function readQueryApiBase() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  for (const key of API_BASE_QUERY_KEYS) {
    const value = cleanBase(params.get(key) || "");
    if (value) {
      writeStoredApiBase(value);
      return value;
    }
  }
  return "";
}

function configuredBases() {
  return uniqueBases([
    cleanBase(import.meta.env.VITE_API_BASE || ""),
    ...splitBases(import.meta.env.VITE_MOBILE_API_BASES || ""),
  ]);
}

export function getSarahApiBaseCandidates() {
  const configured = configuredBases();
  const queryBase = readQueryApiBase();
  const storedBase = readStoredApiBase();

  if (!isSarahNativeShell()) {
    return uniqueBases([
      ...configured,
      queryBase,
      storedBase,
      "/api",
    ]);
  }

  return uniqueBases([
    queryBase,
    ...configured,
    ...CAPACITOR_API_BASES,
    storedBase,
  ]);
}

export function getSarahApiBase() {
  return getSarahApiBaseCandidates()[0] || "/api";
}

export let API_BASE = getSarahApiBase();

export function setSarahApiBase(value) {
  const clean = cleanBase(value);
  if (!clean) return API_BASE;
  API_BASE = clean;
  writeStoredApiBase(clean);
  return API_BASE;
}

function healthUrlForBase(base) {
  if (base === "/api") return "/api/health";
  return `${base.replace(/\/+$/, "")}/health`;
}

async function checkApiBase(base, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(healthUrlForBase(base), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, base, error: `HTTP ${response.status}` };
    }
    const data = await response.json().catch(() => ({}));
    if (data?.ok === false) {
      return { ok: false, base, error: "Health check returned not ok" };
    }
    return { ok: true, base, data };
  } catch (error) {
    return { ok: false, base, error: error?.message || String(error) };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function discoverSarahApiBase({ timeoutMs = 2500, onAttempt } = {}) {
  const candidates = getSarahApiBaseCandidates();
  const failures = [];

  for (const base of candidates) {
    onAttempt?.(base);
    const result = await checkApiBase(base, timeoutMs);
    if (result.ok) {
      setSarahApiBase(base);
      return result;
    }
    failures.push(result);
  }

  const error = new Error(`No reachable Sarah API found. Tried: ${candidates.join(", ")}`);
  error.failures = failures;
  throw error;
}

export function apiUrl(path = "") {
  if (!path) return API_BASE;
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${normalizedPath}`;
}

export function serverUrl(path = "") {
  if (!path) return "";
  if (/^(https?:|data:|blob:|capacitor:)/i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (normalizedPath.startsWith("/api/")) {
    return apiUrl(normalizedPath.slice(4));
  }

  if (normalizedPath.startsWith("/uploads/")) {
    const apiOrigin = API_BASE.replace(/\/api$/, "");
    return `${apiOrigin}${normalizedPath}`;
  }

  return normalizedPath;
}
