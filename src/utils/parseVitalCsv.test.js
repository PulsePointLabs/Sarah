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

test("finds a OneTouch glucose header after report metadata", () => {
  const text = [
    "OneTouch Reveal Data Report",
    "Patient Name,Ben",
    "Report Generated,08/01/2026",
    "Meter,Serial Number,Device Timestamp,Record Type,Glucose Value,Glucose Units",
    'OneTouch Verio,ABC123,"08/01/2026 06:46 PM",BG,108,mg/dL',
  ].join("\n");
  assert.equal(classifyVitalCsv(text).type, "blood_glucose");
  const parsed = parseBloodGlucoseCsv(text);
  assert.equal(parsed.headerRow, 4);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].glucose_mg_dl, 108);
  assert.equal(parsed.rows[0].measured_at, "2026-08-01T22:46:00.000Z");
});

test("imports separate OneTouch date and time columns after a preamble", () => {
  const text = [
    "OneTouch Reveal",
    "Generated for personal use",
    "Date,Time,Result,Units",
    "2026-08-01,07:30,6.1,mmol/L",
  ].join("\n");
  const parsed = parseBloodGlucoseCsv(text);
  assert.equal(parsed.headerRow, 3);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].glucose_mg_dl, 109.9);
});

test("accepts OneTouch Reading Date and Reading Time columns", () => {
  const text = [
    "Reading Date,Reading Time,Result,Units,Meal Tag,Notes",
    "07/29/2026,8:15 PM,112,mg/dL,After Meal,session context",
    "07/29/2026,8:45 PM,6.2,mmol/L,Before Meal,",
  ].join("\n");
  const parsed = parseBloodGlucoseCsv(text);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].glucose_mg_dl, 112);
  assert.equal(parsed.rows[1].glucose_mg_dl, 111.7);
  assert.equal(new Date(parsed.rows[0].measured_at).getHours(), 20);
});

test("accepts and filters a OneTouch mixed-event table", () => {
  const text = [
    "OneTouch Reveal Data Export",
    "Generated,07/29/2026",
    "Date and Time,Event Type,Value,Unit,Manually Entered,Meal Tag,Notes",
    "07/29/2026 8:15 PM,Blood Glucose,112,mg/dL,No,After Meal,session context",
    "07/29/2026 8:20 PM,Carbs,30,g,Yes,,dinner",
    "07/29/2026 8:45 PM,Glucose,6.2,mmol/L,No,Before Meal,",
  ].join("\n");
  assert.equal(classifyVitalCsv(text).type, "blood_glucose");
  const parsed = parseBloodGlucoseCsv(text);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].glucose_mg_dl, 112);
  assert.equal(parsed.rows[1].glucose_mg_dl, 111.7);
});

test("classifies body composition and converts pounds", () => {
  const text = "Date,Time,Weight (lb),Body Fat %,BMI\n2026-08-01,07:30,180,18.2,24.4";
  assert.equal(classifyVitalCsv(text).type, "body_composition");
  const parsed = parseBodyCompositionCsv(text);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].weight_kg, 81.65);
  assert.equal(parsed.rows[0].body_fat_percent, 18.2);
});
