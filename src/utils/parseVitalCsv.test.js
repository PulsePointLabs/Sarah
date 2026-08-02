import test from "node:test";
import assert from "node:assert/strict";
import { classifyVitalCsv, parseBloodGlucoseCsv, parseBodyCompositionCsv } from "./parseVitalCsv.js";

test("classifies named oxygen-saturation exports", () => {
  assert.equal(classifyVitalCsv("Time,SpO2,PR\n2026-08-01 08:00,98,72").type, "pulse_ox");
});

test("classifies and converts blood glucose CSV values", () => {
  const text = "Timestamp,Glucose,Unit\n2026-08-01 08:00,6.1,mmol/L";
  assert.equal(classifyVitalCsv(text).type, "blood_glucose");
  const parsed = parseBloodGlucoseCsv(text);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].glucose_mg_dl, 109.9);
});

test("classifies body composition and converts pounds", () => {
  const text = "Date,Time,Weight (lb),Body Fat %,BMI\n2026-08-01,07:30,180,18.2,24.4";
  assert.equal(classifyVitalCsv(text).type, "body_composition");
  const parsed = parseBodyCompositionCsv(text);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].weight_kg, 81.65);
  assert.equal(parsed.rows[0].body_fat_percent, 18.2);
});
