import assert from "node:assert/strict";
import test from "node:test";
import { buildNearbyVitalsEvidence, selectNearbyVitalReadings } from "./nearbyVitals.js";

test("matches imported vitals to a body exploration with transparent time relationships", () => {
  const exploration = { date: "2026-08-01", start_time: "04:50", duration_minutes: 50 };
  const nearby = selectNearbyVitalReadings(exploration, {
    bloodPressure: [{ id: "bp-1", measured_at: "2026-08-01T05:00:00", systolic_mm_hg: 136, diastolic_mm_hg: 96, pulse_bpm: 94 }],
    bloodGlucose: [{ id: "bg-1", measured_at: "2026-07-31T22:46:00", glucose_mg_dl: 108 }],
    bodyComposition: [{ id: "scale-1", measured_at: "2026-08-01T04:29:00", weight_kg: 81.48, body_fat_percent: 18.2 }],
    pulseOx: [{ id: "o2-1", measured_at: "2026-08-01T04:55:00", spo2_percent: 98, pulse_bpm: 91 }],
  });

  assert.equal(nearby.bloodPressure[0].relationship, "during exploration");
  assert.equal(nearby.bodyComposition[0].relationship, "before exploration");
  assert.equal(nearby.bodyComposition[0].delta_minutes, -21);
  assert.equal(nearby.pulseOx[0].delta_minutes, 5);

  const evidence = buildNearbyVitalsEvidence(nearby);
  assert.equal(evidence.blood_pressure[0].systolic_mm_hg, 136);
  assert.equal(evidence.blood_glucose[0].glucose_mg_dl, 108);
  assert.equal(evidence.body_composition[0].weight_lb, 179.6);
  assert.equal(evidence.pulse_oximetry.spo2_average_percent, 98);
});

test("excludes readings outside the explicit nearby window", () => {
  const nearby = selectNearbyVitalReadings(
    { date: "2026-08-01", start_time: "04:50", duration_minutes: 50 },
    { bloodGlucose: [{ measured_at: "2026-07-29T00:00:00", glucose_mg_dl: 99 }] },
  );
  assert.deepEqual(nearby.bloodGlucose, []);
});

test("labels nearby imports as session context when requested", () => {
  const selected = selectNearbyVitalReadings(
    { date: "2026-08-01", start_time: "05:00", duration_minutes: 30 },
    { bloodGlucose: [{ measured_at: "2026-08-01T05:10:00", glucose_mg_dl: 90 }] },
    {},
    "session",
  );
  assert.equal(selected.bloodGlucose[0].relationship, "during session");
  assert.match(buildNearbyVitalsEvidence(selected).blood_glucose[0].relationship, /during session/);
});
