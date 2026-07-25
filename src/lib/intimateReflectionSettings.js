import { normalizeIntimateReflectionSettings } from "./intimateReflection.js";

export const INTIMATE_REFLECTION_SETTINGS_KEY = "sarah.intimate-reflection-settings.v1";
export const INTIMATE_REFLECTION_SETTINGS_EVENT = "sarah:intimate-reflection-settings";
const REMOTE_KEY = "intimate_reflection_settings";

export const DEFAULT_INTIMATE_REFLECTION_SETTINGS = Object.freeze({
  level: "intimate",
  customInstructions: "",
  updatedAt: null,
});

function normalizeStoredSettings(value = {}) {
  return {
    ...normalizeIntimateReflectionSettings(value),
    updatedAt: value?.updatedAt || value?.updated_date || null,
  };
}

function settingsTimestamp(value = {}) {
  const timestamp = new Date(value.updatedAt || value.updated_date || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function readIntimateReflectionSettings(storage = globalThis?.localStorage) {
  if (!storage?.getItem) return { ...DEFAULT_INTIMATE_REFLECTION_SETTINGS };
  try {
    const parsed = JSON.parse(storage.getItem(INTIMATE_REFLECTION_SETTINGS_KEY) || "null");
    return normalizeStoredSettings(parsed || DEFAULT_INTIMATE_REFLECTION_SETTINGS);
  } catch {
    return { ...DEFAULT_INTIMATE_REFLECTION_SETTINGS };
  }
}

export function saveIntimateReflectionSettings(value = {}, storage = globalThis?.localStorage) {
  const saved = normalizeStoredSettings({
    ...value,
    updatedAt: value.updatedAt || new Date().toISOString(),
  });
  storage?.setItem?.(INTIMATE_REFLECTION_SETTINGS_KEY, JSON.stringify(saved));
  globalThis?.window?.dispatchEvent?.(new CustomEvent(INTIMATE_REFLECTION_SETTINGS_EVENT, { detail: saved }));
  return saved;
}

export async function loadSyncedIntimateReflectionSettings() {
  const local = readIntimateReflectionSettings();
  try {
    const { base44 } = await import("@/api/base44Client");
    const rows = await base44.entities.AppSetting.filter({ key: REMOTE_KEY }, "-updated_date", 1);
    const remote = rows?.[0]?.value;
    if (!remote) {
      const seeded = saveIntimateReflectionSettings({
        ...local,
        updatedAt: local.updatedAt || new Date().toISOString(),
      });
      await base44.entities.AppSetting.create({ key: REMOTE_KEY, value: seeded });
      return seeded;
    }
    if (settingsTimestamp(local) > settingsTimestamp(remote)) {
      await base44.entities.AppSetting.update(rows[0].id, { key: REMOTE_KEY, value: local });
      return local;
    }
    if (settingsTimestamp(remote) > settingsTimestamp(local)) {
      return saveIntimateReflectionSettings(remote);
    }
    return local;
  } catch {
    return local;
  }
}

export async function saveSyncedIntimateReflectionSettings(value = {}) {
  const saved = saveIntimateReflectionSettings({
    ...value,
    updatedAt: new Date().toISOString(),
  });
  try {
    const { base44 } = await import("@/api/base44Client");
    const rows = await base44.entities.AppSetting.filter({ key: REMOTE_KEY }, "-updated_date", 1);
    const payload = { key: REMOTE_KEY, value: saved };
    if (rows?.[0]?.id) await base44.entities.AppSetting.update(rows[0].id, payload);
    else await base44.entities.AppSetting.create(payload);
  } catch {
    // Local settings remain usable until the desktop backend is reachable.
  }
  return saved;
}
