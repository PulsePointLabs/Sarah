import assert from "node:assert/strict";
import test from "node:test";
import { buildPreSessionBaseline, nearestReadingBefore } from "./preSessionBaseline.js";

test("selects the nearest measurement before session start within its allowed age", () => {
  const start = new Date(2026, 6, 29, 20, 0, 0).getTime();
  const selected = nearestReadingBefore([
    { id: "old", measured_at: new Date(start - 3_600_000).toISOString() },
    { id: "nearest", measured_at: new Date(start - 600_000).toISOString() },
    { id: "after", measured_at: new Date(start + 60_000).toISOString() },
  ], start, 2 * 3_600_000);
  assert.equal(selected.id, "nearest");
});

test("builds a provenance-aware pre-session and opening baseline", () => {
  const baseline = buildPreSessionBaseline({
    record: {
      date: "2026-07-29",
      start_time: "20:00",
      duration_minutes: 30,
      pulse_ox_readings: [
        { time_offset_s: 20, spo2_percent: 96, pulse_bpm: 91, measured_at: "2026-07-29T20:00:20-04:00" },
      ],
    },
    timelineRows: [
      { time_offset_s: 5, hr: 88, baseline_hr: 82, hrv_rmssd_ms: 24, hrv_sdnn_ms: 33, hrv_quality: "high" },
      { time_offset_s: 35, hr: 92, baseline_hr: 82, hrv_rmssd_ms: 20, hrv_sdnn_ms: 31, hrv_quality: "moderate" },
    ],
    bodyCompositionReadings: [
      { measured_at: "2026-07-29T19:30:00-04:00", weight_kg: 83 },
    ],
    bloodGlucoseReadings: [
      { measured_at: "2026-07-29T19:45:00-04:00", glucose_mg_dl: 108 },
    ],
    bloodPressureReadings: [
      { measured_at: "2026-07-29T19:50:00-04:00", systolic_mm_hg: 126, diastolic_mm_hg: 78 },
    ],
  });

  assert.equal(baseline.sourceCount, 5);
  assert.equal(baseline.compositionRelation, "pre-session");
  assert.equal(baseline.glucoseRelation, "pre-session");
  assert.equal(baseline.bloodPressureRelation, "pre-session");
  assert.equal(baseline.pulseOxRelation, "opening five-minute window");
  assert.equal(baseline.telemetry.openingHrBpm, 90);
  assert.equal(baseline.telemetry.openingRmssdMs, 22);
});
