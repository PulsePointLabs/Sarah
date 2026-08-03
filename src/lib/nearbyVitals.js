const HOUR_MS = 60 * 60 * 1000;

const DEFAULT_WINDOWS_HOURS = {
  bloodPressure: 24,
  bloodGlucose: 24,
  bodyComposition: 24,
  pulseOx: 24,
};

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampMs(value) {
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function bodyExplorationTimeRange(exploration = {}) {
  const date = String(exploration.date || exploration.created_date || "").slice(0, 10);
  const time = /^\d{1,2}:\d{2}/.test(String(exploration.start_time || ""))
    ? String(exploration.start_time).slice(0, 5)
    : "00:00";
  const localStart = date ? new Date(`${date}T${time}:00`).getTime() : Number.NaN;
  const fallbackStart = timestampMs(exploration.started_at || exploration.created_date);
  const startMs = Number.isFinite(localStart) ? localStart : fallbackStart;
  const durationMinutes = Math.max(0, finite(exploration.duration_minutes) || 0);
  return {
    startMs,
    endMs: startMs == null ? null : startMs + durationMinutes * 60 * 1000,
    durationMinutes,
  };
}

function normalizeReading(reading = {}, kind, range, contextLabel = "exploration") {
  const measuredAt = reading.measured_at || reading.timestamp || reading.date || reading.created_date;
  const measuredMs = timestampMs(measuredAt);
  if (measuredMs == null || range.startMs == null) return null;
  const deltaMinutes = (measuredMs - range.startMs) / 60000;
  const during = measuredMs >= range.startMs && measuredMs <= range.endMs;
  const distanceMinutes = during
    ? 0
    : Math.min(Math.abs(measuredMs - range.startMs), Math.abs(measuredMs - range.endMs)) / 60000;
  return {
    ...reading,
    kind,
    measured_at: new Date(measuredMs).toISOString(),
    delta_minutes: Math.round(deltaMinutes * 10) / 10,
    distance_minutes: Math.round(distanceMinutes * 10) / 10,
    relationship: during ? `during ${contextLabel}` : measuredMs < range.startMs ? `before ${contextLabel}` : `after ${contextLabel}`,
  };
}

function validReading(reading, kind) {
  if (kind === "bloodPressure") {
    return finite(reading.systolic_mm_hg ?? reading.systolic) != null
      && finite(reading.diastolic_mm_hg ?? reading.diastolic) != null;
  }
  if (kind === "bloodGlucose") return finite(reading.glucose_mg_dl ?? reading.glucose ?? reading.value) != null;
  if (kind === "bodyComposition") return finite(reading.weight_kg) != null;
  return finite(reading.spo2_percent ?? reading.spo2 ?? reading.oxygen_saturation) != null;
}

function selectKind(readings, kind, range, windowHours, contextLabel) {
  const windowMs = Math.max(1, Number(windowHours) || 24) * HOUR_MS;
  const selected = (Array.isArray(readings) ? readings : [])
    .filter((reading) => validReading(reading, kind))
    .map((reading) => normalizeReading(reading, kind, range, contextLabel))
    .filter(Boolean)
    .filter((reading) => reading.distance_minutes * 60000 <= windowMs)
    .sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));

  const seen = new Set();
  return selected.filter((reading) => {
    const key = reading.id || `${reading.measured_at}-${kind}-${JSON.stringify(reading)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function selectNearbyVitalReadings(exploration, readings = {}, windowsHours = {}, contextLabel = "exploration") {
  const range = bodyExplorationTimeRange(exploration);
  const windows = { ...DEFAULT_WINDOWS_HOURS, ...windowsHours };
  if (range.startMs == null) {
    return { range, bloodPressure: [], bloodGlucose: [], bodyComposition: [], pulseOx: [] };
  }
  return {
    range,
    bloodPressure: selectKind(readings.bloodPressure, "bloodPressure", range, windows.bloodPressure, contextLabel),
    bloodGlucose: selectKind(readings.bloodGlucose, "bloodGlucose", range, windows.bloodGlucose, contextLabel),
    bodyComposition: selectKind(readings.bodyComposition, "bodyComposition", range, windows.bodyComposition, contextLabel),
    pulseOx: selectKind(readings.pulseOx, "pulseOx", range, windows.pulseOx, contextLabel),
  };
}

function source(reading = {}) {
  return [reading.source_app, reading.source_device].filter(Boolean).join(" / ") || "source not recorded";
}

function relation(reading = {}) {
  const minutes = Math.abs(Number(reading.delta_minutes) || 0);
  if (/^during\s+/i.test(String(reading.relationship || ""))) return `${reading.relationship} at +${Math.round(minutes)} min`;
  const amount = minutes >= 60 ? `${(minutes / 60).toFixed(1)} h` : `${Math.round(minutes)} min`;
  return `${amount} ${reading.relationship}`;
}

export function buildNearbyVitalsEvidence(nearby = {}) {
  const bloodPressure = (nearby.bloodPressure || []).map((reading) => ({
    measured_at: reading.measured_at,
    relationship: relation(reading),
    systolic_mm_hg: finite(reading.systolic_mm_hg ?? reading.systolic),
    diastolic_mm_hg: finite(reading.diastolic_mm_hg ?? reading.diastolic),
    pulse_bpm: finite(reading.pulse_bpm ?? reading.pulse),
    source: source(reading),
  }));
  const bloodGlucose = (nearby.bloodGlucose || []).map((reading) => ({
    measured_at: reading.measured_at,
    relationship: relation(reading),
    glucose_mg_dl: finite(reading.glucose_mg_dl ?? reading.glucose ?? reading.value),
    meal_tag: reading.meal_tag || null,
    source: source(reading),
  }));
  const bodyComposition = (nearby.bodyComposition || []).map((reading) => ({
    measured_at: reading.measured_at,
    relationship: relation(reading),
    weight_kg: finite(reading.weight_kg),
    weight_lb: finite(reading.weight_kg) == null ? null : Math.round(finite(reading.weight_kg) * 2.2046226218 * 10) / 10,
    body_fat_percent: finite(reading.body_fat_percent),
    muscle_mass_kg: finite(reading.muscle_mass_kg),
    muscle_mass_lb: finite(reading.muscle_mass_kg) == null ? null : Math.round(finite(reading.muscle_mass_kg) * 2.2046226218 * 10) / 10,
    body_water_percent: finite(reading.body_water_percent),
    impedance_ohms: finite(reading.impedance_ohms),
    source: source(reading),
    interpretation_rule: "Use pounds (lb) as the primary display and narrative unit. Kilograms are retained only as source provenance. Weight is measured context. Smart-scale composition fields are trend estimates, not acute effects of the session or exploration.",
  }));
  const pulseOxRows = nearby.pulseOx || [];
  const spo2 = pulseOxRows.map((reading) => finite(reading.spo2_percent ?? reading.spo2 ?? reading.oxygen_saturation)).filter((value) => value != null);
  const pulse = pulseOxRows.map((reading) => finite(reading.pulse_bpm ?? reading.pulse)).filter((value) => value != null);
  const pulseOx = pulseOxRows.length ? {
    samples: pulseOxRows.length,
    first_measured_at: pulseOxRows[0].measured_at,
    last_measured_at: pulseOxRows[pulseOxRows.length - 1].measured_at,
    relationship: relation(pulseOxRows[Math.floor(pulseOxRows.length / 2)]),
    spo2_min_percent: spo2.length ? Math.min(...spo2) : null,
    spo2_average_percent: spo2.length ? Math.round((spo2.reduce((sum, value) => sum + value, 0) / spo2.length) * 10) / 10 : null,
    spo2_max_percent: spo2.length ? Math.max(...spo2) : null,
    pulse_average_bpm: pulse.length ? Math.round((pulse.reduce((sum, value) => sum + value, 0) / pulse.length) * 10) / 10 : null,
    source: source(pulseOxRows[0]),
  } : null;
  return { blood_pressure: bloodPressure, blood_glucose: bloodGlucose, body_composition: bodyComposition, pulse_oximetry: pulseOx };
}
