import { base44 } from "@/api/base44Client";

const STORAGE_KEY = "sarah.live-cue-customization.v1";
const REMOTE_KEY = "live_cue_customization";

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

function customizationTimestamp(value = {}) {
  const timestamp = new Date(value.updatedAt || value.updated_date || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export async function loadSyncedLiveCueCustomization() {
  const local = readLiveCueCustomization();
  try {
    const rows = await base44.entities.AppSetting.filter({ key: REMOTE_KEY }, "-updated_date", 1);
    const remote = rows?.[0]?.value;
    if (!remote) {
      if (local.updatedAt || local.instructions || Object.keys(local.phrases || {}).length) {
        await base44.entities.AppSetting.create({ key: REMOTE_KEY, value: local });
      }
      return local;
    }
    if (customizationTimestamp(local) > customizationTimestamp(remote)) {
      await base44.entities.AppSetting.update(rows[0].id, { key: REMOTE_KEY, value: local });
      return local;
    }
    if (customizationTimestamp(local) === customizationTimestamp(remote)) return local;
    return saveLiveCueCustomization(remote);
  } catch {
    return local;
  }
}

export async function saveSyncedLiveCueCustomization(value = {}) {
  const saved = saveLiveCueCustomization(value);
  try {
    const rows = await base44.entities.AppSetting.filter({ key: REMOTE_KEY }, "-updated_date", 1);
    const payload = { key: REMOTE_KEY, value: saved };
    if (rows?.[0]?.id) await base44.entities.AppSetting.update(rows[0].id, payload);
    else await base44.entities.AppSetting.create(payload);
  } catch {
    // Local settings remain authoritative while the desktop server is unavailable.
  }
  return saved;
}
