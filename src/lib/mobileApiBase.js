const API_BASE_STORAGE_KEY = "pulsepoint.apiBase";
const API_BASE_QUERY_KEYS = ["pulsepoint_api_base", "api_base"];

function isCapacitorShell() {
  return typeof window !== "undefined" && window.location.protocol === "capacitor:";
}

function cleanBase(value) {
  if (!value || typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
}

function readStoredApiBase() {
  if (typeof window === "undefined") return "";
  try {
    return cleanBase(window.localStorage.getItem(API_BASE_STORAGE_KEY) || "");
  } catch {
    return "";
  }
}

function readQueryApiBase() {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  for (const key of API_BASE_QUERY_KEYS) {
    const value = cleanBase(params.get(key) || "");
    if (value) {
      try {
        window.localStorage.setItem(API_BASE_STORAGE_KEY, value);
      } catch {
        // Ignore storage failures; the current URL still works for this launch.
      }
      return value;
    }
  }
  return "";
}

export function getSarahApiBase() {
  const configured = cleanBase(import.meta.env.VITE_API_BASE || "");
  if (configured) return configured;

  const queryBase = readQueryApiBase();
  if (queryBase) return queryBase;

  const storedBase = readStoredApiBase();
  if (storedBase) return storedBase;

  if (isCapacitorShell()) {
    return "http://10.0.2.2:8787/api";
  }

  return "/api";
}

export const API_BASE = getSarahApiBase();

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
