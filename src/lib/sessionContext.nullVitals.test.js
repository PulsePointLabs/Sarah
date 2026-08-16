import assert from "node:assert/strict";
import test from "node:test";
import {
  bloodPressureReadingsFromSession,
  pulseOxReadingsFromSession,
  sessionContextEvidenceText,
} from "./sessionContext.js";

test("null optional vital-sign entries do not break profile context generation", () => {
  const session = {
    session_context: {
      blood_pressure: null,
      blood_pressure_readings: [null],
      pulse_ox: null,
      pulse_ox_readings: [null],
    },
    latest_blood_pressure_reading: null,
    blood_pressure_readings: null,
    latest_pulse_ox_reading: null,
    pulse_ox_readings: null,
    event_timeline: [{ blood_pressure: null, pulse_ox: null }],
  };

  assert.deepEqual(bloodPressureReadingsFromSession(session), []);
  assert.deepEqual(pulseOxReadingsFromSession(session), []);
  assert.equal(sessionContextEvidenceText(session), "");
});

test("valid readings survive alongside null placeholders", () => {
  const session = {
    session_context: {
      blood_pressure: { systolic_mm_hg: 129, diastolic_mm_hg: 89, pulse_bpm: 102 },
    },
    latest_blood_pressure_reading: { systolic_mm_hg: 129, diastolic_mm_hg: 89, pulse_bpm: 102 },
    blood_pressure_readings: [null],
    latest_pulse_ox_reading: { spo2_percent: 97, pulse_bpm: 94 },
    pulse_ox_readings: [null],
  };

  assert.equal(bloodPressureReadingsFromSession(session).length, 1);
  assert.equal(pulseOxReadingsFromSession(session).length, 1);
  assert.match(sessionContextEvidenceText(session), /129\/89/);
  assert.match(sessionContextEvidenceText(session), /SpO2 97%/);
});
