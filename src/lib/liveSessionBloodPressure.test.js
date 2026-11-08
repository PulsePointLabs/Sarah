import test from "node:test";
import assert from "node:assert/strict";
import {
  resetBloodPressureCaptureForSession,
  selectLiveSessionBloodPressure,
  selectTelemetryBloodPressure,
  correctOmronFutureDstReading,
  bloodPressureFallsInSession,
} from "./liveSessionBloodPressure.js";

const priorReading = { systolic_mm_hg: 132, diastolic_mm_hg: 86 };
const currentReading = { systolic_mm_hg: 124, diastolic_mm_hg: 80 };

test('measurement time determines session membership without pre/post padding or guesses from reception', () => {
  const startMs=Date.parse('2026-10-22T18:00:00Z'), endMs=startMs+60000;
  const window={startMs,endMs,sessionId:'new',pauses:[{pausedAt:new Date(startMs+20000).toISOString(),resumedAt:new Date(startMs+30000).toISOString()}]};
  const reading=offset=>({...currentReading,measured_at:new Date(startMs+offset).toISOString()});
  for (const offset of [-1,20000,25000,60001]) assert.equal(bloodPressureFallsInSession(reading(offset),window),false);
  for (const offset of [0,10000,30000,60000]) assert.equal(bloodPressureFallsInSession(reading(offset),window),true);
  assert.equal(bloodPressureFallsInSession({...reading(10000),timestamp_source:'received_at'},window),false);
  assert.equal(bloodPressureFallsInSession({...reading(10000),session:'old'},window),false);
  assert.equal(selectLiveSessionBloodPressure({activeSessionId:'new',captureState:{sessionId:'new',lastReading:reading(-1000)},window}),null);
});

test("full telemetry distinguishes a fresh cuff receipt, confirmed history, and a session attachment", () => {
  const receivedAt = "2026-11-08T15:05:00Z";
  const receipt = { ...currentReading, external_id: "cuff-new", measured_at: receivedAt, received_at: receivedAt };
  const old = { ...priorReading, external_id: "old", measured_at: "2026-11-08T15:00:00Z" };
  assert.equal(selectTelemetryBloodPressure({ receipt, stored: old }).state, "pending");
  assert.equal(selectTelemetryBloodPressure({ receipt, stored: receipt }).state, "history");
  assert.equal(selectTelemetryBloodPressure({ receipt, stored: receipt, sessionReading: receipt }).state, "session");
  assert.equal(selectTelemetryBloodPressure({ receipt: { ...receipt, measured_at: null }, stored: old }).state, "clock_unknown");
  assert.equal(selectTelemetryBloodPressure({ receipt, stored: old, openedAt: Date.parse(receivedAt) + 1 }).reading, old);
});

test("only a tightly bounded future cuff timestamp after the fall transition is corrected", () => {
  const reading = {
    ...currentReading, source_app: "OMRON", external_id: "omron-synthetic",
    timestamp_source: "cuff_clock", measured_at: "2026-11-06T15:12:15Z", received_at: "2026-11-06T14:12:22Z",
  };
  const corrected = correctOmronFutureDstReading(reading);
  assert.equal(corrected.measured_at, "2026-11-06T14:12:15.000Z");
  assert.equal(corrected.raw.cuff_measured_at, reading.measured_at);
  assert.equal(corrected.raw.clock_offset_ms, 3600000);
  assert.equal(corrected.external_id, reading.external_id);
  assert.equal(correctOmronFutureDstReading(corrected), corrected);
  for (const [zone, received_at, measured_at] of [
    ["America/New_York", "2026-10-29T14:12:22Z", "2026-10-29T15:12:15Z"],
    ["America/New_York", "2026-11-06T14:12:48Z", "2026-11-06T15:12:15Z"],
    ["America/Phoenix", "2026-11-06T14:12:22Z", "2026-11-06T15:12:15Z"],
  ]) {
    const input = { ...reading, received_at, measured_at };
    assert.equal(correctOmronFutureDstReading(input, zone), input);
  }
});

test("a new live session does not display the prior session blood pressure", () => {
  assert.equal(selectLiveSessionBloodPressure({
    activeSessionId: "session-new",
    activeSessionDoc: {
      id: "session-new",
    },
    captureState: {
      sessionId: "session-old",
      lastReading: priorReading,
    },
  }), null);
});

test("the active session displays only its own captured or persisted blood pressure", () => {
  assert.equal(selectLiveSessionBloodPressure({
    activeSessionId: "session-new",
    activeSessionDoc: { id: "session-new" },
    captureState: { sessionId: "session-new", lastReading: currentReading },
  }), currentReading);

  assert.equal(selectLiveSessionBloodPressure({
    activeSessionId: "session-new",
    activeSessionDoc: {
      id: "session-new",
      latest_blood_pressure_reading: currentReading,
    },
    captureState: { sessionId: null, lastReading: priorReading },
  }), currentReading);
});

test("an armed capture does not present an unassigned reading as session telemetry", () => {
  assert.equal(selectLiveSessionBloodPressure({
    activeSessionId: null,
    activeSessionDoc: null,
    captureState: { sessionId: null, lastReading: currentReading },
  }), null);

  assert.equal(selectLiveSessionBloodPressure({
    activeSessionId: null,
    activeSessionDoc: null,
    captureState: { sessionId: null, lastReading: null },
  }), null);
});

test("starting a different session clears session-specific blood pressure state", () => {
  const reset = resetBloodPressureCaptureForSession({
    status: "captured",
    sessionId: "session-old",
    lastReading: priorReading,
    capturedCount: 2,
  }, "session-new");

  assert.equal(reset.sessionId, "session-new");
  assert.equal(reset.lastReading, null);
  assert.equal(reset.capturedCount, 0);
  assert.equal(reset.status, "idle");
});
