import { serverUrl } from "@/lib/mobileApiBase";

export const SARAH_BRAND_EVENT = "sarah:brand-changed";
export const SARAH_IMAGE_STORAGE_KEY = "sarah.brand.image.v1";
export const SARAH_CUSTOM_IMAGES_STORAGE_KEY = "sarah.brand.customImages.v1";
export const SARAH_IMAGE_CACHE_STORAGE_KEY = "sarah.brand.imageCache.v1";

export const SARAH_IMAGE_OPTIONS = [
  {
    id: "lab",
    label: "Lab Sarah",
    helper: "Closer, warmer, and best for the splash screen.",
    src: "/brand/sarah-lab.jpg",
    position: "50% 42%",
  },
  {
    id: "clinical",
    label: "Clinical Sarah",
    helper: "Cleaner portrait, good for compact AI surfaces.",
    src: "/brand/sarah-clinical.jpg",
    position: "50% 38%",
  },
];

export const DEFAULT_SARAH_IMAGE_ID = "lab";

function normalizeCustomOption(option = {}) {
  const id = String(option.id || "").trim();
  const src = String(option.src || "").trim();
  if (!id || !src) return null;
  return {
    id,
    label: String(option.label || "Custom Sarah").trim() || "Custom Sarah",
    helper: String(option.helper || "Custom local portrait.").trim() || "Custom local portrait.",
    src,
    position: String(option.position || "50% 42%").trim() || "50% 42%",
    custom: true,
    createdAt: option.createdAt || new Date().toISOString(),
    source: option.source || "custom",
  };
}

export function readCustomSarahImageOptions() {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SARAH_CUSTOM_IMAGES_STORAGE_KEY) || "[]");
    return (Array.isArray(parsed) ? parsed : []).map(normalizeCustomOption).filter(Boolean);
  } catch {
    return [];
  }
}

export function getSarahImageOptions() {
  return [...SARAH_IMAGE_OPTIONS, ...readCustomSarahImageOptions()];
}

export function getSarahImageOption(id = DEFAULT_SARAH_IMAGE_ID) {
  return getSarahImageOptions().find((option) => option.id === id) || SARAH_IMAGE_OPTIONS[0];
}

export function readSarahImageCache() {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SARAH_IMAGE_CACHE_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function getCachedSarahImageSrc(id = "") {
  const imageId = String(id || "").trim();
  if (!imageId) return "";
  const cached = readSarahImageCache()[imageId];
  const src = typeof cached === "string" ? cached : cached?.src;
  return typeof src === "string" && src.startsWith("data:image/") ? src : "";
}

export function cacheSarahImageDataUrl(id = "", dataUrl = "") {
  if (typeof window === "undefined") return false;
  const imageId = String(id || "").trim();
  const src = String(dataUrl || "").trim();
  if (!imageId || !src.startsWith("data:image/")) return false;
  try {
    const current = readSarahImageCache();
    const next = {
      [imageId]: { src, updatedAt: new Date().toISOString() },
      ...current,
    };
    const trimmed = Object.fromEntries(Object.entries(next).slice(0, 8));
    window.localStorage.setItem(SARAH_IMAGE_CACHE_STORAGE_KEY, JSON.stringify(trimmed));
    window.dispatchEvent(new CustomEvent(SARAH_BRAND_EVENT, { detail: readSarahBrandSettings() }));
    return true;
  } catch {
    return false;
  }
}

export function removeCachedSarahImage(id = "") {
  if (typeof window === "undefined") return;
  const imageId = String(id || "").trim();
  if (!imageId) return;
  const current = readSarahImageCache();
  delete current[imageId];
  window.localStorage.setItem(SARAH_IMAGE_CACHE_STORAGE_KEY, JSON.stringify(current));
}

export function resolveSarahImageSrc(src = "", imageId = "") {
  const cached = getCachedSarahImageSrc(imageId);
  if (cached) return cached;
  const value = String(src || "").trim();
  if (!value) return SARAH_IMAGE_OPTIONS[0].src;
  if (value.startsWith("/uploads/") || value.startsWith("uploads/")) return serverUrl(value);
  return value;
}

export function readSarahBrandSettings() {
  if (typeof window === "undefined") return { imageId: DEFAULT_SARAH_IMAGE_ID };
  const imageId = window.localStorage.getItem(SARAH_IMAGE_STORAGE_KEY) || DEFAULT_SARAH_IMAGE_ID;
  return { imageId: getSarahImageOption(imageId).id };
}

export function saveSarahBrandSettings(next = {}) {
  const current = readSarahBrandSettings();
  const saved = {
    imageId: getSarahImageOption(next.imageId || current.imageId).id,
  };
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SARAH_IMAGE_STORAGE_KEY, saved.imageId);
    window.dispatchEvent(new CustomEvent(SARAH_BRAND_EVENT, { detail: saved }));
  }
  return saved;
}

export function addSarahImageOption(option = {}) {
  if (typeof window === "undefined") return null;
  const normalized = normalizeCustomOption(option);
  if (!normalized) return null;
  const existing = readCustomSarahImageOptions().filter((item) => item.id !== normalized.id);
  const next = [normalized, ...existing].slice(0, 24);
  window.localStorage.setItem(SARAH_CUSTOM_IMAGES_STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent(SARAH_BRAND_EVENT, { detail: readSarahBrandSettings() }));
  return normalized;
}

export function removeSarahImageOption(id) {
  if (typeof window === "undefined") return readSarahBrandSettings();
  const imageId = String(id || "");
  const next = readCustomSarahImageOptions().filter((item) => item.id !== imageId);
  window.localStorage.setItem(SARAH_CUSTOM_IMAGES_STORAGE_KEY, JSON.stringify(next));
  removeCachedSarahImage(imageId);
  const current = readSarahBrandSettings();
  if (current.imageId === imageId) return saveSarahBrandSettings({ imageId: DEFAULT_SARAH_IMAGE_ID });
  window.dispatchEvent(new CustomEvent(SARAH_BRAND_EVENT, { detail: current }));
  return current;
}
