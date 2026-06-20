export const WATERMARK_SETTINGS_KEY = "sarah-watermark-settings-v1";

export const WATERMARK_PRESETS = [
  {
    value: "public_export",
    label: "Public Export",
    helper: "Bakes Clinical Climax / Powered by Sarah into exported videos and scrubs metadata.",
  },
  {
    value: "private_archive",
    label: "Private Archive",
    helper: "Keeps exports private and unbranded unless you manually enable the watermark.",
  },
  {
    value: "preview",
    label: "Preview",
    helper: "Shows the watermark clearly for checking placement before a real public render.",
  },
];

export const DEFAULT_WATERMARK_SETTINGS = {
  preset: "public_export",
  enabled: true,
  primaryText: "Clinical Climax",
  secondaryText: "Powered by Sarah",
  handleText: "",
  opacity: 0.62,
  textSize: 34,
  logoSize: 76,
  paddingPercent: 4,
  positionMode: "rotating_corners",
  movementIntervalSeconds: 24,
  movementTransitionSeconds: 0.7,
  shadowEnabled: true,
  backgroundPlateEnabled: false,
  subtleCenterEnabled: false,
  metadataScrubEnabled: true,
};

export function normalizeWatermarkSettings(input = {}) {
  const preset = ["public_export", "private_archive", "preview"].includes(input?.preset)
    ? input.preset
    : DEFAULT_WATERMARK_SETTINGS.preset;
  const presetDefaults = preset === "private_archive"
    ? { enabled: false, metadataScrubEnabled: false }
    : preset === "preview"
      ? { enabled: true, metadataScrubEnabled: true, opacity: 0.7 }
      : { enabled: true, metadataScrubEnabled: true };
  const number = (value, min, max, fallback) => {
    const next = Number(value);
    return Number.isFinite(next) ? Math.max(min, Math.min(max, next)) : fallback;
  };
  return {
    ...DEFAULT_WATERMARK_SETTINGS,
    ...presetDefaults,
    ...input,
    preset,
    enabled: Boolean(input?.enabled ?? presetDefaults.enabled),
    primaryText: String(input?.primaryText || DEFAULT_WATERMARK_SETTINGS.primaryText).slice(0, 80),
    secondaryText: String(input?.secondaryText ?? DEFAULT_WATERMARK_SETTINGS.secondaryText).slice(0, 80),
    handleText: String(input?.handleText || "").slice(0, 80),
    opacity: number(input?.opacity, 0.05, 1, presetDefaults.opacity || DEFAULT_WATERMARK_SETTINGS.opacity),
    textSize: Math.round(number(input?.textSize, 18, 96, DEFAULT_WATERMARK_SETTINGS.textSize)),
    logoSize: Math.round(number(input?.logoSize, 32, 220, DEFAULT_WATERMARK_SETTINGS.logoSize)),
    paddingPercent: number(input?.paddingPercent, 1, 12, DEFAULT_WATERMARK_SETTINGS.paddingPercent),
    movementIntervalSeconds: number(input?.movementIntervalSeconds, 8, 120, DEFAULT_WATERMARK_SETTINGS.movementIntervalSeconds),
    movementTransitionSeconds: number(input?.movementTransitionSeconds, 0, 3, DEFAULT_WATERMARK_SETTINGS.movementTransitionSeconds),
    shadowEnabled: Boolean(input?.shadowEnabled ?? DEFAULT_WATERMARK_SETTINGS.shadowEnabled),
    backgroundPlateEnabled: Boolean(input?.backgroundPlateEnabled ?? DEFAULT_WATERMARK_SETTINGS.backgroundPlateEnabled),
    subtleCenterEnabled: Boolean(input?.subtleCenterEnabled ?? DEFAULT_WATERMARK_SETTINGS.subtleCenterEnabled),
    metadataScrubEnabled: Boolean(input?.metadataScrubEnabled ?? presetDefaults.metadataScrubEnabled),
  };
}

export function readWatermarkSettings(storage = globalThis?.localStorage) {
  if (!storage) return DEFAULT_WATERMARK_SETTINGS;
  try {
    return normalizeWatermarkSettings(JSON.parse(storage.getItem(WATERMARK_SETTINGS_KEY) || "null") || DEFAULT_WATERMARK_SETTINGS);
  } catch {
    return DEFAULT_WATERMARK_SETTINGS;
  }
}

export function saveWatermarkSettings(settings, storage = globalThis?.localStorage) {
  const normalized = normalizeWatermarkSettings(settings);
  if (storage) storage.setItem(WATERMARK_SETTINGS_KEY, JSON.stringify(normalized));
  globalThis?.window?.dispatchEvent?.(new CustomEvent("sarah:watermark-settings", { detail: normalized }));
  return normalized;
}
