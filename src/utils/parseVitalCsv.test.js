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

test("parses Android-hostile month-name timestamps and timezone labels", () => {
  const text = [
    "Date and Time,Glucose Reading (mg/dL)",
    '"Jul 29, 2026 8:15 PM EDT",112',
    '"29-Jul-2026 8:45 PM",104',
  ].join("\n");
  const parsed = parseBloodGlucoseCsv(text);
  assert.equal(parsed.rows.length, 2);
  assert.equal(new Date(parsed.rows[0].measured_at).getHours(), 20);
  assert.equal(parsed.rows[1].glucose_mg_dl, 104);
});

test("parses compact, epoch, and Excel serial device timestamps", () => {
  const epochSeconds = Math.floor(new Date(2026, 6, 29, 20, 15).getTime() / 1000);
  const text = [
    "Timestamp,Glucose",
    "20260729201500,112",
    `${epochSeconds},104`,
    "46232.84375,99",
  ].join("\n");
  const parsed = parseBloodGlucoseCsv(text);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows.map((row) => row.glucose_mg_dl), [112, 104, 99]);
});

test("repairs an unquoted comma in a month-name date column", () => {
  const text = [
    "Date,Time,Result,Units",
    "Jul 29, 2026,8:15 PM,112,mg/dL",
  ].join("\n");
  const parsed = parseBloodGlucoseCsv(text);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].glucose_mg_dl, 112);
  assert.equal(new Date(parsed.rows[0].measured_at).getHours(), 20);
});

test("does not mistake a Time Zone column for the device timestamp", () => {
  const text = [
    "Time Zone,Device Timestamp,Glucose Value,Glucose Units",
    "America/New_York,07/29/2026 8:15 PM,112,mg/dL",
    "EDT,07/29/2026 8:45 PM,104,mg/dL",
  ].join("\n");
  const parsed = parseBloodGlucoseCsv(text);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows.map((row) => row.glucose_mg_dl), [112, 104]);
  assert.equal(new Date(parsed.rows[0].measured_at).getHours(), 20);
});

test("does not mistake Timezone for a separate Reading Time column", () => {
  const text = [
    "Timezone,Reading Date,Reading Time,Result,Units",
    "-04:00,07/29/2026,8:15 PM,112,mg/dL",
  ].join("\n");
  const parsed = parseBloodGlucoseCsv(text);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].glucose_mg_dl, 112);
  assert.equal(new Date(parsed.rows[0].measured_at).getHours(), 20);
});

test("imports the photographed Item Type and Date and Time export", () => {
  const text = [
    "Item Type,Date and Time,Value,Recommended Range,Unit,Manual,Additional Notes,Data Source",
    'Blood Glucose,"Aug 1, 2026, 9:04 PM",90,,mg/dL,No,Before Meal,',
    'Blood Glucose,"Aug 1, 2026 at 8:41 PM",89,,mg/dL,No,Before Meal,',
    'Blood Glucose,"Jul 29, 2026, 6:46 PM",158,,mg/dL,No,Before Meal,',
  ].join("\n");
  assert.equal(classifyVitalCsv(text).type, "blood_glucose");
  const parsed = parseBloodGlucoseCsv(text);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows.map((row) => row.glucose_mg_dl), [90, 89, 158]);
  assert.equal(new Date(parsed.rows[0].measured_at).getHours(), 21);
});

test("classifies body composition and converts pounds", () => {
  const text = "Date,Time,Weight (lb),Body Fat %,BMI\n2026-08-01,07:30,180,18.2,24.4";
  assert.equal(classifyVitalCsv(text).type, "body_composition");
  const parsed = parseBodyCompositionCsv(text);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].weight_kg, 81.65);
  assert.equal(parsed.rows[0].body_fat_percent, 18.2);
});
