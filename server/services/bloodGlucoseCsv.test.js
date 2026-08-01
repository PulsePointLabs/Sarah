import test from "node:test";
import assert from "node:assert/strict";
import { parseBloodGlucoseCsv } from "../../src/utils/parseBloodGlucoseCsv.js";
import { readingsWithinRecord } from "../../src/utils/localRecordTime.js";

test("parseBloodGlucoseCsv accepts OneTouch Reveal-style columns in local time", () => {
  const csv = [
    "Reading Date,Reading Time,Result,Units,Meal Tag,Notes",
    "07/29/2026,8:15 PM,112,mg/dL,After Meal,session context",
    "07/29/2026,8:45 PM,6.2,mmol/L,Before Meal,",
  ].join("\n");
  const result = parseBloodGlucoseCsv(csv);

  assert.equal(result.error, undefined);
  assert.equal(result.imported, 2);
  assert.equal(result.rows[0].glucose_mg_dl, 112);
  assert.equal(result.rows[1].glucose_mg_dl, 112);
  assert.equal(new Date(result.rows[0].measured_at).getHours(), 20);
});

test("parseBloodGlucoseCsv accepts a OneTouch mixed-event export with preamble", () => {
  const csv = [
    "OneTouch Reveal Data Export",
    "Generated,07/29/2026",
    "",
    "Date and Time,Event Type,Value,Unit,Manually Entered,Meal Tag,Notes",
    "07/29/2026 8:15 PM,Blood Glucose,112,mg/dL,No,After Meal,session context",
    "07/29/2026 8:20 PM,Carbs,30,g,Yes,,dinner",
    "07/29/2026 8:45 PM,Glucose,6.2,mmol/L,No,Before Meal,",
  ].join("\n");
  const result = parseBloodGlucoseCsv(csv);

  assert.equal(result.error, undefined);
  assert.equal(result.imported, 2);
  assert.equal(result.rows[0].glucose_mg_dl, 112);
  assert.equal(result.rows[1].glucose_mg_dl, 112);
  assert.equal(result.rows[0].meal_tag, "After Meal");
});

test("parseBloodGlucoseCsv accepts OneTouch Date and Time wording", () => {
  const csv = [
    "Date and Time,Glucose Reading (mg/dL),Meal Tag",
    "07/29/2026 9:10 PM,104,After Meal",
  ].join("\n");
  const result = parseBloodGlucoseCsv(csv);

  assert.equal(result.error, undefined);
  assert.equal(result.imported, 1);
  assert.equal(result.rows[0].glucose_mg_dl, 104);
});

test("readingsWithinRecord includes only readings inside the local session window", () => {
  const readings = [
    { measured_at: new Date(2026, 6, 29, 20, 14).toISOString(), glucose_mg_dl: 100 },
    { measured_at: new Date(2026, 6, 29, 20, 20).toISOString(), glucose_mg_dl: 110 },
    { measured_at: new Date(2026, 6, 29, 20, 31).toISOString(), glucose_mg_dl: 120 },
  ];
  const matched = readingsWithinRecord(readings, {
    date: "2026-07-29",
    start_time: "20:15",
    end_time: "20:30",
  });

  assert.equal(matched.length, 1);
  assert.equal(matched[0].glucose_mg_dl, 110);
  assert.equal(matched[0].time_offset_s, 300);
});
