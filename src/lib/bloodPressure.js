import { registerPlugin } from "@capacitor/core";
import { apiUrl, isSarahNativeShell } from "@/lib/mobileApiBase";

const NativeBloodPressure = registerPlugin("BloodPressureHealth");

export function formatBloodPressure(reading) {
  if (!reading) return "No BP reading";
  const pulse = reading.pulse_bpm ? ` · ${Math.round(Number(reading.pulse_bpm))} bpm` : "";
  return `${reading.systolic_mm_hg}/${reading.diastolic_mm_hg} mmHg${pulse}`;
}

export function formatBloodPressureTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export async function getBloodPressureStatus() {
  if (!isSarahNativeShell()) {
    return {
      native: false,
      available: false,
      permissionGranted: false,
      message: "Health Connect BP sync is available inside the Android APK.",
    };
  }
  return NativeBloodPressure.getStatus();
}

export async function requestBloodPressurePermission() {
  if (!isSarahNativeShell()) throw new Error("Health Connect permissions can only be requested inside the Android APK.");
  return NativeBloodPressure.requestPermission();
}

export async function openHealthConnectSettings() {
  if (!isSarahNativeShell()) throw new Error("Health Connect settings can only be opened inside the Android APK.");
  return NativeBloodPressure.openHealthConnectSettings();
}

export async function readNativeBloodPressure({ days = 30, limit = 100 } = {}) {
  if (!isSarahNativeShell()) return { readings: [], native: false };
  return NativeBloodPressure.readRecent({ days, limit });
}

export async function ingestBloodPressureReadings(readings = []) {
  const response = await fetch(apiUrl("/blood-pressure/ingest"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ readings }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `BP ingest failed: HTTP ${response.status}`);
  return data;
}

export async function syncBloodPressureFromHealthConnect({ days = 30, limit = 100 } = {}) {
  const native = await readNativeBloodPressure({ days, limit });
  const readings = Array.isArray(native?.readings) ? native.readings : [];
  if (!readings.length) return { ok: true, native, inserted: 0, readings: [] };
  const saved = await ingestBloodPressureReadings(readings);
  return { ...saved, native };
}

export async function listRecentBloodPressure(limit = 20) {
  const response = await fetch(apiUrl(`/blood-pressure/recent?limit=${encodeURIComponent(limit)}`), { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Could not load BP readings: HTTP ${response.status}`);
  return data;
}

export async function findBloodPressureNearSession(sessionId, { beforeHours = 8, afterHours = 4 } = {}) {
  const query = new URLSearchParams({
    beforeHours: String(beforeHours),
    afterHours: String(afterHours),
  });
  const response = await fetch(apiUrl(`/blood-pressure/near-session/${encodeURIComponent(sessionId)}?${query}`), { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Could not load session BP context: HTTP ${response.status}`);
  return data;
}

export async function attachBloodPressureToSession(sessionId, readingIds = []) {
  const response = await fetch(apiUrl(`/blood-pressure/attach-session/${encodeURIComponent(sessionId)}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ readingIds }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Could not attach BP readings: HTTP ${response.status}`);
  return data;
}
