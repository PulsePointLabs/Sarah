import {
  bloodGlucoseReadingsFromSession,
  bloodPressureReadingsFromSession,
  pulseOxReadingsFromSession,
} from "./sessionContext.js";
import { getRecordStart } from "../utils/localRecordTime.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function measuredMs(reading = {}) {
  const value = new Date(reading.measured_at || reading.timestamp || reading.date || 0).getTime();
  return Number.isFinite(value) ? value : null;
}

function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function nearestReadingBefore(readings = [], startMs, maxAgeMs) {
  if (!Number.isFinite(startMs)) return null;
  return readings
    .map((reading) => ({ reading, measuredMs: measuredMs(reading) }))
    .filter(({ measuredMs: at }) => at != null && at <= startMs && startMs - at <= maxAgeMs)
    .sort((a, b) => b.measuredMs - a.measuredMs)[0]?.reading || null;
}

function firstOpeningReading(readings = [], startMs, maxAfterMs = 10 * 60 * 1000) {
  return readings
    .map((reading) => {
      const offset = number(reading.time_offset_s);
      const at = measuredMs(reading);
      return {
        reading,
        offsetMs: offset != null
          ? offset * 1000
          : at != null && Number.isFinite(startMs) ? at - startMs : null,
      };
    })
    .filter(({ offsetMs }) => offsetMs != null && offsetMs >= 0 && offsetMs <= maxAfterMs)
    .sort((a, b) => a.offsetMs - b.offsetMs)[0]?.reading || null;
}

function summarizeOpeningTelemetry(timelineRows = []) {
  const opening = timelineRows.filter((row) => {
    const time = number(row?.time_offset_s);
    return time != null && time >= 0 && time <= 60;
  });
  const hrValues = opening
    .map((row) => number(row?.hr ?? row?.heart_rate))
    .filter((value) => value != null && value >= 30 && value <= 240);
  const baselineValues = opening
    .map((row) => number(row?.baseline_hr))
    .filter((value) => value != null && value >= 30 && value <= 240);
  const rmssdValues = opening
    .filter((row) => !row?.hrv_quality || /moderate|high/i.test(String(row.hrv_quality)))
    .map((row) => number(row?.hrv_rmssd_ms))
    .filter((value) => value != null && value > 0);
  const sdnnValues = opening
    .filter((row) => !row?.hrv_quality || /moderate|high/i.test(String(row.hrv_quality)))
    .map((row) => number(row?.hrv_sdnn_ms))
    .filter((value) => value != null && value > 0);
  return {
    openingHrBpm: hrValues.length
      ? Math.round(hrValues.reduce((sum, value) => sum + value, 0) / hrValues.length)
      : null,
    baselineHrBpm: baselineValues.length
      ? Math.round(baselineValues.reduce((sum, value) => sum + value, 0) / baselineValues.length)
      : null,
    openingRmssdMs: rmssdValues.length ? Number(median(rmssdValues).toFixed(1)) : null,
    openingSdnnMs: sdnnValues.length ? Number(median(sdnnValues).toFixed(1)) : null,
    sampleCount: opening.length,
  };
}

export function buildPreSessionBaseline({
  record = {},
  timelineRows = [],
  bodyCompositionReadings = [],
  bloodGlucoseReadings = [],
  bloodPressureReadings = [],
} = {}) {
  const start = getRecordStart(record);
  const startMs = start?.startMs;
  const attachedComposition = record.body_composition || null;
  const composition = attachedComposition
    || nearestReadingBefore(bodyCompositionReadings, startMs, 45 * DAY_MS);

  const attachedGlucose = bloodGlucoseReadingsFromSession(record);
  const glucoseBefore = nearestReadingBefore(
    [...bloodGlucoseReadings, ...attachedGlucose],
    startMs,
    24 * HOUR_MS,
  );
  const glucose = glucoseBefore || firstOpeningReading(attachedGlucose, startMs);

  const attachedBp = bloodPressureReadingsFromSession(record);
  const bpBefore = nearestReadingBefore(
    [...bloodPressureReadings, ...attachedBp],
    startMs,
    8 * HOUR_MS,
  );
  const bloodPressure = bpBefore || firstOpeningReading(attachedBp, startMs);

  const pulseOx = firstOpeningReading(pulseOxReadingsFromSession(record), startMs, 5 * 60 * 1000);
  const telemetry = summarizeOpeningTelemetry(timelineRows);
  const relationFor = (reading, beforeReading, fallback = "session opening") => {
    if (!reading) return "";
    return reading === beforeReading ? "pre-session" : fallback;
  };

  return {
    start: start?.start || null,
    composition,
    compositionRelation: composition
      ? (measuredMs(composition) != null && Number.isFinite(startMs) && measuredMs(composition) <= startMs
        ? "pre-session"
        : "attached context")
      : "",
    glucose,
    glucoseRelation: relationFor(glucose, glucoseBefore),
    bloodPressure,
    bloodPressureRelation: relationFor(bloodPressure, bpBefore),
    pulseOx,
    pulseOxRelation: pulseOx ? "opening five-minute window" : "",
    telemetry,
    sourceCount: [
      composition,
      glucose,
      bloodPressure,
      pulseOx,
      telemetry.openingHrBpm != null || telemetry.openingRmssdMs != null,
    ].filter(Boolean).length,
  };
}
