import test from "node:test";
import assert from "node:assert/strict";
import { classifyVitalsCsvBytes } from "../../src/lib/vitalsCsvClassifier.js";

function bytes(value) {
  return new TextEncoder().encode(value);
}

test("classifies a shared OneTouch glucose CSV", () => {
  const result = classifyVitalsCsvBytes(bytes([
    "Reading Date,Reading Time,Glucose Value,Units",
    "07/29/2026,8:15 PM,112,mg/dL",
  ].join("\n")), "OneTouch.csv");

  assert.equal(result.kind, "blood_glucose");
  assert.equal(result.parsed.rows[0].glucose_mg_dl, 112);
});

test("classifies a shared EMAY pulse-ox CSV", () => {
  const result = classifyVitalsCsvBytes(bytes([
    "Time,SpO2,Pulse Rate,PI",
    "07/29/2026 8:15 PM,97,88,4.2",
  ].join("\n")), "EMAY-export.csv");

  assert.equal(result.kind, "pulse_ox");
  assert.equal(result.parsed.rows[0].spo2_percent, 97);
  assert.equal(result.parsed.rows[0].pulse_bpm, 88);
});

test("rejects an unrelated shared CSV with a useful combined error", () => {
  assert.throws(
    () => classifyVitalsCsvBytes(bytes("Name,Value\nCletus,42"), "other.csv"),
    /could not identify/i,
  );
});
