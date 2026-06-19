export const SARAH_BRAND_EVENT = "sarah:brand-changed";
export const SARAH_IMAGE_STORAGE_KEY = "sarah.brand.image.v1";

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

export function getSarahImageOption(id = DEFAULT_SARAH_IMAGE_ID) {
  return SARAH_IMAGE_OPTIONS.find((option) => option.id === id) || SARAH_IMAGE_OPTIONS[0];
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
