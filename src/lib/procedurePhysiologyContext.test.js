import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProcedurePhysiologyContext,
  isProcedurePhysiologyRecord,
  selectProcedureMilestones,
} from "./procedurePhysiologyContext.js";

test("recognizes procedure records and keeps timed insertion milestones", () => {
  const record = {
    id: "exploration-1",
    title: "Urethral sounding",
    event_timeline: [
      { time_s: 30, note: "Sound contacts the meatus." },
      { time_s: 60, note: "Sound advances through the bulbar urethra." },
    ],
  };
  assert.equal(isProcedurePhysiologyRecord(record), true);
  assert.deepEqual(selectProcedureMilestones(record).map((event) => event.time_s), [30, 60]);
});

test("aligns usable HRV and HR windows without treating unavailable zero HRV as evidence", () => {
  const record = {
    id: "exploration-1",
    date: "2026-07-22",
    title: "Fleet enema",
    event_timeline: [{ time_s: 30, note: "Enema tip fully inserted." }],
  };
  const rows = Array.from({ length: 61 }, (_, time) => ({
    session: record.id,
    time_offset_s: time,
    hr: time < 30 ? 90 : 96,
    hrv_rmssd_ms: time < 30 ? 20 : 28,
    hrv_sdnn_ms: time < 30 ? 35 : 42,
    hrv_quality: "high",
  }));
  rows[30] = {
    ...rows[30],
    hr: 0,
    hrv_rmssd_ms: 0,
    hrv_sdnn_ms: 0,
    hrv_quality: "unavailable",
  };

  const result = buildProcedurePhysiologyContext([record], { [record.id]: rows });
  assert.equal(result.recordCount, 1);
  assert.equal(result.milestoneCount, 1);
  assert.match(result.context, /Enema tip fully inserted/);
  assert.match(result.context, /immediate HR 4\.6 bpm, post HR 6 bpm/);
  assert.doesNotMatch(result.context, /RMSSD 0 ms/);
  assert.match(result.context, /descriptive, not proof/i);
});

test("prefers enema-specific milestones and emits self-enema guidance", () => {
  const record = {
    id: "exploration-2",
    date: "2026-07-23",
    title: "Self enema routine",
    notes: "Rectal prep before retention and return.",
    event_timeline: [
      { time_s: 10, note: "Towel and lubricant setup." },
      { time_s: 22, note: "Nozzle contact at the anus." },
      { time_s: 34, note: "Nozzle fully inserted." },
      { time_s: 61, note: "Instillation begins with mild cramping." },
      { time_s: 118, note: "Strong urge to hold and retain." },
      { time_s: 181, note: "Fluid return and expulsion begin." },
    ],
  };
  const milestones = selectProcedureMilestones(record, 4).map((event) => event.note);
  assert.deepEqual(milestones, [
    "Nozzle contact at the anus.",
    "Nozzle fully inserted.",
    "Instillation begins with mild cramping.",
    "Strong urge to hold and retain.",
  ]);

  const rows = Array.from({ length: 220 }, (_, time) => ({
    session: record.id,
    time_offset_s: time,
    hr: time < 34 ? 84 : time < 118 ? 90 : 95,
    hrv_rmssd_ms: time < 34 ? 24 : time < 118 ? 18 : 14,
    hrv_sdnn_ms: time < 34 ? 40 : time < 118 ? 33 : 28,
    hrv_quality: "high",
  }));

  const result = buildProcedurePhysiologyContext([record], { [record.id]: rows }, { milestoneLimit: 4 });
  assert.match(result.context, /self-enema \/ rectal procedure/i);
  assert.match(result.context, /visible or manually logged instillation/i);
  assert.match(result.context, /Nozzle fully inserted/i);
  assert.match(result.context, /Strong urge to hold and retain/i);
  assert.match(result.context, /Do not invent internal pressure, retained volume, flow rate, or symptom relief/i);
});
