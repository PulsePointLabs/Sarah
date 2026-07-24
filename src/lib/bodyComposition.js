import { registerPlugin } from "@capacitor/core";
import { base44 } from "@/api/base44Client";
import { isSarahNativeShell } from "@/lib/mobileApiBase";

const NativeBodyComposition = registerPlugin("BodyCompositionHealth");

const NUMERIC_FIELDS = [
  "weight_kg",
  "body_fat_percent",
  "lean_body_mass_kg",
  "fat_free_body_weight_kg",
  "body_water_mass_kg",
  "body_water_percent",
  "bone_mass_kg",
  "basal_metabolic_rate_kcal_day",
  "bmi",
  "subcutaneous_fat_percent",
  "visceral_fat",
  "skeletal_muscle_percent",
  "muscle_mass_kg",
  "protein_percent",
  "metabolic_age",
];

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeBodyCompositionReading(input = {}) {
  const measuredAt = new Date(input.measured_at || input.timestamp || Date.now());
  const reading = {
    ...input,
    measured_at: Number.isFinite(measuredAt.getTime()) ? measuredAt.toISOString() : new Date().toISOString(),
    source_app: String(input.source_app || "Manual").trim(),
    source_package: String(input.source_package || "").trim(),
    source_device: String(input.source_device || "").trim(),
  };
  NUMERIC_FIELDS.forEach((field) => {
    reading[field] = finiteOrNull(input[field]);
  });
  return reading;
}

export function bodyCompositionId(reading = {}) {
  const normalized = normalizeBodyCompositionReading(reading);
  const timestamp = normalized.measured_at.replace(/[^0-9TZ]/g, "");
  const source = (normalized.source_package || normalized.source_app || "manual")
    .replace(/[^a-z0-9]+/gi, "-")
    .slice(0, 50);
  return `body-composition-${timestamp}-${source}`;
}

export function formatWeightKg(value) {
  const kg = finiteOrNull(value);
  if (kg == null) return "--";
  return `${kg.toFixed(1)} kg / ${(kg * 2.2046226218).toFixed(1)} lb`;
}

export function formatCompositionTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export async function getBodyCompositionStatus() {
  if (!isSarahNativeShell()) {
    return {
      native: false,
      available: false,
      permissionGranted: false,
      message: "Health Connect body-composition sync is available inside Sarah's Android APK.",
    };
  }
  return NativeBodyComposition.getStatus();
}

export async function requestBodyCompositionPermission() {
  if (!isSarahNativeShell()) throw new Error("Open Sarah's Android APK to connect Health Connect.");
  return NativeBodyComposition.requestPermission();
}

export async function openBodyCompositionHealthConnectSettings() {
  if (!isSarahNativeShell()) throw new Error("Open Sarah's Android APK to open Health Connect.");
  return NativeBodyComposition.openHealthConnectSettings();
}

export async function syncBodyCompositionFromHealthConnect({ days = 30, limit = 100 } = {}) {
  if (!isSarahNativeShell()) throw new Error("Open Sarah's Android APK to sync Health Connect.");
  const native = await NativeBodyComposition.readRecent({ days, limit });
  const readings = (Array.isArray(native?.readings) ? native.readings : [])
    .map(normalizeBodyCompositionReading)
    .filter((reading) => reading.weight_kg != null || reading.body_fat_percent != null);
  const saved = [];
  for (const reading of readings) {
    saved.push(await base44.entities.BodyCompositionReading.create({
      ...reading,
      id: bodyCompositionId(reading),
      import_source: "health_connect",
      imported_at: new Date().toISOString(),
    }));
  }
  return { native, readings: saved, inserted: saved.length };
}

export async function saveManualBodyComposition(input = {}) {
  const reading = normalizeBodyCompositionReading({
    ...input,
    source_app: input.source_app || "Manual",
    import_source: "manual",
  });
  if (reading.weight_kg == null) throw new Error("Enter a weight before saving the weigh-in.");
  return base44.entities.BodyCompositionReading.create({
    ...reading,
    id: input.id || bodyCompositionId(reading),
  });
}

export async function listBodyCompositionReadings(limit = 100) {
  return base44.entities.BodyCompositionReading.list("-measured_at", limit);
}

export function compositionSnapshot(reading) {
  if (!reading) return null;
  return normalizeBodyCompositionReading({
    ...reading,
    reading_id: reading.id || reading.reading_id || null,
  });
}
