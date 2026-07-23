const STORAGE_KEY = "sarah.live-cue-customization.v1";

export const DEFAULT_LIVE_CUE_CUSTOMIZATION = Object.freeze({
  enabled: false,
  instructions: "",
  phrases: {},
  updatedAt: null,
});

export function readLiveCueCustomization() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      ...DEFAULT_LIVE_CUE_CUSTOMIZATION,
      ...parsed,
      enabled: Boolean(parsed.enabled),
      instructions: String(parsed.instructions || ""),
      phrases: parsed.phrases && typeof parsed.phrases === "object" ? parsed.phrases : {},
    };
  } catch {
    return { ...DEFAULT_LIVE_CUE_CUSTOMIZATION };
  }
}

export function saveLiveCueCustomization(value = {}) {
  const next = {
    ...DEFAULT_LIVE_CUE_CUSTOMIZATION,
    ...value,
    enabled: Boolean(value.enabled),
    instructions: String(value.instructions || "").slice(0, 4000),
    phrases: value.phrases && typeof value.phrases === "object" ? value.phrases : {},
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}
